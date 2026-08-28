import type { Dirent, Stats } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import picomatch from "picomatch";
import { MAX_FRONTMATTER_BYTES, parseSkill } from "./parse.ts";
import type {
	DiscoverOptions,
	DiscoverResult,
	SkillDescriptor,
	SkillDiagnostic,
	SkillFs,
	SkillScope,
	SkillSource,
	SkillSourceKind,
} from "./types.ts";

const IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"] as const;
const SKILL_FILENAME = "SKILL.md";
const MAX_SKILL_PREFIX_BYTES = MAX_FRONTMATTER_BYTES + 1_024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 1_024;
const MAX_MANIFEST_WALK_ENTRIES = 50_000;
const MAX_MANIFEST_PATTERN_BYTES = 4_096;
const MAX_DISCOVERY_DEPTH = 64;
const MAX_IGNORE_FILE_BYTES = 256 * 1024;

interface IgnoreRule {
	matchers: readonly ((path: string) => boolean)[];
	negated: boolean;
}

interface DiscoveryContext {
	fs: SkillFs;
	cwd: string;
	rootDir: string;
	canonicalRoot: string;
	scope: SkillScope;
	kind: SkillSourceKind;
	manifestPath?: string;
	skills: SkillDescriptor[];
	diagnostics: SkillDiagnostic[];
	seenCanonicalPaths: Map<string, SkillDescriptor>;
}

interface ManifestInventoryEntry {
	absolutePath: string;
	relativePath: string;
	isDirectory: boolean;
	isFile: boolean;
}

const nodeFs: SkillFs = {
	readFile: async (path, encoding) => await readFile(path, encoding),
	readFilePrefix: async (path, maxBytes) => {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	},
	readdir: async (path) => (await readdir(path, { withFileTypes: true })) as Dirent[],
	lstat: async (path) => (await lstat(path)) as Stats,
	stat: async (path) => (await stat(path)) as Stats,
	realpath,
};

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function isContained(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "unknown filesystem error";
}

function isMissingError(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

function addDiagnostic(
	diagnostics: SkillDiagnostic[],
	code: SkillDiagnostic["code"],
	severity: SkillDiagnostic["severity"],
	message: string,
	path?: string,
	skillName?: string,
): void {
	diagnostics.push({ code, severity, message, path, skillName });
}

function displayPath(path: string, context: Pick<DiscoveryContext, "cwd" | "kind" | "rootDir" | "scope">): string {
	const absolutePath = resolve(path);
	const absoluteCwd = resolve(context.cwd);
	if (isContained(absoluteCwd, absolutePath)) {
		const fromCwd = toPosixPath(relative(absoluteCwd, absolutePath));
		return fromCwd.length === 0 ? "." : fromCwd;
	}
	const home = resolve(homedir());
	if (isContained(home, absolutePath)) {
		const fromHome = toPosixPath(relative(home, absolutePath));
		return fromHome.length === 0 ? "~" : `~/${fromHome}`;
	}
	if (context.scope === "user" && isContained(resolve(context.rootDir), absolutePath)) {
		const fromRoot = toPosixPath(relative(resolve(context.rootDir), absolutePath));
		const prefix = context.kind === "conventional" ? "$PILLOW_HOME/skills" : "$PILLOW_HOME";
		return fromRoot.length === 0 ? prefix : `${prefix}/${fromRoot}`;
	}
	return absolutePath;
}

async function readPrefix(fs: SkillFs, path: string, maxBytes: number): Promise<string> {
	if (!fs.readFilePrefix) {
		throw new Error("Skill filesystem adapter must implement bounded readFilePrefix");
	}
	const value = await fs.readFilePrefix(path, maxBytes);
	if (Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`Skill filesystem adapter exceeded the ${maxBytes}-byte prefix limit`);
	}
	return value;
}

async function readBoundedText(fs: SkillFs, path: string, maxBytes: number): Promise<string> {
	if (!fs.readFilePrefix) {
		throw new Error("Skill filesystem adapter must implement bounded readFilePrefix");
	}
	const value = await fs.readFilePrefix(path, maxBytes + 1);
	if (Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`Skill filesystem adapter exceeded the ${maxBytes}-byte limit`);
	}
	return value;
}

