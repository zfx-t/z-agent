export type TuiRunState = "ready" | "running";

export interface TuiHeaderState {
	cwd: string;
	model: string;
	session: string;
}

export type TuiTranscriptKind = "user" | "assistant" | "thinking" | "tool" | "info" | "warning" | "error";

export type TuiToolState = "running" | "success" | "error";

export interface TuiToolSnapshot {
	toolCallId: string;
	toolName: string;
	argsText: string;
	state: TuiToolState;
	outputText?: string;
	detailsText?: string;
	durationMs?: number;
}

export interface TuiTranscriptEntry {
	id: string;
	kind: TuiTranscriptKind;
	text: string;
	createdAt?: number;
	hidden?: boolean;
	tool?: TuiToolSnapshot;
}

export interface TuiInspectorState {
	tool: TuiToolSnapshot;
}

export interface TuiToolUpdate {
	outputText?: string;
	detailsText?: string;
}
