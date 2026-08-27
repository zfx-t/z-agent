/** Cursor-aware prompt editor with display-only paste placeholders. */
export class EditorBuffer {
	private text = "";
	private cursor = 0;
	private placeholders: PlaceholderSpan[] = [];

	insert(chunk: string): void {
		this.replace(this.cursor, this.cursor, chunk);
	}

	insertPastedText(chunk: string, label: string): void {
		if (chunk.length === 0) {
			return;
		}
		const start = this.cursor;
		this.replace(start, start, chunk);
		this.placeholders.push({ start, end: start + chunk.length, label });
	}

	insertPastedImage(label: string): void {
		this.placeholders.push({ start: this.cursor, end: this.cursor, label });
	}

	backspace(): void {
		if (this.cursor === 0) {
			return;
		}
		this.replace(this.cursor - 1, this.cursor, "");
	}

	delete(): void {
		if (this.cursor >= this.text.length) {
			return;
		}
		this.replace(this.cursor, this.cursor + 1, "");
	}

	deleteWordBackward(): void {
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
		this.cursor = Math.max(0, this.cursor - 1);
	}

	moveRight(): void {
		this.cursor = Math.min(this.text.length, this.cursor + 1);
	}

	moveHome(): void {
		this.cursor = this.lineStart(this.cursor);
	}

	moveEnd(): void {
		this.cursor = this.lineEnd(this.cursor);
	}

	moveUp(): void {
		const currentStart = this.lineStart(this.cursor);
		if (currentStart === 0) {
			return;
		}
		const column = this.cursor - currentStart;
		const previousEnd = currentStart - 1;
		const previousStart = this.lineStart(previousEnd);
		this.cursor = Math.min(previousStart + column, previousEnd);
	}

	moveDown(): void {
		const currentStart = this.lineStart(this.cursor);
		const currentEnd = this.lineEnd(this.cursor);
		if (currentEnd === this.text.length) {
			return;
		}
		const column = this.cursor - currentStart;
		const nextStart = currentEnd + 1;
		const nextEnd = this.lineEnd(nextStart);
		this.cursor = Math.min(nextStart + column, nextEnd);
	}

	clear(): void {
		this.text = "";
		this.cursor = 0;
		this.placeholders = [];
	}

	set(value: string): void {
		this.text = value;
		this.cursor = value.length;
		this.placeholders = [];
	}

	get value(): string {
		return this.text;
	}

	get isMultiline(): boolean {
		return this.text.includes("\n");
	}

	displayLines(): string[] {
		const display = this.displayValueWithCursor();
		return display.split("\n");
	}

	submit(): string {
		const value = this.text;
		this.clear();
		return value;
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
	}

	private displayValueWithCursor(): string {
		const spans = this.placeholders.slice().sort((left, right) => left.start - right.start || left.end - right.end);
		let output = "";
		let sourceOffset = 0;
		let cursorRendered = false;
		for (const span of spans) {
			if (span.start < sourceOffset || span.start > this.text.length) {
				continue;
			}
			if (this.cursor < span.start) {
				output += this.text.slice(sourceOffset, this.cursor);
				output += "|";
				output += this.text.slice(this.cursor, span.start);
				cursorRendered = true;
			} else {
				output += this.text.slice(sourceOffset, span.start);
			}
			output += span.label;
			sourceOffset = span.end;
			if (!cursorRendered && this.cursor >= span.start && this.cursor <= span.end) {
				output += "|";
				cursorRendered = true;
			}
		}
		if (!cursorRendered) {
			output += this.text.slice(sourceOffset, this.cursor);
			output += "|";
			output += this.text.slice(this.cursor);
		} else {
			output += this.text.slice(sourceOffset);
		}
		return output;
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
