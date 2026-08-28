import { dirname } from "node:path";
import picomatch from "picomatch";
import { isAlias, isCollection, isPair, parseDocument } from "yaml";
import type { ParseResult, SkillDescriptor, SkillDiagnostic, SkillMetadata, SkillSource } from "./types.ts";

export const MAX_FRONTMATTER_BYTES = 64 * 1024;

const MAX_YAML_DEPTH = 24;
const MAX_COLLECTION_ITEMS = 256;
const MAX_YAML_NODES = 2_048;
const MAX_DESCRIPTION_LENGTH = 1_024;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

interface FrontmatterParts {
	frontmatter: string;
	body: string;
}

interface YamlInspectionState {
	nodes: number;
}

function diagnostic(
	source: SkillSource,
	code: SkillDiagnostic["code"],
	severity: SkillDiagnostic["severity"],
	message: string,
): SkillDiagnostic {
	return {
		code,
		severity,
		message,
		path: source.displayPath,
	};
}

function splitFrontmatter(raw: string): FrontmatterParts | string {
	const firstNewline = raw.indexOf("\n");
	if (firstNewline < 0) {
		return "SKILL.md must begin with YAML frontmatter delimited by --- lines";
	}

	const firstLine = raw.slice(0, firstNewline).replace(/\r$/, "");
	if (firstLine !== "---") {
		return "SKILL.md must begin with YAML frontmatter; Markdown headings are not metadata";
	}

	const contentStart = firstNewline + 1;
	let lineStart = contentStart;
	let frontmatterBytes = 0;
	while (lineStart <= raw.length) {
		const newline = raw.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? raw.length : newline;
		const line = raw.slice(lineStart, lineEnd).replace(/\r$/, "");

		if (/^---[\t ]*$/.test(line)) {
			const frontmatter = raw.slice(contentStart, lineStart);
			return {
				frontmatter,
				body: newline < 0 ? "" : raw.slice(newline + 1),
			};
		}

		frontmatterBytes += Buffer.byteLength(raw.slice(lineStart, newline < 0 ? lineEnd : newline + 1), "utf8");
		if (frontmatterBytes > MAX_FRONTMATTER_BYTES) {
			return `YAML frontmatter exceeds the ${MAX_FRONTMATTER_BYTES}-byte limit`;
		}
		if (newline < 0) {
			break;
		}
		lineStart = newline + 1;
	}

	return "YAML frontmatter is missing its closing --- delimiter";
}

function inspectYaml(value: unknown, depth: number, state: YamlInspectionState): void {
	if (depth > MAX_YAML_DEPTH) {
		throw new Error(`YAML nesting exceeds the depth limit of ${MAX_YAML_DEPTH}`);
	}
	state.nodes += 1;
	if (state.nodes > MAX_YAML_NODES) {
		throw new Error(`YAML content exceeds the node limit of ${MAX_YAML_NODES}`);
	}
	if (isAlias(value)) {
		throw new Error("YAML aliases are not supported in skill metadata");
	}
	if (isPair(value)) {
		inspectYaml(value.key, depth + 1, state);
		inspectYaml(value.value, depth + 1, state);
		return;
	}
	if (isCollection(value)) {
		if (value.items.length > MAX_COLLECTION_ITEMS) {
			throw new Error(`YAML collection exceeds the item limit of ${MAX_COLLECTION_ITEMS}`);
		}
		for (const item of value.items) {
			inspectYaml(item, depth + 1, state);
		}
	}
}

function defineRecordValue(record: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(record, key, {
		configurable: false,
		enumerable: true,
		writable: false,
		value,
	});
}

function normalizedExtraValue(value: unknown): unknown {
	if (value instanceof Map) {
		const record: Record<string, unknown> = {};
		for (const [key, child] of value) {
			if (typeof key === "string") {
				defineRecordValue(record, key, normalizedExtraValue(child));
			}
		}
		return Object.freeze(record);
	}
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => normalizedExtraValue(item)));
	}
	return value;
}

function warning(diagnostics: SkillDiagnostic[], source: SkillSource, message: string): void {
	diagnostics.push(diagnostic(source, "invalid_metadata", "warning", message));
}

function normalizeStringArray(
	value: unknown,
	field: string,
	diagnostics: SkillDiagnostic[],
	source: SkillSource,
): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		warning(diagnostics, source, `${field} must be an array of non-empty strings; ignoring it`);
		return [];
	}

	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0) {
			warning(diagnostics, source, `${field} contains a non-string or empty item; ignoring that item`);
			continue;
		}
		result.push(item.trim());
	}
	return result;
}

function normalizeFileGlobs(value: unknown, diagnostics: SkillDiagnostic[], source: SkillSource): string[] {
	const candidates = normalizeStringArray(value, "metadata.file-globs", diagnostics, source);
	return candidates.filter((pattern) => {
		try {
			picomatch(pattern, { strictBrackets: true });
			return true;
		} catch {
			warning(diagnostics, source, `metadata.file-globs contains an invalid pattern (${pattern}); ignoring it`);
			return false;
		}
	});
}

function optionalString(
	value: unknown,
	field: string,
	diagnostics: SkillDiagnostic[],
	source: SkillSource,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		warning(diagnostics, source, `${field} must be a string; ignoring it`);
		return undefined;
	}
	return value;
}

