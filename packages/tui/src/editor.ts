import { cleanMapped } from "./text.ts";

/** Cursor-aware prompt editor with display-only paste placeholders and a selection model. */
export class EditorBuffer {
	private text = "";
	private cursor = 0;
	/** Selection anchor: when set and != cursor, [min,max) is selected. */
	private anchor: number | undefined;
	private placeholders: PlaceholderSpan[] = [];

	insert(chunk: string): void {
		const range = this.selectionRange;
		if (range) {
			this.replace(range.start, range.end, chunk);
			return;
		}
		this.replace(this.cursor, this.cursor, chunk);
	}

	insertPastedText(chunk: string, label: string): void {
		if (chunk.length === 0) {
			return;
		}
		const sel = this.selectionRange;
		const start = sel ? sel.start : this.cursor;
		if (sel) {
			this.replace(sel.start, sel.end, "");
		}
		this.replace(start, start, chunk);
		this.placeholders.push({ start, end: start + chunk.length, label });
	}

	insertPastedImage(label: string): void {
		const sel = this.selectionRange;
		if (sel) {
			this.replace(sel.start, sel.end, "");
		}
		this.placeholders.push({ start: this.cursor, end: this.cursor, label });
	}

	/** Replace a source range while preserving a cursor positioned outside it. */
	replaceRange(start: number, end: number, inserted: string): void {
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.text.length) {
			throw new RangeError(`Invalid editor range [${start}, ${end})`);
		}
		const previousCursor = this.cursor;
		this.replace(start, end, inserted);
		if (previousCursor < start) {
			this.cursor = previousCursor;
		} else if (previousCursor > end) {
			this.cursor = previousCursor + inserted.length - (end - start);
		}
	}

	backspace(): void {
		const sel = this.selectionRange;
		if (sel) {
			this.replace(sel.start, sel.end, "");
			return;
		}
		if (this.cursor === 0) {
			return;
		}
		this.replace(this.cursor - 1, this.cursor, "");
	}

	delete(): void {
		const sel = this.selectionRange;
		if (sel) {
			this.replace(sel.start, sel.end, "");
			return;
		}
		if (this.cursor >= this.text.length) {
			return;
		}
		this.replace(this.cursor, this.cursor + 1, "");
	}

	deleteWordBackward(): void {
		const sel = this.selectionRange;
		if (sel) {
			this.replace(sel.start, sel.end, "");
			return;
		}
		if (this.cursor === 0) {
			return;
		}
		let start = this.cursor;
		while (start > 0 && /\s/.test(this.text[start - 1] ?? "")) {
			start -= 1;
		}
		while (start > 0 && !/\s/.test(this.text[start - 1] ?? "")) {
			start -= 1;
		}
		this.replace(start, this.cursor, "");
	}

	moveLeft(): void {
		const sel = this.selectionRange;
		if (sel) {
			// A plain arrow collapses the selection to the matching edge.
			this.cursor = sel.start;
			this.anchor = undefined;
			return;
		}
		this.cursor = Math.max(0, this.cursor - 1);
	}

	moveRight(): void {
		const sel = this.selectionRange;
		if (sel) {
			this.cursor = sel.end;
			this.anchor = undefined;
			return;
		}
		this.cursor = Math.min(this.text.length, this.cursor + 1);
	}

	moveWordLeft(): void {
		const sel = this.selectionRange;
		this.anchor = undefined;
		let next = sel ? sel.start : this.cursor;
		while (next > 0 && /\s/.test(this.text[next - 1] ?? "")) {
			next -= 1;
		}
		while (next > 0 && !/\s/.test(this.text[next - 1] ?? "")) {
			next -= 1;
		}
		this.cursor = next;
	}

	moveWordRight(): void {
		const sel = this.selectionRange;
		this.anchor = undefined;
		let next = sel ? sel.end : this.cursor;
		while (next < this.text.length && !/\s/.test(this.text[next] ?? "")) {
			next += 1;
		}
		while (next < this.text.length && /\s/.test(this.text[next] ?? "")) {
			next += 1;
		}
		this.cursor = next;
	}

	deleteWordForward(): void {
		const sel = this.selectionRange;
		if (sel) {
			this.replace(sel.start, sel.end, "");
			return;
		}
		let end = this.cursor;
		while (end < this.text.length && /\s/.test(this.text[end] ?? "")) {
			end += 1;
		}
		while (end < this.text.length && !/\s/.test(this.text[end] ?? "")) {
			end += 1;
		}
		if (end > this.cursor) {
			this.replace(this.cursor, end, "");
		}
	}

	killToLineEnd(): void {
		const sel = this.selectionRange;
		if (sel) {
			this.replace(sel.start, sel.end, "");
			return;
		}
		const end = this.lineEnd(this.cursor);
		if (end > this.cursor) {
			this.replace(this.cursor, end, "");
		} else if (end < this.text.length) {
			this.replace(this.cursor, end + 1, "");
		}
	}

	moveHome(): void {
		const sel = this.selectionRange;
		this.anchor = undefined;
		this.cursor = sel ? sel.start : this.lineStart(this.cursor);
	}

	moveEnd(): void {
		const sel = this.selectionRange;
		this.anchor = undefined;
		this.cursor = sel ? sel.end : this.lineEnd(this.cursor);
	}

	moveUp(): void {
		this.anchor = undefined;
		const currentStart = this.lineStart(this.cursor);
		if (currentStart === 0) {
			this.cursor = 0;
			return;
		}
		const column = this.cursor - currentStart;
		const previousEnd = currentStart - 1;
		const previousStart = this.lineStart(previousEnd);
		this.cursor = Math.min(previousStart + column, previousEnd);
	}

	moveDown(): void {
		this.anchor = undefined;
		const currentStart = this.lineStart(this.cursor);
		const currentEnd = this.lineEnd(this.cursor);
		if (currentEnd === this.text.length) {
			this.cursor = this.text.length;
			return;
		}
		const column = this.cursor - currentStart;
		const nextStart = currentEnd + 1;
		const nextEnd = this.lineEnd(nextStart);
		this.cursor = Math.min(nextStart + column, nextEnd);
	}

	/** Shift+arrow family: extend the selection (anchor sticks, cursor moves). */
	extendLeft(): void {
		this.extendTo(() => {
			this.cursor = Math.max(0, this.cursor - 1);
		});
	}

	extendRight(): void {
		this.extendTo(() => {
			this.cursor = Math.min(this.text.length, this.cursor + 1);
		});
	}

	extendHome(): void {
		this.extendTo(() => {
			this.cursor = this.lineStart(this.cursor);
		});
	}

	extendEnd(): void {
		this.extendTo(() => {
			this.cursor = this.lineEnd(this.cursor);
		});
	}

	extendWordLeft(): void {
		this.extendTo(() => {
			let next = this.cursor;
			while (next > 0 && /\s/.test(this.text[next - 1] ?? "")) {
				next -= 1;
			}
			while (next > 0 && !/\s/.test(this.text[next - 1] ?? "")) {
				next -= 1;
			}
			this.cursor = next;
		});
	}

	extendWordRight(): void {
		this.extendTo(() => {
			let next = this.cursor;
			while (next < this.text.length && !/\s/.test(this.text[next] ?? "")) {
				next += 1;
			}
			while (next < this.text.length && /\s/.test(this.text[next] ?? "")) {
				next += 1;
			}
			this.cursor = next;
		});
	}

	extendUp(): void {
		this.extendTo(() => {
			const currentStart = this.lineStart(this.cursor);
			if (currentStart === 0) {
				this.cursor = 0;
				return;
			}
			const column = this.cursor - currentStart;
			const previousEnd = currentStart - 1;
			const previousStart = this.lineStart(previousEnd);
			this.cursor = Math.min(previousStart + column, previousEnd);
		});
	}

	extendDown(): void {
		this.extendTo(() => {
			const currentStart = this.lineStart(this.cursor);
			const currentEnd = this.lineEnd(this.cursor);
			if (currentEnd === this.text.length) {
				this.cursor = this.text.length;
				return;
			}
			const column = this.cursor - currentStart;
			const nextStart = currentEnd + 1;
			const nextEnd = this.lineEnd(nextStart);
			this.cursor = Math.min(nextStart + column, nextEnd);
		});
	}

	clearSelection(): void {
		this.anchor = undefined;
	}

	get selectionRange(): { start: number; end: number } | undefined {
		if (this.anchor === undefined || this.anchor === this.cursor) {
			return undefined;
		}
		return { start: Math.min(this.anchor, this.cursor), end: Math.max(this.anchor, this.cursor) };
	}

	clear(): void {
		this.text = "";
		this.cursor = 0;
		this.anchor = undefined;
		this.placeholders = [];
	}

	set(value: string): void {
		this.text = value;
		this.cursor = value.length;
		this.anchor = undefined;
		this.placeholders = [];
	}

	get value(): string {
		return this.text;
	}

	get cursorOffset(): number {
		return this.cursor;
	}

	/** Place the caret at a clicked display-line cell (char columns, post-placeholder text). */
	setCursorFromDisplay(row: number, col: number, extend = false): void {
		const { map } = this.displayValue();
		const lines = this.displayLines();
		let displayIndex = 0;
		for (let index = 0; index < row && index < lines.length; index += 1) {
			displayIndex += (lines[index] ?? "").length + 1;
		}
		const lineLength = (lines[row] ?? "").length;
		displayIndex += Math.max(0, Math.min(col, lineLength));
		const source = map[Math.min(displayIndex, map.length - 1)] ?? this.text.length;
		if (!extend) {
			this.anchor = undefined;
		} else if (this.anchor === undefined) {
			this.anchor = this.cursor;
		}
		this.cursor = source;
		if (this.anchor === this.cursor) {
			this.anchor = undefined;
		}
	}

	get isMultiline(): boolean {
		return this.text.includes("\n");
	}

	displayLines(): string[] {
		return this.displayValue().text.split("\n");
	}

	/** Cursor as {row, col} in display-line coordinates (col counts characters). */
	displayCursor(): { row: number; col: number } {
		const { text, cursor } = this.displayValue();
		let row = 0;
		let lineStart = 0;
		for (let index = 0; index < cursor; index += 1) {
			if (text[index] === "\n") {
				row += 1;
				lineStart = index + 1;
			}
		}
		return { row, col: cursor - lineStart };
	}

	/** Selection as per-display-line char spans (post-placeholder coordinates). */
	displaySelection(): Array<{ row: number; start: number; end: number }> {
		const sel = this.selectionRange;
		if (!sel) {
			return [];
		}
		const { text, sourceToDisplay } = this.displayValue();
		const d0 = sourceToDisplay[sel.start] ?? 0;
		const d1 = sourceToDisplay[sel.end] ?? text.length;
		const spans: Array<{ row: number; start: number; end: number }> = [];
		let row = 0;
		let lineStart = 0;
		for (let index = 0; index <= text.length; index += 1) {
			const atBreak = index === text.length || text[index] === "\n";
			if (atBreak) {
				const start = Math.max(d0, lineStart);
				const end = Math.min(d1, index);
				if (end > start) {
					spans.push({ row, start: start - lineStart, end: end - lineStart });
				}
				row += 1;
				lineStart = index + 1;
			}
		}
		return spans;
	}

	submit(): string {
		const value = this.text;
		this.clear();
		return value;
	}

	private extendTo(move: () => void): void {
		if (this.anchor === undefined) {
			this.anchor = this.cursor;
		}
		move();
		if (this.anchor === this.cursor) {
			this.anchor = undefined;
		}
	}

	private replace(start: number, end: number, inserted: string): void {
		const removed = end - start;
		this.placeholders = this.placeholders
			.filter((span) => !overlaps(span, start, end) && !(removed === 0 && span.start < start && span.end > start))
			.map((span) => {
				if (span.start >= end) {
					return {
						...span,
						start: span.start + inserted.length - removed,
						end: span.end + inserted.length - removed,
					};
				}
				return span;
			});
		this.text = `${this.text.slice(0, start)}${inserted}${this.text.slice(end)}`;
		this.cursor = start + inserted.length;
		this.anchor = undefined;
	}

	/**
	 * Display text/cursor plus bidirectional offset maps, all in cleaned
	 * coordinates (ANSI stripped, controls dropped, tabs expanded — the same
	 * text the layout paints, so cursor/selection/click math never drifts).
	 * `map` indexes display chars to source offsets (placeholder label cells
	 * map to the span end, so a click lands after the chip); `sourceToDisplay`
	 * inverts it.
	 */
	private displayValue(): { text: string; cursor: number; map: number[]; sourceToDisplay: number[] } {
		const spans = this.placeholders.slice().sort((left, right) => left.start - right.start || left.end - right.end);
		let output = "";
		const rawMap: number[] = [];
		const sourceToRaw: number[] = [];
		let sourceOffset = 0;
		let rawCursor = -1;
		const pushText = (chunk: string): void => {
			for (let index = 0; index < chunk.length; index += 1) {
				sourceToRaw[sourceOffset + index] = output.length;
				rawMap.push(sourceOffset + index);
				output += chunk[index];
			}
			sourceOffset += chunk.length;
		};
		for (const span of spans) {
			if (span.start < sourceOffset || span.start > this.text.length) {
				continue;
			}
			if (this.cursor < span.start) {
				const before = this.text.slice(sourceOffset, this.cursor);
				pushText(before);
				rawCursor = output.length;
				pushText(this.text.slice(this.cursor, span.start));
			} else {
				pushText(this.text.slice(sourceOffset, span.start));
			}
			for (let index = 0; index < span.label.length; index += 1) {
				rawMap.push(span.end);
			}
			for (let index = span.start; index < span.end; index += 1) {
				sourceToRaw[index] = output.length;
			}
			output += span.label;
			// Source offset at the span's end displays after the chip.
			sourceToRaw[span.end] = output.length;
			sourceOffset = span.end;
			if (rawCursor < 0 && this.cursor >= span.start && this.cursor <= span.end) {
				rawCursor = output.length;
			}
		}
		if (rawCursor < 0) {
			pushText(this.text.slice(sourceOffset, this.cursor));
			rawCursor = output.length;
			pushText(this.text.slice(this.cursor));
		} else {
			pushText(this.text.slice(sourceOffset));
		}
		if (sourceToRaw[this.text.length] === undefined) {
			sourceToRaw[this.text.length] = output.length;
		}
		rawMap.push(this.text.length);
		const cleaned = cleanMapped(output);
		const map = cleaned.toRaw.map((raw) => rawMap[raw] ?? this.text.length);
		map.push(this.text.length);
		const sourceToDisplay = sourceToRaw.map((raw) => cleaned.fromRaw[raw] ?? cleaned.text.length);
		const cursor = cleaned.fromRaw[rawCursor] ?? cleaned.text.length;
		return { text: cleaned.text, cursor, map, sourceToDisplay };
	}

	private lineStart(offset: number): number {
		return this.text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	}

	private lineEnd(offset: number): number {
		const end = this.text.indexOf("\n", offset);
		return end < 0 ? this.text.length : end;
	}
}

interface PlaceholderSpan {
	start: number;
	end: number;
	label: string;
}

function overlaps(span: PlaceholderSpan, start: number, end: number): boolean {
	if (start === end) {
		return false;
	}
	return span.start < end && span.end > start;
}
