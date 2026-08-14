/** Multiline editor buffer. Enter submits; Shift-style newlines via pasted `\n`. */
export class EditorBuffer {
	private text = "";

	insert(chunk: string): void {
		this.text += chunk;
	}

	backspace(): void {
		this.text = this.text.slice(0, -1);
	}

	clear(): void {
		this.text = "";
	}

	get value(): string {
		return this.text;
	}

	displayLines(): string[] {
		return this.text.length === 0 ? [""] : this.text.split("\n");
	}

	submit(): string {
		const value = this.text;
		this.text = "";
		return value;
	}
}
