/**
 * User/project `.pillow` directories, one-shot migrate from `.z-agent`.
 */

import { access, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PILLOW_DIR_NAME = ".pillow";
export const LEGACY_DIR_NAME = ".z-agent";

export function pillowUserDir(home = homedir()): string {
	const override = process.env.PILLOW_HOME;
	if (override && override.length > 0) {
		return override;
	}
	return join(home, PILLOW_DIR_NAME);
}

export function pillowProjectDir(cwd: string): string {
	return join(cwd, PILLOW_DIR_NAME);
}

export function legacyUserDir(home = homedir()): string {
	return join(home, LEGACY_DIR_NAME);
}

export function legacyProjectDir(cwd: string): string {
	return join(cwd, LEGACY_DIR_NAME);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * If `target` is missing and `legacy` exists, copy legacy → target.
 * Otherwise ensure `target` exists.
 */
export async function ensurePillowDir(target: string, legacy: string): Promise<void> {
	if (await exists(target)) {
		return;
	}
	if (await exists(legacy)) {
		await cp(legacy, target, { recursive: true, errorOnExist: true });
		return;
	}
	await mkdir(target, { recursive: true });
}

export async function prepareUserPillow(home = homedir()): Promise<string> {
	const target = pillowUserDir(home);
	await ensurePillowDir(target, legacyUserDir(home));
	return target;
}

export async function prepareProjectPillow(cwd: string): Promise<string> {
	const target = pillowProjectDir(cwd);
	const legacy = legacyProjectDir(cwd);
	if (await exists(target)) {
		return target;
	}
	if (await exists(legacy)) {
		await cp(legacy, target, { recursive: true, errorOnExist: true });
	}
	return target;
}
