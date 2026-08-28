import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { parseSkill } from "./parse.ts";
import type { LoadedSkillBody, SkillDescriptor, SkillIndex, SkillResource } from "./types.ts";

export const MAX_SKILL_RESOURCE_BYTES = 4 * 1024 * 1024;

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const TEXT_MIME_TYPES: Readonly<Record<string, string>> = {
	".css": "text/css",
	".csv": "text/csv",
	".htm": "text/html",
	".html": "text/html",
	".js": "text/javascript",
	".json": "application/json",
	".jsx": "text/javascript",
	".md": "text/markdown",
	".mjs": "text/javascript",
	".svg": "image/svg+xml",
	".toml": "application/toml",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".txt": "text/plain",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
};

export class SkillResourceError extends Error {
	name = "SkillResourceError";
}

function normalizeName(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function descriptorByName(index: SkillIndex, name: string): SkillDescriptor | undefined {
	const normalized = normalizeName(name);
	return (
		index.byName.get(normalized) ?? index.skills.find((skill) => normalizeName(skill.metadata.name) === normalized)
	);
}

function normalizedRelativePath(value: string | undefined): string {
	const raw = value ?? "SKILL.md";
	if (raw.includes("\0") || isAbsolute(raw) || win32.isAbsolute(raw)) {
		throw new SkillResourceError("Skill resource path must be relative");
	}
	const portable = raw.replaceAll("\\", "/");
	if (portable.split("/").includes("..")) {
		throw new SkillResourceError("Skill resource path must not contain parent traversal");
	}
	const normalized = posix.normalize(portable).replace(/^\.\//, "");
	if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new SkillResourceError("Skill resource path must identify a file inside the skill root");
	}
	return normalized;
}

function isContained(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

interface FixedSkillPaths {
	baseDir: string;
	skillPath: string;
}

function fixedSkillPaths(skill: SkillDescriptor): FixedSkillPaths {
	const skillPath = skill.canonicalSkillPath ?? skill.source.canonicalPath;
	const baseDir = skill.canonicalBaseDir ?? dirname(skillPath);
	if (!isAbsolute(skillPath) || !isAbsolute(baseDir)) {
		throw new SkillResourceError("Indexed skill has non-absolute canonical paths");
	}
	if (resolve(skillPath) !== skillPath || resolve(baseDir) !== baseDir || dirname(skillPath) !== baseDir) {
		throw new SkillResourceError("Indexed skill has invalid canonical paths");
	}
	return { baseDir, skillPath };
}

function allIndexedDescriptors(index: SkillIndex): readonly SkillDescriptor[] {
	const descriptors: SkillDescriptor[] = [];
	const seen = new Set<SkillDescriptor>();
	for (const descriptor of [...index.skills, ...index.byName.values()]) {
		if (!seen.has(descriptor)) {
			seen.add(descriptor);
			descriptors.push(descriptor);
		}
	}
	return descriptors;
}

function rejectCrossSkillAlias(
	index: SkillIndex,
	selected: SkillDescriptor,
	selectedPaths: FixedSkillPaths,
	target: string,
): void {
	const readingPrimarySkillFile = target === selectedPaths.skillPath;
	for (const candidate of allIndexedDescriptors(index)) {
		const candidatePaths = fixedSkillPaths(candidate);
		if (
			candidate === selected ||
			(candidatePaths.baseDir === selectedPaths.baseDir && candidatePaths.skillPath === selectedPaths.skillPath)
		) {
			continue;
		}
		// A nested indexed skill may share the selected skill's directory tree, but
		// its own SKILL.md must never be reached through the parent skill alias.
		const nestedBelowSelected = isContained(selectedPaths.baseDir, candidatePaths.baseDir);
		if (
			candidatePaths.skillPath === target ||
			(!readingPrimarySkillFile && nestedBelowSelected && isContained(candidatePaths.baseDir, target))
		) {
			throw new SkillResourceError("Skill resource aliases another indexed skill");
		}
	}
}

async function assertFixedSkillIdentity(paths: FixedSkillPaths): Promise<void> {
	let observedRoot: string;
	let observedSkillPath: string;
	let observedSkillStat: Awaited<ReturnType<typeof lstat>>;
	try {
		[observedRoot, observedSkillPath, observedSkillStat] = await Promise.all([
			realpath(paths.baseDir),
			realpath(paths.skillPath),
			lstat(paths.skillPath),
		]);
	} catch {
		throw new SkillResourceError("Indexed skill paths are no longer available");
	}
	if (observedRoot !== paths.baseDir || observedSkillPath !== paths.skillPath || !observedSkillStat.isFile()) {
		throw new SkillResourceError("Indexed skill paths changed since discovery");
	}
}

function startsWithBytes(content: Uint8Array, expected: readonly number[]): boolean {
	return expected.every((byte, index) => content[index] === byte);
}

function validImage(content: Uint8Array, extension: string): boolean {
	if (extension === ".png") {
		return startsWithBytes(content, [137, 80, 78, 71, 13, 10, 26, 10]);
	}
	if (extension === ".jpg" || extension === ".jpeg") {
		return startsWithBytes(content, [255, 216, 255]);
	}
	if (extension === ".gif") {
		const header = new TextDecoder().decode(content.subarray(0, 6));
		return header === "GIF87a" || header === "GIF89a";
	}
	if (extension === ".webp") {
		return (
			new TextDecoder().decode(content.subarray(0, 4)) === "RIFF" &&
			new TextDecoder().decode(content.subarray(8, 12)) === "WEBP"
		);
	}
	return false;
}

function imageLabel(extension: string): string {
	if (extension === ".jpg" || extension === ".jpeg") {
		return "JPEG";
	}
	return extension.slice(1).toUpperCase();
}

function decodeText(content: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		throw new SkillResourceError(`Skill resource is not valid UTF-8 text: ${path}`);
	}
}

function sameFileIdentity(
	left: Awaited<ReturnType<typeof lstat>>,
	right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
	if (!left.isFile() || !right.isFile()) {
		return false;
	}
	if (left.dev !== right.dev || left.ino !== right.ino) {
		return false;
	}
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function readBoundedRegularFile(
	path: string,
	expectedStat: Awaited<ReturnType<typeof lstat>>,
	afterOpen: () => Promise<void>,
): Promise<Uint8Array> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = await handle.stat();
		if (!sameFileIdentity(expectedStat, info)) {
			throw new SkillResourceError("Skill resource changed before it could be read");
		}
		await afterOpen();
		if (!info.isFile()) {
			throw new SkillResourceError("Skill resource must resolve to a regular file");
		}
		if (info.size > MAX_SKILL_RESOURCE_BYTES) {
			throw new SkillResourceError(`Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES}-byte read limit`);
		}
		const content = new Uint8Array(MAX_SKILL_RESOURCE_BYTES + 1);
		let offset = 0;
		while (offset < content.byteLength) {
			const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
			if (bytesRead === 0) {
				break;
			}
			offset += bytesRead;
		}
		if (offset > MAX_SKILL_RESOURCE_BYTES) {
			throw new SkillResourceError(`Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES}-byte read limit`);
		}
		const finalInfo = await handle.stat();
		if (!sameFileIdentity(expectedStat, finalInfo)) {
			throw new SkillResourceError("Skill resource changed while it was being read");
		}
		return content.slice(0, offset);
	} finally {
		await handle?.close();
	}
}