function normalizeMetadata(
	frontmatter: Map<unknown, unknown>,
	source: SkillSource,
	diagnostics: SkillDiagnostic[],
): SkillMetadata | undefined {
	const nameValue = frontmatter.get("name");
	const descriptionValue = frontmatter.get("description");
	let requiredFieldsValid = true;

	if (typeof nameValue !== "string" || !SKILL_NAME_PATTERN.test(nameValue) || nameValue.includes("--")) {
		diagnostics.push(
			diagnostic(
				source,
				"invalid_metadata",
				"error",
				"name is required and must be 1-64 lowercase letters, digits, or single hyphens",
			),
		);
		requiredFieldsValid = false;
	}

	if (
		typeof descriptionValue !== "string" ||
		descriptionValue.trim().length === 0 ||
		descriptionValue.length > MAX_DESCRIPTION_LENGTH
	) {
		diagnostics.push(
			diagnostic(
				source,
				"invalid_metadata",
				"error",
				`description is required, must be non-empty, and must not exceed ${MAX_DESCRIPTION_LENGTH} characters`,
			),
		);
		requiredFieldsValid = false;
	}

	if (!requiredFieldsValid || typeof nameValue !== "string" || typeof descriptionValue !== "string") {
		return undefined;
	}

	const metadataValue = frontmatter.get("metadata");
	let metadataMap: Map<unknown, unknown> | undefined;
	if (metadataValue !== undefined) {
		if (metadataValue instanceof Map) {
			metadataMap = metadataValue;
		} else {
			warning(diagnostics, source, "metadata must be a mapping; ignoring it");
		}
	}

	const keywords = normalizeStringArray(metadataMap?.get("keywords"), "metadata.keywords", diagnostics, source);
	const fileGlobs = normalizeFileGlobs(metadataMap?.get("file-globs"), diagnostics, source);

	const allowedToolsValue = frontmatter.get("allowed-tools");
	let allowedTools: string[] = [];
	if (typeof allowedToolsValue === "string") {
		allowedTools = allowedToolsValue.split(/\s+/).filter((item) => item.length > 0);
	} else if (allowedToolsValue !== undefined) {
		allowedTools = normalizeStringArray(allowedToolsValue, "allowed-tools", diagnostics, source);
	}

	const disableValue = frontmatter.get("disable-model-invocation");
	if (disableValue !== undefined && typeof disableValue !== "boolean") {
		warning(
			diagnostics,
			source,
			"disable-model-invocation must be a boolean; only literal true disables automatic invocation",
		);
	}

	const extra: Record<string, unknown> = {};
	const knownTopLevel = new Set([
		"name",
		"description",
		"license",
		"compatibility",
		"metadata",
		"allowed-tools",
		"disable-model-invocation",
	]);
	for (const [key, value] of frontmatter) {
		if (typeof key === "string" && !knownTopLevel.has(key)) {
			defineRecordValue(extra, key, normalizedExtraValue(value));
		}
	}

	if (metadataMap) {
		const metadataExtra: Record<string, unknown> = {};
		for (const [key, value] of metadataMap) {
			if (typeof key === "string" && key !== "keywords" && key !== "file-globs") {
				defineRecordValue(metadataExtra, key, normalizedExtraValue(value));
			}
		}
		if (Object.keys(metadataExtra).length > 0) {
			defineRecordValue(extra, "metadata", Object.freeze(metadataExtra));
		}
	}

	return {
		name: nameValue,
		description: descriptionValue.trim(),
		license: optionalString(frontmatter.get("license"), "license", diagnostics, source),
		compatibility: optionalString(frontmatter.get("compatibility"), "compatibility", diagnostics, source),
		keywords,
		fileGlobs,
		allowedTools,
		disableModelInvocation: disableValue === true,
		extra: Object.freeze(extra),
	};
}

export function parseSkill(raw: string, source: SkillSource): ParseResult {
	const diagnostics: SkillDiagnostic[] = [];
	const parts = splitFrontmatter(raw);
	if (typeof parts === "string") {
		return {
			diagnostics: Object.freeze([diagnostic(source, "invalid_frontmatter", "error", parts)]),
		};
	}

	try {
		const document = parseDocument(parts.frontmatter, {
			prettyErrors: false,
			strict: true,
			uniqueKeys: true,
		});
		if (document.errors.length > 0) {
			return {
				diagnostics: Object.freeze([
					diagnostic(
						source,
						"invalid_frontmatter",
						"error",
						`Invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`,
					),
				]),
			};
		}

		inspectYaml(document.contents, 0, { nodes: 0 });
		const value: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
		if (!(value instanceof Map)) {
			return {
				diagnostics: Object.freeze([
					diagnostic(source, "invalid_frontmatter", "error", "YAML frontmatter must be a mapping"),
				]),
			};
		}

		for (const yamlWarning of document.warnings) {
			diagnostics.push(diagnostic(source, "invalid_frontmatter", "warning", `YAML warning: ${yamlWarning.message}`));
		}
		const metadata = normalizeMetadata(value, source, diagnostics);
		const frozenDiagnostics = Object.freeze(diagnostics.slice());
		if (!metadata) {
			return { diagnostics: frozenDiagnostics };
		}

		const descriptor: SkillDescriptor = {
			metadata,
			source,
			baseDir: dirname(source.canonicalPath),
			skillPath: source.canonicalPath,
			canonicalBaseDir: dirname(source.canonicalPath),
			canonicalSkillPath: source.canonicalPath,
			body: parts.body,
			diagnostics: frozenDiagnostics,
		};
		return { descriptor, diagnostics: frozenDiagnostics };
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown parser error";
		return {
			diagnostics: Object.freeze([
				diagnostic(source, "invalid_frontmatter", "error", `Unsafe or invalid YAML frontmatter: ${message}`),
			]),
		};
	}
}