async function loadSkillCandidate(skillPath: string, context: DiscoveryContext): Promise<void> {
	let canonicalPath: string;
	let fileStat: Awaited<ReturnType<SkillFs["stat"]>>;
	try {
		canonicalPath = await context.fs.realpath(skillPath);
		fileStat = await context.fs.stat(skillPath);
	} catch (error) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			`Unable to inspect skill path: ${errorMessage(error)}`,
			skillPath,
		);
		return;
	}

	if (!isContained(context.canonicalRoot, canonicalPath)) {
		addDiagnostic(
			context.diagnostics,
			context.kind === "manifest" ? "manifest_escape" : "path_unreadable",
			"warning",
			`Skill path resolves outside its ${context.kind === "manifest" ? "manifest" : "discovery"} root`,
			skillPath,
		);
		return;
	}
	if (!fileStat.isFile()) {
		addDiagnostic(
			context.diagnostics,
			context.kind === "manifest" ? "manifest_invalid" : "path_unreadable",
			"warning",
			"Skill candidate is not a regular file",
			skillPath,
		);
		return;
	}

	const existing = context.seenCanonicalPaths.get(canonicalPath);
	if (existing) {
		addDiagnostic(
			context.diagnostics,
			"duplicate_path",
			"info",
			`Skill path duplicates ${existing.source.displayPath}`,
			displayPath(skillPath, context),
			existing.metadata.name,
		);
		return;
	}

	const source: SkillSource = {
		scope: context.scope,
		kind: context.kind,
		rootDir: context.rootDir,
		displayPath: displayPath(skillPath, context),
		canonicalPath,
		...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
	};
	let rawPrefix: string;
	try {
		rawPrefix = await readPrefix(context.fs, canonicalPath, MAX_SKILL_PREFIX_BYTES);
	} catch (error) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			`Unable to read skill metadata: ${errorMessage(error)}`,
			source.displayPath,
		);
		return;
	}

	const parsed = parseSkill(rawPrefix, source);
	context.diagnostics.push(...parsed.diagnostics);
	if (!parsed.descriptor) {
		return;
	}

	const descriptor: SkillDescriptor = {
		metadata: parsed.descriptor.metadata,
		source,
		baseDir: dirname(canonicalPath),
		skillPath: canonicalPath,
		canonicalBaseDir: dirname(canonicalPath),
		canonicalSkillPath: canonicalPath,
		statFingerprint: { mtimeMs: fileStat.mtimeMs, size: fileStat.size },
		diagnostics: parsed.descriptor.diagnostics,
	};
	context.seenCanonicalPaths.set(canonicalPath, descriptor);
	context.skills.push(descriptor);
}

function compileIgnoreRule(lineValue: string, relativeDirectory: string): IgnoreRule | undefined {
	let line = lineValue.replace(/\r$/, "");
	if (line.trim().length === 0 || (line.startsWith("#") && !line.startsWith("\\#"))) {
		return undefined;
	}
	if (line.startsWith("\\#")) {
		line = line.slice(1);
	}

	let negated = false;
	if (line.startsWith("!") && !line.startsWith("\\!")) {
		negated = true;
		line = line.slice(1);
	} else if (line.startsWith("\\!")) {
		line = line.slice(1);
	}
	line = line.trim();
	if (line.length === 0) {
		return undefined;
	}

	const directoryOnly = line.endsWith("/");
	if (directoryOnly) {
		line = line.slice(0, -1);
	}
	const anchored = line.startsWith("/");
	if (anchored) {
		line = line.slice(1);
	}
	const base = relativeDirectory.length > 0 ? `${relativeDirectory}/` : "";
	const hasSlash = line.includes("/");
	const pattern = anchored || hasSlash ? `${base}${line}` : `${base}**/${line}`;
	const patterns = directoryOnly ? [pattern, `${pattern}/**`] : [pattern];

	try {
		return {
			matchers: patterns.map((item) => picomatch(item, { dot: true })),
			negated,
		};
	} catch {
		return undefined;
	}
}

