/**
 * Load extension modules (ESM / TS via Node strip-types). Confirm gate first.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@z-agent/agent";
import type { ExtensionApi } from "./extension-api.ts";
import { pillowProjectDir, pillowUserDir } from "./pillow-home.ts";

export interface Extension {
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

export function extensionSearchDirs(cwd: string): string[] {
	return [join(pillowUserDir(), "extensions"), join(pillowProjectDir(cwd), "extensions")];
}

const EXT_RE = /\.(mjs|js|ts)$/;

export async function discoverExtensionPaths(cwd: string): Promise<string[]> {
	const found: string[] = [];
	for (const dir of extensionSearchDirs(cwd)) {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (EXT_RE.test(name)) {
				found.push(join(dir, name));
			}
		}
	}
	return found;
}

export async function loadExtension(modulePath: string, cwd: string): Promise<Extension> {
	return await loadExtensionInto(modulePath, cwd, noopExtensionApi());
}

export async function loadExtensionInto(modulePath: string, cwd: string, api: ExtensionApi): Promise<Extension> {
	const resolved = resolve(cwd, modulePath);
	const mod = (await import(pathToFileURL(resolved).href)) as {
		default?: Extension | ((api: ExtensionApi) => Extension | undefined | Promise<Extension | undefined>);
		createExtension?: (api: ExtensionApi) => Extension | undefined | Promise<Extension | undefined>;
	};
	if (typeof mod.createExtension === "function") {
		return normalizeLoaded(await mod.createExtension(api), resolved);
	}
	if (typeof mod.default === "function") {
		return normalizeLoaded(await mod.default(api), resolved);
	}
	if (mod.default && typeof mod.default === "object") {
		return mod.default;
	}
	throw new Error(`Extension ${resolved} must export createExtension or default`);
}

function normalizeLoaded(value: Extension | undefined, resolved: string): Extension {
	if (value === undefined) {
		return {};
	}
	if (typeof value === "object") {
		return value;
	}
	throw new Error(`Extension ${resolved} must export createExtension or default`);
}

function noopExtensionApi(): ExtensionApi {
	return {
		registerCommand() {},
		registerTool() {},
		registerStatusSegment() {},
		registerToolRenderer() {},
		on() {},
	};
}

export function composeBefore(
	first: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>,
	extensions: Extension[],
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
	return async (context, signal) => {
		const head = await first(context, signal);
		if (head?.block) {
			return head;
		}
		for (const ext of extensions) {
			const result = await ext.beforeToolCall?.(context, signal);
			if (result?.block) {
				return result;
			}
		}
		return head;
	};
}
