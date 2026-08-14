import type { Key } from "./keys.ts";

export type ConfirmChoice = "once" | "always" | "deny";

export interface ConfirmRequest {
	toolName: string;
	args: unknown;
}

export function confirmChoiceFromKey(key: Key): ConfirmChoice | undefined {
	if (key.type === "char") {
		const ch = key.value.toLowerCase();
		if (ch === "y") {
			return "once";
		}
		if (ch === "a") {
			return "always";
		}
		if (ch === "n") {
			return "deny";
		}
	}
	if (key.type === "enter") {
		return "once";
	}
	if (key.type === "escape") {
		return "deny";
	}
	return undefined;
}

export function formatConfirmPrompt(request: ConfirmRequest): string {
	let args = "";
	try {
		args = JSON.stringify(request.args);
	} catch {
		args = String(request.args);
	}
	if (args.length > 160) {
		args = `${args.slice(0, 160)}…`;
	}
	return `Allow ${request.toolName} ${args}?  [y] once  [a] always  [n] deny`;
}
