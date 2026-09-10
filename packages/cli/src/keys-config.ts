import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParsedKeymap, parseKeymapConfig } from "@z-agent/tui";

export function keysConfigPath(userPillow: string): string {
	return join(userPillow, "keys.json");
}

export async function loadKeymap(userPillow: string): Promise<ParsedKeymap> {
	try {
		const raw = JSON.parse(await readFile(keysConfigPath(userPillow), "utf-8")) as unknown;
		return parseKeymapConfig(raw);
	} catch (error) {
		if (isMissing(error)) {
			return parseKeymapConfig(undefined);
		}
		return {
			...parseKeymapConfig(undefined),
			warnings: [`keys.json: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
