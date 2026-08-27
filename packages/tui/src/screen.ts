const ENTER_ALT = "\x1b[?1049h\x1b[?2004h\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?2004l\x1b[?1049l";

export class LineScreen {
	private previous: string[] = [];
	private readonly write: (chunk: string) => void;
	private entered = false;

	constructor(
		write: (chunk: string) => void = (chunk) => {
			process.stdout.write(chunk);
		},
	) {
		this.write = write;
	}

	enter(): void {
		if (this.entered) {
			return;
		}
		this.entered = true;
		this.previous = [];
		this.write(ENTER_ALT);
	}

	leave(): void {
		if (!this.entered) {
			return;
		}
		this.entered = false;
		this.write(LEAVE_ALT);
		this.previous = [];
	}

	paint(lines: string[]): void {
		const out: string[] = [];
		const max = Math.max(this.previous.length, lines.length);
		for (let i = 0; i < max; i++) {
			const next = lines[i] ?? "";
			const prev = this.previous[i];
			if (next !== prev) {
				out.push(`\x1b[${i + 1};1H\x1b[2K${next}`);
			}
		}
		if (out.length > 0) {
			this.write(out.join(""));
		}
		this.previous = lines.slice();
	}
}
