/**
 * Directory walk used by grep/find/ls fallbacks.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".hg", ".svn"]);

export async function listDirectory(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
}

export async function walkFiles(
	root: string,
	signal: AbortSignal | undefined,
	onFile: (absPath: string, relPath: string) => void | Promise<void>,
): Promise<void> {
	const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
	while (stack.length > 0) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}
		const current = stack.pop();
		if (!current) {
			break;
		}
		let entries: Dirent[] | undefined;
		try {
			entries = await readdir(current.abs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (SKIP_DIR_NAMES.has(entry.name)) {
				continue;
			}
			const abs = join(current.abs, entry.name);
			const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				stack.push({ abs, rel });
			} else if (entry.isFile()) {
				await onFile(abs, rel);
			}
		}
	}
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
