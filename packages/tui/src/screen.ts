const ENTER_ALT = "\x1b[?1049h\x1b[?2004h\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?2004l\x1b[?1049l";
/** SGR mouse reporting (1006) + button/wheel tracking (1000). */
const MOUSE_ON = "\x1b[?1006h\x1b[?1000h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

export class LineScreen {
	private previous: string[] = [];
	private readonly write: (chunk: string) => void;
	private readonly mouse: boolean;
	private entered = false;

	constructor(
		write: (chunk: string) => void = (chunk) => {
			process.stdout.write(chunk);
		},
		options: { mouse?: boolean } = {},
	) {
		this.write = write;
		this.mouse = options.mouse !== false;
	}

	enter(): void {
		if (this.entered) {
			return;
		}
		this.entered = true;
		this.previous = [];
		this.write(ENTER_ALT + (this.mouse ? MOUSE_ON : ""));
	}

	leave(): void {
		if (!this.entered) {
			return;
		}
		this.entered = false;
		this.write((this.mouse ? MOUSE_OFF : "") + LEAVE_ALT);
		this.previous = [];
	}

	paint(lines: string[], cursor?: { row: number; col: number }): void {
		const out: string[] = [];
		const max = Math.max(this.previous.length, lines.length);
		for (let i = 0; i < max; i++) {
			const next = lines[i] ?? "";
			const prev = this.previous[i];
			if (next !== prev) {
				out.push(`\x1b[${i + 1};1H\x1b[2K${next}`);
			}
		}
		out.push(cursor ? `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h` : "\x1b[?25l");
		this.write(out.join(""));
		this.previous = lines.slice();
	}
}
