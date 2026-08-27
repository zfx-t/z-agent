/**
 * Project trust for loading cwd `.pillow/` resources.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pillowUserDir } from "./pillow-home.ts";

export function trustStorePath(root = pillowUserDir()): string {
	return join(root, "trust.json");
}

export async function isTrusted(cwd: string, store = trustStorePath()): Promise<boolean> {
	try {
		const raw = JSON.parse(await readFile(store, "utf-8")) as { trusted?: string[] };
		return (raw.trusted ?? []).includes(cwd);
	} catch {
		return false;
	}
}

export async function markTrusted(cwd: string, store = trustStorePath()): Promise<void> {
	await mkdir(dirname(store), { recursive: true });
	let trusted: string[] = [];
	try {
		const raw = JSON.parse(await readFile(store, "utf-8")) as { trusted?: string[] };
		trusted = raw.trusted ?? [];
	} catch {
		trusted = [];
	}
	if (!trusted.includes(cwd)) {
		trusted.push(cwd);
	}
	await writeFile(store, `${JSON.stringify({ trusted }, null, 2)}\n`, "utf-8");
}

export async function askYesNo(
	question: string,
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
	if (!("isTTY" in input) || !input.isTTY) {
		return false;
	}
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(`${question} (yes/no) `);
		return /^(y|yes)$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

export async function ensureProjectTrust(
	cwd: string,
	ask: () => Promise<boolean>,
	store = trustStorePath(),
): Promise<boolean> {
	if (await isTrusted(cwd, store)) {
		return true;
	}
	const ok = await ask();
	if (ok) {
		await markTrusted(cwd, store);
	}
	return ok;
}
