/**
 * Path resolve + jail. Jail uses realpath prefix + sep to block `..` and symlink escape.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

export function resolveToCwd(filePath: string, cwd: string): string {
	const trimmed = filePath.trim();
	if (trimmed.length === 0) {
		throw new Error("Path must not be empty");
	}

	let expanded = trimmed;
	if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = `${homedir()}${expanded.slice(1)}`;
	}

	if (isAbsolute(expanded)) {
		return normalize(expanded);
	}
	return resolve(cwd, expanded);
}

function isInsideRoot(candidate: string, rootReal: string): boolean {
	if (process.platform === "win32") {
		candidate = candidate.toLowerCase();
		rootReal = rootReal.toLowerCase();
	}
	if (candidate === rootReal) {
		return true;
	}
	const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
	return candidate.startsWith(prefix);
}

async function realExistingPrefix(absPath: string): Promise<string> {
	try {
		return await realpath(absPath);
	} catch {
		let dir = dirname(resolve(absPath));
		while (true) {
			try {
				const realDir = await realpath(dir);
				return resolve(realDir, relative(dir, resolve(absPath)));
			} catch {
				const parent = dirname(dir);
				if (parent === dir) {
					return resolve(absPath);
				}
				dir = parent;
			}
		}
	}
}

/**
 * Throw if `absPath` (after realpath) is outside `jailRoot`.
 */
export async function assertInsideJail(absPath: string, jailRoot: string): Promise<void> {
	const rootReal = await realpath(jailRoot).catch(() => resolve(jailRoot));
	const candidate = await realExistingPrefix(absPath);
	if (!isInsideRoot(candidate, rootReal)) {
		throw new Error(`Path escapes jail (${jailRoot}): ${absPath}`);
	}
}

export async function resolveToolPath(filePath: string, cwd: string, jailRoot: string | false): Promise<string> {
	const absolutePath = resolveToCwd(filePath, cwd);
	if (jailRoot !== false) {
		await assertInsideJail(absolutePath, jailRoot);
	}
	return absolutePath;
}
