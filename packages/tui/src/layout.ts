export interface TuiPickerState {
	title: string;
	items: string[];
	index: number;
}

export interface TuiFrameState {
	status: string;
	transcript: string[];
	editorLines: string[];
	confirm?: string;
	picker?: TuiPickerState;
	streaming: boolean;
}

export function renderFrame(state: TuiFrameState, width: number, height: number): string[] {
	const safeWidth = Math.max(20, width);
	const safeHeight = Math.max(6, height);
	const status = clip(state.status, safeWidth);
	const confirm = state.confirm ? clip(state.confirm, safeWidth) : undefined;
	const editor = state.editorLines.map((line) => clip(`> ${line}`, safeWidth));
	const footer = confirm || state.picker ? (confirm ? [confirm] : []) : editor;
	const hint = state.picker
		? "↑↓ select · Enter · 1-9 · Esc cancel"
		: state.streaming
			? "Ctrl+C abort · again exits 130"
			: "Enter send · /exit · /reset · /compact · /sessions · Ctrl+T thinking";
	const reserved = 2 + footer.length;
	const bodyHeight = Math.max(1, safeHeight - reserved);
	const source = state.picker
		? [
				state.picker.title,
				...state.picker.items.map((item, i) => `${i === state.picker?.index ? ">" : " "} ${i + 1}. ${item}`),
			]
		: state.transcript;
	const body = source.slice(-bodyHeight).map((line) => clip(line, safeWidth));
	while (body.length < bodyHeight) {
		body.unshift("");
	}
	return [status, ...body, ...footer, clip(hint, safeWidth)];
}

function clip(text: string, width: number): string {
	const flat = text.replace(/\t/g, "  ");
	if (flat.length <= width) {
		return flat.padEnd(width, " ");
	}
	return `${flat.slice(0, Math.max(0, width - 1))}…`;
}