async function rulesForDirectory(
	directory: string,
	root: string,
	parentRules: readonly IgnoreRule[],
	context: DiscoveryContext,
): Promise<readonly IgnoreRule[]> {
	const rules = parentRules.slice();
	const relativeDirectory = toPosixPath(relative(root, directory));
	for (const filename of IGNORE_FILES) {
		const ignorePath = join(directory, filename);
		let content: string;
		try {
			content = await readBoundedText(context.fs, ignorePath, MAX_IGNORE_FILE_BYTES);
		} catch (error) {
			if (!isMissingError(error)) {
				addDiagnostic(
					context.diagnostics,
					"path_unreadable",
					"warning",
					`Unable to read ignore file: ${errorMessage(error)}`,
					ignorePath,
				);
			}
			continue;
		}
		for (const line of content.split("\n")) {
			const rule = compileIgnoreRule(line, relativeDirectory);
			if (rule) {
				rules.push(rule);
			}
		}
	}
	return rules;
}

function isIgnored(path: string, rules: readonly IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.matchers.some((matcher) => matcher(path))) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

async function scanConventionalDirectory(
	directory: string,
	rules: readonly IgnoreRule[],
	activeCanonicalDirectories: Set<string>,
	depth: number,
	context: DiscoveryContext,
): Promise<void> {
	if (depth > MAX_DISCOVERY_DEPTH) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			`Discovery depth exceeds the limit of ${MAX_DISCOVERY_DEPTH}`,
			directory,
		);
		return;
	}

	let canonicalDirectory: string;
	try {
		canonicalDirectory = await context.fs.realpath(directory);
	} catch (error) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			`Unable to resolve directory: ${errorMessage(error)}`,
			directory,
		);
		return;
	}
	if (!isContained(context.canonicalRoot, canonicalDirectory)) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			"Directory symlink resolves outside the discovery root",
			directory,
		);
		return;
	}
	if (activeCanonicalDirectories.has(canonicalDirectory)) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			"Directory symlink creates a discovery cycle",
			directory,
		);
		return;
	}

	activeCanonicalDirectories.add(canonicalDirectory);
	try {
		const directoryRules = await rulesForDirectory(directory, context.rootDir, rules, context);
		let entries: readonly Awaited<ReturnType<SkillFs["readdir"]>>[number][];
		try {
			entries = (await context.fs.readdir(directory))
				.slice()
				.sort((left, right) => compareStrings(left.name, right.name));
		} catch (error) {
			addDiagnostic(
				context.diagnostics,
				"path_unreadable",
				"warning",
				`Unable to read directory: ${errorMessage(error)}`,
				directory,
			);
			return;
		}

		const skillEntry = entries.find((entry) => entry.name === SKILL_FILENAME);
		if (skillEntry) {
			const skillPath = join(directory, skillEntry.name);
			const relativeSkillPath = toPosixPath(relative(context.rootDir, skillPath));
			if (!isIgnored(relativeSkillPath, directoryRules)) {
				await loadSkillCandidate(skillPath, context);
				return;
			}
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") {
				continue;
			}
			const childPath = join(directory, entry.name);
			const relativeChildPath = toPosixPath(relative(context.rootDir, childPath));
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDirectory = (await context.fs.stat(childPath)).isDirectory();
				} catch (error) {
					addDiagnostic(
						context.diagnostics,
						"path_unreadable",
						"warning",
						`Unable to follow directory symlink: ${errorMessage(error)}`,
						childPath,
					);
					continue;
				}
			}
			if (!isDirectory || isIgnored(relativeChildPath, directoryRules)) {
				continue;
			}
			await scanConventionalDirectory(childPath, directoryRules, activeCanonicalDirectories, depth + 1, context);
		}
	} finally {
		activeCanonicalDirectories.delete(canonicalDirectory);
	}
}

