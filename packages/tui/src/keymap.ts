import type { Key } from "./keys.ts";

export type TuiAction =
	| "submit"
	| "newline"
	| "interrupt"
	| "palette"
	| "completion.accept"
	| "completion.next"
	| "completion.prev"
	| "inspector.toggle"
	| "inspector.next"
	| "inspector.prev"
	| "inspector.view.next"
	| "inspector.view.prev"
	| "focus.editor"
	| "focus.transcript"
	| "exit";

export const TUI_ACTIONS: readonly TuiAction[] = [
	"submit",
	"newline",
	"interrupt",
	"palette",
	"completion.accept",
	"completion.next",
	"completion.prev",
	"inspector.toggle",
	"inspector.next",
	"inspector.prev",
	"inspector.view.next",
	"inspector.view.prev",
	"focus.editor",
	"focus.transcript",
	"exit",
];

export const DEFAULT_KEY_BINDINGS: Readonly<Record<TuiAction, string>> = {
	submit: "enter",
	newline: "shift+enter",
	interrupt: "ctrl+c",
	palette: "ctrl+p",
	"completion.accept": "tab",
	"completion.next": "tab",
	"completion.prev": "shift+tab",
	"inspector.toggle": "enter",
	"inspector.next": "down",
	"inspector.prev": "up",
	"inspector.view.next": "right",
	"inspector.view.prev": "left",
	"focus.editor": "escape",
	"focus.transcript": "tab",
	exit: "ctrl+c",
};

const VALID_CHORDS = new Set([
	"enter",
	"escape",
	"tab",
	"shift+tab",
	"shift+enter",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"backspace",
	"delete",
	...[..."abcdefghijklmnopqrstuvwxyz"].map((letter) => `ctrl+${letter}`),
]);

export interface KeymapContext {
	completion: boolean;
	focus: "editor" | "transcript";
	modal: boolean;
	streaming: boolean;
}

export interface ParsedKeymap {
	bindings: ReadonlyMap<string, TuiAction[]>;
	warnings: string[];
}

export function isTuiAction(value: string): value is TuiAction {
	return (TUI_ACTIONS as readonly string[]).includes(value);
}

export function normalizeChord(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/gu, "");
}

export function isValidChord(value: string): boolean {
	return VALID_CHORDS.has(normalizeChord(value));
}

export function chordFromKey(key: Key): string | undefined {
	if (key.type === "char" && key.value.length === 1) {
		return key.value.toLowerCase();
	}
	if (key.type === "ctrl") {
		return `ctrl+${key.value}`;
	}
	if (key.type === "shiftTab") {
		return "shift+tab";
	}
	if (key.type === "newline") {
		return "shift+enter";
	}
	if (key.type === "pageUp") {
		return "pageup";
	}
	if (key.type === "pageDown") {
		return "pagedown";
	}
	if (
		key.type === "enter" ||
		key.type === "escape" ||
		key.type === "tab" ||
		key.type === "up" ||
		key.type === "down" ||
		key.type === "left" ||
		key.type === "right" ||
		key.type === "home" ||
		key.type === "end" ||
		key.type === "backspace" ||
		key.type === "delete"
	) {
		return key.type;
	}
	return undefined;
}

export function parseKeymapConfig(raw: unknown): ParsedKeymap {
	const warnings: string[] = [];
	const byAction = new Map<TuiAction, string>(Object.entries(DEFAULT_KEY_BINDINGS) as Array<[TuiAction, string]>);
	if (raw === undefined) {
		return { bindings: bindingsFromActions(byAction), warnings };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push("keys.json: expected an object of action → chord");
		return { bindings: bindingsFromActions(byAction), warnings };
	}
	const overrides = raw as Record<string, unknown>;
	for (const [action, chord] of Object.entries(overrides)) {
		if (!isTuiAction(action)) {
			warnings.push(`keys.json: unknown action ${action}`);
			continue;
		}
		if (action === "interrupt") {
			warnings.push("keys.json: interrupt cannot be rebound");
			continue;
		}
		if (typeof chord !== "string" || !isValidChord(chord)) {
			warnings.push(`keys.json: invalid chord for ${action}`);
			continue;
		}
		byAction.set(action, normalizeChord(chord));
	}
	byAction.set("interrupt", "ctrl+c");
	return { bindings: bindingsFromActions(byAction), warnings };
}

export function resolveAction(
	key: Key,
	bindings: ReadonlyMap<string, TuiAction[]>,
	context: KeymapContext,
): TuiAction | undefined {
	if (context.modal) {
		return chordFromKey(key) === "ctrl+c" ? "interrupt" : undefined;
	}
	const chord = chordFromKey(key);
	if (!chord) {
		return undefined;
	}
	const actions = bindings.get(chord) ?? [];
	if (chord === "ctrl+c") {
		return context.streaming ? "interrupt" : "exit";
	}
	if (context.completion) {
		if (actions.includes("completion.prev")) {
			return "completion.prev";
		}
		if (actions.includes("completion.accept") || actions.includes("completion.next")) {
			return "completion.accept";
		}
	}
	if (context.focus === "transcript") {
		const inspector = actions.find((action) => action.startsWith("inspector.") || action === "focus.editor");
		if (inspector) {
			return inspector;
		}
	}
	if (context.focus === "editor") {
		if (actions.includes("palette")) {
			return "palette";
		}
		if (actions.includes("submit")) {
			return "submit";
		}
		if (actions.includes("newline")) {
			return "newline";
		}
		if (actions.includes("focus.transcript")) {
			return "focus.transcript";
		}
		if (actions.includes("focus.editor")) {
			return "focus.editor";
		}
	}
	return actions[0];
}

function bindingsFromActions(byAction: ReadonlyMap<TuiAction, string>): Map<string, TuiAction[]> {
	const bindings = new Map<string, TuiAction[]>();
	for (const [action, chord] of byAction) {
		const list = bindings.get(chord) ?? [];
		list.push(action);
		bindings.set(chord, list);
	}
	return bindings;
}