export async function readSkillResource(
	index: SkillIndex,
	skillName: string,
	relativePath?: string,
): Promise<SkillResource> {
	const skill = descriptorByName(index, skillName);
	if (!skill) {
		throw new SkillResourceError(`Skill is not indexed: ${skillName}`);
	}
	const fixedPaths = fixedSkillPaths(skill);
	const safeRelativePath = normalizedRelativePath(relativePath);
	const lexicalTarget = resolve(fixedPaths.baseDir, ...safeRelativePath.split("/"));
	if (!isContained(fixedPaths.baseDir, lexicalTarget)) {
		throw new SkillResourceError("Skill resource path escapes the indexed skill root");
	}

	let canonicalTarget: string;
	let targetStat: Awaited<ReturnType<typeof lstat>>;
	try {
		await assertFixedSkillIdentity(fixedPaths);
		const lexicalInfo = await lstat(lexicalTarget);
		if (!lexicalInfo.isFile() && !lexicalInfo.isSymbolicLink()) {
			throw new SkillResourceError("Skill resource must resolve to a regular file");
		}
		canonicalTarget = await realpath(lexicalTarget);
		targetStat = await lstat(canonicalTarget);
		if (!targetStat.isFile()) {
			throw new SkillResourceError("Skill resource must resolve to a regular file");
		}
	} catch (error) {
		if (error instanceof SkillResourceError) {
			throw error;
		}
		throw new SkillResourceError(`Skill resource could not be resolved: ${safeRelativePath}`);
	}
	if (!isContained(fixedPaths.baseDir, canonicalTarget)) {
		throw new SkillResourceError("Skill resource canonical path escapes skill root");
	}
	rejectCrossSkillAlias(index, skill, fixedPaths, canonicalTarget);

	let content: Uint8Array;
	try {
		content = await readBoundedRegularFile(canonicalTarget, targetStat, async () => {
			await assertFixedSkillIdentity(fixedPaths);
			const observedTarget = await realpath(canonicalTarget);
			if (observedTarget !== canonicalTarget) {
				throw new SkillResourceError("Skill resource path changed before it was opened");
			}
		});
	} catch (error) {
		if (error instanceof SkillResourceError) {
			throw error;
		}
		throw new SkillResourceError(`Skill resource could not be read: ${safeRelativePath}`);
	}
	const extension = extname(canonicalTarget).toLowerCase();
	const imageMimeType = IMAGE_MIME_TYPES[extension];
	if (imageMimeType) {
		if (!validImage(content, extension)) {
			throw new SkillResourceError(`Skill resource is not a valid ${imageLabel(extension)} image`);
		}
		return {
			skillName: skill.metadata.name,
			relativePath: safeRelativePath,
			mimeType: imageMimeType,
			content,
		};
	}

	return {
		skillName: skill.metadata.name,
		relativePath: safeRelativePath,
		mimeType: TEXT_MIME_TYPES[extension] ?? "text/plain",
		content: decodeText(content, safeRelativePath),
	};
}

export async function readSkillBody(index: SkillIndex, skillName: string): Promise<LoadedSkillBody> {
	const skill = descriptorByName(index, skillName);
	if (!skill) {
		throw new SkillResourceError(`Skill is not indexed: ${skillName}`);
	}
	const resource = await readSkillResource(index, skillName);
	if (typeof resource.content !== "string") {
		throw new SkillResourceError("SKILL.md must be UTF-8 text");
	}
	const parsed = parseSkill(resource.content, skill.source);
	if (!parsed.descriptor) {
		const detail = parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
		throw new SkillResourceError(`SKILL.md is no longer valid: ${detail}`);
	}
	if (normalizeName(parsed.descriptor.metadata.name) !== normalizeName(skill.metadata.name)) {
		throw new SkillResourceError("SKILL.md name changed since it was indexed");
	}
	return {
		skillName: skill.metadata.name,
		body: parsed.descriptor.body ?? "",
		contentHash: createHash("sha256").update(resource.content, "utf8").digest("hex"),
	};
}