async function scanConventionalRoot(
	rootDir: string,
	scope: SkillScope,
	fs: SkillFs,
	cwd: string,
): Promise<DiscoverResult> {
	const skills: SkillDescriptor[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	let canonicalRoot: string;
	try {
		const rootStat = await fs.stat(rootDir);
		if (!rootStat.isDirectory()) {
			addDiagnostic(diagnostics, "path_unreadable", "warning", "Skills root is not a directory", rootDir);
			return { skills, diagnostics };
		}
		canonicalRoot = await fs.realpath(rootDir);
	} catch (error) {
		if (!isMissingError(error)) {
			addDiagnostic(
				diagnostics,
				"path_unreadable",
				"warning",
				`Unable to inspect skills root: ${errorMessage(error)}`,
				rootDir,
			);
		}
		return { skills, diagnostics };
	}

	const context: DiscoveryContext = {
		fs,
		cwd,
		rootDir,
		canonicalRoot,
		scope,
		kind: "conventional",
		skills,
		diagnostics,
		seenCanonicalPaths: new Map(),
	};
	await scanConventionalDirectory(rootDir, [], new Set(), 0, context);
	return { skills, diagnostics };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifestEntries(value: unknown): readonly string[] | undefined {
	if (!isJsonRecord(value) || !Array.isArray(value.skills) || value.skills.length > MAX_MANIFEST_ENTRIES) {
		return undefined;
	}
	if (!value.skills.every((entry) => typeof entry === "string" && entry.length > 0)) {
		return undefined;
	}
	return value.skills;
}

function lexicalManifestTarget(rootDir: string, entry: string): string | undefined {
	if (
		entry.includes("\0") ||
		isAbsolute(entry) ||
		win32.isAbsolute(entry) ||
		entry.replaceAll("\\", "/").split("/").includes("..")
	) {
		return undefined;
	}
	const target = resolve(rootDir, entry);
	return isContained(rootDir, target) ? target : undefined;
}

function normalizeManifestPattern(entry: string): string {
	return entry.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function manifestInventory(
	rootDir: string,
	canonicalRoot: string,
	fs: SkillFs,
	diagnostics: SkillDiagnostic[],
): Promise<readonly ManifestInventoryEntry[]> {
	const inventory: ManifestInventoryEntry[] = [];
	let limitReached = false;

	async function walk(directory: string, activeCanonicalDirectories: Set<string>, depth: number): Promise<void> {
		if (limitReached) {
			return;
		}
		if (depth > MAX_DISCOVERY_DEPTH) {
			addDiagnostic(
				diagnostics,
				"manifest_invalid",
				"warning",
				`Manifest glob depth exceeds the limit of ${MAX_DISCOVERY_DEPTH}`,
				directory,
			);
			return;
		}
		let canonicalDirectory: string;
		try {
			canonicalDirectory = await fs.realpath(directory);
		} catch (error) {
			addDiagnostic(
				diagnostics,
				"path_unreadable",
				"warning",
				`Unable to resolve manifest directory: ${errorMessage(error)}`,
				directory,
			);
			return;
		}
		if (!isContained(canonicalRoot, canonicalDirectory)) {
			addDiagnostic(
				diagnostics,
				"manifest_escape",
				"warning",
				"Manifest glob encountered a directory symlink outside its root",
				directory,
			);
			return;
		}
		if (activeCanonicalDirectories.has(canonicalDirectory)) {
			return;
		}
		activeCanonicalDirectories.add(canonicalDirectory);
		try {
			let entries: readonly Awaited<ReturnType<SkillFs["readdir"]>>[number][];
			try {
				entries = (await fs.readdir(directory))
					.slice()
					.sort((left, right) => compareStrings(left.name, right.name));
			} catch (error) {
				addDiagnostic(
					diagnostics,
					"path_unreadable",
					"warning",
					`Unable to expand manifest glob: ${errorMessage(error)}`,
					directory,
				);
				return;
			}

			for (const entry of entries) {
				if (inventory.length >= MAX_MANIFEST_WALK_ENTRIES) {
					limitReached = true;
					addDiagnostic(
						diagnostics,
						"manifest_invalid",
						"warning",
						`Manifest glob expansion exceeds ${MAX_MANIFEST_WALK_ENTRIES} filesystem entries`,
						rootDir,
					);
					return;
				}
				const absolutePath = join(directory, entry.name);
				let entryStat: Awaited<ReturnType<SkillFs["stat"]>>;
				let canonicalPath: string;
				try {
					entryStat = entry.isSymbolicLink() ? await fs.stat(absolutePath) : await fs.lstat(absolutePath);
					canonicalPath = await fs.realpath(absolutePath);
				} catch (error) {
					addDiagnostic(
						diagnostics,
						"path_unreadable",
						"warning",
						`Unable to inspect manifest glob target: ${errorMessage(error)}`,
						absolutePath,
					);
					continue;
				}
				if (!isContained(canonicalRoot, canonicalPath)) {
					addDiagnostic(
						diagnostics,
						"manifest_escape",
						"warning",
						"Manifest glob target resolves outside its root",
						absolutePath,
					);
					continue;
				}

				inventory.push({
					absolutePath,
					relativePath: toPosixPath(relative(rootDir, absolutePath)),
					isDirectory: entryStat.isDirectory(),
					isFile: entryStat.isFile(),
				});
				if (entryStat.isDirectory()) {
					await walk(absolutePath, activeCanonicalDirectories, depth + 1);
				}
			}
		} finally {
			activeCanonicalDirectories.delete(canonicalDirectory);
		}
	}

	await walk(rootDir, new Set(), 0);
	return inventory;
}

async function processManifestCandidate(path: string, context: DiscoveryContext): Promise<void> {
	let targetStat: Awaited<ReturnType<SkillFs["stat"]>>;
	let canonicalTarget: string;
	try {
		targetStat = await context.fs.stat(path);
		canonicalTarget = await context.fs.realpath(path);
	} catch (error) {
		addDiagnostic(
			context.diagnostics,
			"path_unreadable",
			"warning",
			`Unable to inspect manifest target: ${errorMessage(error)}`,
			path,
		);
		return;
	}
	if (!isContained(context.canonicalRoot, canonicalTarget)) {
		addDiagnostic(
			context.diagnostics,
			"manifest_escape",
			"warning",
			"Manifest target resolves outside its directory tree",
			path,
		);
		return;
	}

	if (targetStat.isDirectory()) {
		await loadSkillCandidate(join(path, SKILL_FILENAME), context);
		return;
	}
	if (targetStat.isFile() && basename(path) === SKILL_FILENAME) {
		await loadSkillCandidate(path, context);
		return;
	}
	addDiagnostic(
		context.diagnostics,
		"manifest_invalid",
		"warning",
		"Manifest targets must be skill directories or files named exactly SKILL.md",
		path,
	);
}

async function scanManifest(
	manifestPath: string,
	scope: SkillScope,
	fs: SkillFs,
	cwd: string,
): Promise<DiscoverResult> {
	const skills: SkillDescriptor[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	let manifestRaw: string;
	try {
		manifestRaw = await readPrefix(fs, manifestPath, MAX_MANIFEST_BYTES + 1);
	} catch (error) {
		if (!isMissingError(error)) {
			addDiagnostic(
				diagnostics,
				"path_unreadable",
				"warning",
				`Unable to read skills manifest: ${errorMessage(error)}`,
				manifestPath,
			);
		}
		return { skills, diagnostics };
	}
	if (Buffer.byteLength(manifestRaw, "utf8") > MAX_MANIFEST_BYTES) {
		addDiagnostic(
			diagnostics,
			"manifest_invalid",
			"error",
			`Skills manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit`,
			manifestPath,
		);
		return { skills, diagnostics };
	}

	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(manifestRaw) as unknown;
	} catch (error) {
		addDiagnostic(
			diagnostics,
			"manifest_invalid",
			"error",
			`Invalid skills manifest JSON: ${errorMessage(error)}`,
			manifestPath,
		);
		return { skills, diagnostics };
	}
	const entries = validateManifestEntries(manifestValue);
	if (!entries) {
		addDiagnostic(
			diagnostics,
			"manifest_invalid",
			"error",
			`Skills manifest must contain a skills string array with at most ${MAX_MANIFEST_ENTRIES} entries`,
			manifestPath,
		);
		return { skills, diagnostics };
	}

	const rootDir = dirname(resolve(manifestPath));
	let canonicalRoot: string;
	try {
		canonicalRoot = await fs.realpath(rootDir);
	} catch (error) {
		addDiagnostic(
			diagnostics,
			"path_unreadable",
			"warning",
			`Unable to resolve manifest directory: ${errorMessage(error)}`,
			rootDir,
		);
		return { skills, diagnostics };
	}
	const context: DiscoveryContext = {
		fs,
		cwd,
		rootDir,
		canonicalRoot,
		scope,
		kind: "manifest",
		manifestPath,
		skills,
		diagnostics,
		seenCanonicalPaths: new Map(),
	};
	let inventory: readonly ManifestInventoryEntry[] | undefined;

	for (const entry of entries) {
		if (Buffer.byteLength(entry, "utf8") > MAX_MANIFEST_PATTERN_BYTES) {
			addDiagnostic(
				diagnostics,
				"manifest_invalid",
				"warning",
				`Manifest entry exceeds the ${MAX_MANIFEST_PATTERN_BYTES}-byte limit`,
				manifestPath,
			);
			continue;
		}
		const target = lexicalManifestTarget(rootDir, entry);
		if (!target) {
			addDiagnostic(
				diagnostics,
				"manifest_escape",
				"warning",
				"Manifest entries must be relative and remain inside the manifest directory tree",
				manifestPath,
			);
			continue;
		}
		const pattern = normalizeManifestPattern(entry);
		let isGlob: boolean;
		try {
			isGlob = picomatch.scan(pattern).isGlob;
		} catch (error) {
			addDiagnostic(
				diagnostics,
				"manifest_invalid",
				"warning",
				`Invalid manifest glob: ${errorMessage(error)}`,
				manifestPath,
			);
			continue;
		}
		if (!isGlob) {
			await processManifestCandidate(target, context);
			continue;
		}

		let matcher: (path: string) => boolean;
		try {
			matcher = picomatch(pattern, { dot: true });
		} catch (error) {
			addDiagnostic(
				diagnostics,
				"manifest_invalid",
				"warning",
				`Invalid manifest glob: ${errorMessage(error)}`,
				manifestPath,
			);
			continue;
		}
		inventory ??= await manifestInventory(rootDir, canonicalRoot, fs, diagnostics);
		const matches = inventory
			.filter((candidate) => matcher(candidate.relativePath))
			.slice()
			.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
		if (matches.length === 0) {
			addDiagnostic(
				diagnostics,
				"glob_no_match",
				"warning",
				`Manifest glob matched no paths: ${entry}`,
				manifestPath,
			);
			continue;
		}
		for (const match of matches) {
			if (match.isDirectory) {
				await processManifestCandidate(match.absolutePath, context);
			} else if (match.isFile && basename(match.absolutePath) === SKILL_FILENAME) {
				await loadSkillCandidate(match.absolutePath, context);
			} else {
				addDiagnostic(
					diagnostics,
					"manifest_invalid",
					"warning",
					"Manifest glob matched a file that is not named SKILL.md; ignoring it",
					match.absolutePath,
				);
			}
		}
	}
	return { skills, diagnostics };
}

export async function discoverSkills(options: DiscoverOptions): Promise<DiscoverResult> {
	const fs = options.fs ?? nodeFs;
	const cwd = resolve(options.cwd);
	const userHome = resolve(options.userHome ?? process.env.PILLOW_HOME ?? join(homedir(), ".pillow"));
	const userSkillsDir = resolve(options.userSkillsDir ?? join(userHome, "skills"));
	const projectSkillsDir = resolve(options.projectSkillsDir ?? join(cwd, ".pillow", "skills"));
	const userManifest = resolve(options.userManifest ?? join(userHome, "skills.json"));
	const projectManifest = resolve(options.projectManifest ?? join(cwd, ".pillow", "skills.json"));
	const results = [
		await scanConventionalRoot(userSkillsDir, "user", fs, cwd),
		await scanConventionalRoot(projectSkillsDir, "project", fs, cwd),
		await scanManifest(userManifest, "user", fs, cwd),
		await scanManifest(projectManifest, "project", fs, cwd),
	];

	return {
		skills: Object.freeze(results.flatMap((result) => result.skills)),
		diagnostics: Object.freeze(results.flatMap((result) => result.diagnostics)),
	};
}
