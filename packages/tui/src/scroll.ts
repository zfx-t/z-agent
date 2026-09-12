/**
 * Scroll normalization for mouse wheel/trackpad input, ported from Grok
 * Build's `MouseScrollState` (xai-grok-pager-render/src/input/mouse.rs).
 *
 * Terminal scroll events vary widely in event counts per wheel tick, and
 * inter-event timing overlaps heavily between wheel and trackpad input. We
 * normalize by treating events as short streams separated by gaps, converting
 * them into line deltas with a per-terminal events-per-tick factor. Redraw is
 * coalesced to a fixed cadence.
 *
 * A mouse wheel "tick" (one notch) scrolls a fixed number of lines regardless
 * of the terminal's raw event density. Trackpad scrolling stays higher
 * fidelity: small movements accumulate sub-line amounts that only scroll once
 * whole lines are reached.
 *
 * Because terminal mouse scroll events carry no magnitude (only direction),
 * wheel-vs-trackpad detection is heuristic: bias toward trackpad-like (avoids
 * overshoot) and "promote" to wheel-like when the first tick-worth of events
 * arrives quickly. Z_AGENT_SCROLL_MODE=wheel|trackpad pins the choice when the
 * heuristic is wrong; Z_AGENT_SCROLL_LINES, Z_AGENT_SCROLL_SPEED (1-100),
 * Z_AGENT_SCROLL_INVERT=1 tune throughput and direction.
 */

export type ScrollDirection = "up" | "down";

export type ScrollInputMode = "auto" | "wheel" | "trackpad";

/** One gesture until an 80ms gap or a direction flip. */
const STREAM_GAP_MS = 80;
/** Default scroll flush cadence (~60fps). */
const REDRAW_CADENCE_MS = 16;

const DEFAULT_EVENTS_PER_TICK = 3;
const DEFAULT_WHEEL_LINES_PER_TICK = 3;
const DEFAULT_TRACKPAD_LINES_PER_TICK = 3;
const DEFAULT_WHEEL_TICK_DETECT_MAX_MS = 12;
const DEFAULT_WHEEL_LIKE_MAX_DURATION_MS = 200;
const TRACKPAD_ACCEL_MAX = 3;
const DEFAULT_TRACKPAD_DETECT_MAX_INTERVAL_MS = 30;
/** Floor for the per-flush delta cap (see `flushCap`). */
const MIN_DELTA_PER_FLUSH = 6;
/** Interval-based acceleration thresholds, averaged over a rolling window. */
const ACCEL_INTERVAL_FAST_MS = 8;
const ACCEL_INTERVAL_MEDIUM_MS = 20;
/**
 * Sub-6ms spacing is terminal batching (Ghostty double-reports a notch), not
 * gesture speed. Events still accumulate lines but stay out of the accel
 * window, which would otherwise read them as max velocity.
 */
const ACCEL_MIN_INTERVAL_MS = 6;
const ACCEL_MULTIPLIER_BASE = 1;
const ACCEL_MULTIPLIER_MEDIUM = 1.6;
const ACCEL_MULTIPLIER_FAST = 2.5;
const ACCEL_HISTORY_SIZE = 6;
const MIN_LINES_PER_WHEEL_STREAM = 1;

/** xterm.js embeds emit scroll events ~3x slower than native terminals. */
function isVsCodeEmbed(brand: TerminalBrand): boolean {
	return brand === "vscode" || brand === "cursor" || brand === "windsurf" || brand === "zed";
}

/** Convert a scroll speed setting (1-100) to a multiplier: 50 = 1x, 1 = 0.1x, 100 = 6x. */
export function speedToMultiplier(speed: number): number {
	const s = Math.max(1, Math.min(100, Math.trunc(speed)));
	if (s <= 50) {
		return 0.1 + (s - 1) * (0.9 / 49);
	}
	return 1 + (s - 50) * (5 / 50);
}

export type TerminalBrand =
	| "apple-terminal"
	| "warp"
	| "wezterm"
	| "alacritty"
	| "rio"
	| "foot"
	| "ghostty"
	| "iterm2"
	| "vscode"
	| "cursor"
	| "windsurf"
	| "zed"
	| "kitty"
	| "windows-terminal"
	| "jetbrains"
	| "vte"
	| "unknown";

/** Detect the outer terminal brand from environment variables. */
export function detectTerminalBrand(env: NodeJS.ProcessEnv = process.env): TerminalBrand {
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	if (program === "apple_terminal") {
		return "apple-terminal";
	}
	if (program === "warpterminal") {
		return "warp";
	}
	if (program === "wezterm") {
		return "wezterm";
	}
	if (program === "iterm.app") {
		return "iterm2";
	}
	if (program === "vscode" || (env.TERM_PROGRAM_VERSION !== undefined && env.VSCODE_INJECTION === "1")) {
		return "vscode";
	}
	if (program === "ghostty") {
		return "ghostty";
	}
	if (env.KITTY_WINDOW_ID !== undefined || program === "kitty") {
		return "kitty";
	}
	if (env.WEZTERM_PANE !== undefined) {
		return "wezterm";
	}
	if (program === "cursor") {
		return "cursor";
	}
	if (program === "windsurf") {
		return "windsurf";
	}
	if (program === "zed") {
		return "zed";
	}
	if (env.JETBRAINS_IDE !== undefined || env.TERMINAL_EMULATOR === "JetBrains-JediTerm") {
		return "jetbrains";
	}
	if (env.WT_SESSION !== undefined) {
		return "windows-terminal";
	}
	const term = (env.TERM ?? "").toLowerCase();
	if (term.includes("alacritty")) {
		return "alacritty";
	}
	if (term.includes("rio")) {
		return "rio";
	}
	if (term.startsWith("foot")) {
		return "foot";
	}
	if (term.startsWith("xterm") || env.VTE_VERSION !== undefined) {
		return "vte";
	}
	return "unknown";
}

/**
 * Multiplexers that re-encode mouse into their own SGR stream (tmux with
 * `mouse on`, screen, zellij re-emit per pane); the outer brand's event
 * density no longer applies.
 */
export function inMultiplexer(env: NodeJS.ProcessEnv = process.env): boolean {
	const term = (env.TERM ?? "").toLowerCase();
	return env.TMUX !== undefined || env.ZELLIJ !== undefined || term.startsWith("tmux") || term.startsWith("screen");
}

/** Scroll normalization settings derived from terminal metadata and env overrides. */
export interface ScrollConfig {
	/** Per-terminal normalization factor ("events per wheel tick"). */
	eventsPerTick: number;
	/** Lines applied per mouse wheel tick. */
	wheelLinesPerTick: number;
	/** Lines applied per tick-equivalent for trackpad scrolling. */
	trackpadLinesPerTick: number;
	/** Trackpad acceleration: maximum multiplier. */
	trackpadAccelMax: number;
	/** Force wheel/trackpad behavior, or infer it per stream. */
	mode: ScrollInputMode;
	/** Auto-mode threshold: how quickly the first wheel tick must complete. */
	wheelTickDetectMaxMs: number;
	/** Auto-mode fallback: maximum duration still considered "wheel-like". */
	wheelLikeMaxDurationMs: number;
	/** Invert the sign of vertical scroll direction. */
	invertDirection: boolean;
	/** Interval-based acceleration: threshold for "fast" band (ms). */
	accelIntervalFastMs: number;
	/** Interval-based acceleration: threshold for "medium" band (ms). */
	accelIntervalMediumMs: number;
	/** ept=1 trackpad detection: max avg interval (ms) to classify as trackpad. */
	trackpadDetectMaxIntervalMs: number;
	/** User-facing speed multiplier (scroll speed 1-100). */
	speedMultiplier: number;
	/** Viewport height (rows) of the scroll target; 0 = unknown. */
	viewportRows: number;
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function defaultScrollConfig(env: NodeJS.ProcessEnv = process.env, viewportRows = 0): ScrollConfig {
	const remuxed = inMultiplexer(env);
	const brand = detectTerminalBrand(env);
	const embedded = isVsCodeEmbed(brand) && !remuxed;

	// Muxes re-encode SGR, so an outer ept=3 under-counts 3x when they re-chunk
	// to one event: conservatively price one event per notch and let Auto
	// timing, not event-count trust, classify wheel vs trackpad.
	let eventsPerTick = remuxed
		? 1
		: (() => {
				switch (brand) {
					case "wezterm":
					case "iterm2":
					case "vscode":
					case "cursor":
					case "windsurf":
					case "zed":
						return 1;
					case "apple-terminal":
					case "warp":
					case "alacritty":
					case "rio":
					case "foot":
					case "ghostty":
					case "kitty":
						return 3;
					default:
						return DEFAULT_EVENTS_PER_TICK;
				}
			})();

	let wheelLinesPerTick = remuxed ? 1 : brand === "iterm2" || brand === "wezterm" ? 1 : DEFAULT_WHEEL_LINES_PER_TICK;

	let trackpadLinesPerTick = embedded ? 15 : DEFAULT_TRACKPAD_LINES_PER_TICK;

	const lines = envNumber(env, "Z_AGENT_SCROLL_LINES");
	if (lines !== undefined && lines >= 1) {
		wheelLinesPerTick = Math.trunc(lines);
		trackpadLinesPerTick = Math.trunc(lines);
	}
	const ept = envNumber(env, "Z_AGENT_SCROLL_EPT");
	if (ept !== undefined && ept >= 1) {
		eventsPerTick = Math.trunc(ept);
	}

	const rawMode = env.Z_AGENT_SCROLL_MODE;
	const mode: ScrollInputMode = rawMode === "wheel" || rawMode === "trackpad" ? rawMode : "auto";
	const speed = envNumber(env, "Z_AGENT_SCROLL_SPEED");

	return {
		eventsPerTick: Math.max(1, eventsPerTick),
		wheelLinesPerTick: Math.max(1, wheelLinesPerTick),
		trackpadLinesPerTick: Math.max(1, trackpadLinesPerTick),
		trackpadAccelMax: TRACKPAD_ACCEL_MAX,
		mode,
		wheelTickDetectMaxMs: DEFAULT_WHEEL_TICK_DETECT_MAX_MS,
		wheelLikeMaxDurationMs: DEFAULT_WHEEL_LIKE_MAX_DURATION_MS,
		invertDirection: env.Z_AGENT_SCROLL_INVERT === "1" || env.Z_AGENT_SCROLL_INVERT === "on",
		accelIntervalFastMs: remuxed ? ACCEL_INTERVAL_FAST_MS : embedded ? 25 : ACCEL_INTERVAL_FAST_MS,
		accelIntervalMediumMs: remuxed ? ACCEL_INTERVAL_MEDIUM_MS : embedded ? 50 : ACCEL_INTERVAL_MEDIUM_MS,
		trackpadDetectMaxIntervalMs: remuxed
			? DEFAULT_TRACKPAD_DETECT_MAX_INTERVAL_MS
			: embedded
				? 60
				: DEFAULT_TRACKPAD_DETECT_MAX_INTERVAL_MS,
		speedMultiplier: speed === undefined ? 1 : speedToMultiplier(speed),
		viewportRows,
	};
}

/** Output from scroll handling: lines to apply plus when to check for stream end. */
export interface ScrollUpdate {
	lines: number;
	/** ms until the state machine next wants a tick; undefined = clock off. */
	nextTickMs: number | undefined;
}

type ScrollStreamKind = "unknown" | "wheel" | "trackpad";

function directionSign(direction: ScrollDirection): number {
	return direction === "up" ? -1 : 1;
}

/**
 * Whole lines a flush may deliver at once: half the viewport, floored so tiny
 * viewports still move. Legit wheel never reaches it; only misclassified
 * floods or extreme speed do, and those are paced across slots.
 */
function flushCap(config: ScrollConfig): number {
	return Math.max(Math.trunc(config.viewportRows / 2), MIN_DELTA_PER_FLUSH);
}

interface ScrollStream {
	start: number;
	last: number;
	direction: ScrollDirection;
	eventCount: number;
	accumulatedEvents: number;
	appliedLines: number;
	config: ScrollConfig;
	kind: ScrollStreamKind;
	justPromoted: boolean;
	/** Rolling window of inter-event intervals (ms) for acceleration. */
	intervalHistory: number[];
	intervalSum: number;
	/**
	 * Sum of per-event accel-weighted contributions (each event's sign times
	 * the multiplier in effect when it arrived). Monotone in magnitude within
	 * a stream; confirmed-trackpad demand is truncated at accumulation time.
	 */
	accelWeightedEvents: number;
	/** Updates only on nonzero flushes; a flush with no new events is a coast. */
	eventsAtFlush: number;
	/**
	 * Whole lines delivered by coast flushes, budgeted at one flushCap per
	 * stream: total motion after input stops is at most one cap, tapered.
	 */
	coastSpent: number;
}

function newStream(now: number, direction: ScrollDirection, config: ScrollConfig): ScrollStream {
	return {
		start: now,
		last: now,
		direction,
		eventCount: 0,
		accumulatedEvents: 0,
		appliedLines: 0,
		config,
		kind: "unknown",
		justPromoted: false,
		intervalHistory: [],
		intervalSum: 0,
		accelWeightedEvents: 0,
		eventsAtFlush: 0,
		coastSpent: 0,
	};
}

function pushEvent(stream: ScrollStream, now: number, direction: ScrollDirection): void {
	const intervalMs = now - stream.last;
	if (stream.eventCount > 0 && intervalMs >= ACCEL_MIN_INTERVAL_MS) {
		stream.intervalHistory.push(intervalMs);
		stream.intervalSum += intervalMs;
		if (stream.intervalHistory.length > ACCEL_HISTORY_SIZE) {
			stream.intervalSum -= stream.intervalHistory.shift() ?? 0;
		}
	}
	stream.last = now;
	stream.direction = direction;
	stream.eventCount += 1;
	stream.accumulatedEvents += directionSign(direction);
	// Weight each event by the multiplier in effect when it arrived, so a
	// mid-gesture accel decay can never shrink past contributions.
	stream.accelWeightedEvents += directionSign(direction) * intervalAccel(stream);
	if (isConfirmedTrackpad(stream)) {
		clampTrackpadDemand(stream);
	}
}

function avgIntervalMs(stream: ScrollStream): number | undefined {
	return stream.intervalHistory.length === 0 ? undefined : stream.intervalSum / stream.intervalHistory.length;
}

/** Interval-based acceleration multiplier. Fast events get a higher multiplier. */
function intervalAccel(stream: ScrollStream): number {
	const avg = avgIntervalMs(stream);
	if (avg === undefined) {
		return ACCEL_MULTIPLIER_BASE;
	}
	const fast = stream.config.accelIntervalFastMs;
	const medium = stream.config.accelIntervalMediumMs;
	const raw =
		avg <= fast
			? ACCEL_MULTIPLIER_FAST
			: avg <= medium
				? ACCEL_MULTIPLIER_FAST +
					((avg - fast) / (medium - fast)) * (ACCEL_MULTIPLIER_MEDIUM - ACCEL_MULTIPLIER_FAST)
				: ACCEL_MULTIPLIER_BASE;
	return Math.max(ACCEL_MULTIPLIER_BASE, Math.min(raw, stream.config.trackpadAccelMax));
}

function maybePromoteKind(stream: ScrollStream, now: number): void {
	if (stream.config.mode !== "auto" || stream.kind !== "unknown") {
		return;
	}
	const eventsPerTick = Math.max(1, stream.config.eventsPerTick);
	// ept=1 terminals: a wheel notch is 1 event at ~50-100ms intervals; trackpad
	// events arrive more rapidly.
	if (
		eventsPerTick <= 1 &&
		stream.eventCount > 2 &&
		(avgIntervalMs(stream) ?? Number.POSITIVE_INFINITY) < stream.config.trackpadDetectMaxIntervalMs
	) {
		stream.kind = "trackpad";
		return;
	}
	if (eventsPerTick >= 2 && stream.eventCount >= eventsPerTick) {
		if (now - stream.start <= stream.config.wheelTickDetectMaxMs) {
			stream.kind = "wheel";
			stream.justPromoted = true;
		}
	}
}

function finalizeKind(stream: ScrollStream): void {
	if (stream.config.mode === "wheel") {
		stream.kind = "wheel";
		return;
	}
	if (stream.config.mode === "trackpad") {
		stream.kind = "trackpad";
		return;
	}
	if (stream.kind !== "unknown") {
		return;
	}
	const duration = stream.last - stream.start;
	stream.kind =
		stream.config.eventsPerTick <= 1 && stream.eventCount <= 2 && duration <= stream.config.wheelLikeMaxDurationMs
			? "wheel"
			: "trackpad";
}

function isWheelLike(stream: ScrollStream): boolean {
	if (stream.config.mode === "wheel") {
		return true;
	}
	if (stream.config.mode === "trackpad") {
		return false;
	}
	// ept<=1 Auto: treat unknown as wheel until trackpad promotion fires.
	return stream.kind === "wheel" || (stream.kind === "unknown" && stream.config.eventsPerTick <= 1);
}

function effectiveLinesPerTick(stream: ScrollStream): number {
	if (stream.config.mode === "wheel") {
		return stream.config.wheelLinesPerTick;
	}
	if (stream.config.mode === "trackpad") {
		return stream.config.trackpadLinesPerTick;
	}
	if (stream.kind === "wheel") {
		return stream.config.wheelLinesPerTick;
	}
	if (stream.kind === "trackpad") {
		return stream.config.trackpadLinesPerTick;
	}
	// For ept<=1 terminals, assume an unclassified event is a wheel notch.
	return stream.config.eventsPerTick <= 1 ? stream.config.wheelLinesPerTick : stream.config.trackpadLinesPerTick;
}

function isConfirmedTrackpad(stream: ScrollStream): boolean {
	if (stream.config.mode === "trackpad") {
		return true;
	}
	if (stream.config.mode === "wheel") {
		return false;
	}
	return stream.kind === "trackpad";
}

/** Final-line units one weighted trackpad event prices to. */
function trackpadLineRate(stream: ScrollStream): number {
	return (effectiveLinesPerTick(stream) / DEFAULT_EVENTS_PER_TICK) * stream.config.speedMultiplier;
}

/**
 * Accel past one cap of backlog never enters desired: it could only arrive
 * after the fingers stop. Raw-pricing floor keeps the accel-free total.
 */
function clampTrackpadDemand(stream: ScrollStream): void {
	const rate = trackpadLineRate(stream);
	if (rate <= 0) {
		return;
	}
	const rawLines = Math.abs(stream.accumulatedEvents) * rate;
	const honorable = Math.abs(stream.appliedLines) + flushCap(stream.config);
	const ceiling = Math.max(rawLines, honorable);
	if (Math.abs(stream.accelWeightedEvents) * rate > ceiling) {
		stream.accelWeightedEvents = (Math.sign(stream.accelWeightedEvents) * ceiling) / rate;
	}
}

function desiredLines(stream: ScrollStream, carryLines: number): number {
	// Confirmed trackpad normalizes to the ept=3 divisor so all terminals get
	// the same base scroll rate; unknown streams use the terminal's real ept.
	const eventsPerTick = isConfirmedTrackpad(stream) ? DEFAULT_EVENTS_PER_TICK : stream.config.eventsPerTick;
	const linesPerTick = effectiveLinesPerTick(stream);
	if (isConfirmedTrackpad(stream)) {
		return stream.accelWeightedEvents * (linesPerTick / eventsPerTick) * stream.config.speedMultiplier + carryLines;
	}
	return stream.accumulatedEvents * (linesPerTick / eventsPerTick) * stream.config.speedMultiplier;
}

/** A flush is a COAST flush when no events arrived since the last line-delivering flush. */
function coasting(stream: ScrollStream): boolean {
	return stream.eventCount === stream.eventsAtFlush;
}

/**
 * Whole-line delta a flush right now would apply, before the per-flush cap:
 * truncated desired minus applied, with the wheel-like minimum-line
 * substitution and the direction clamp.
 */
function effectivePending(stream: ScrollStream, carryLines: number): number {
	let desired = Math.trunc(desiredLines(stream, carryLines));
	// Wheel-like streams always deliver at least one line per gesture.
	if (isWheelLike(stream) && desired === 0 && stream.accumulatedEvents !== 0) {
		desired = Math.sign(stream.accumulatedEvents) * MIN_LINES_PER_WHEEL_STREAM;
	}
	let delta = desired - stream.appliedLines;
	// Never flush against the gesture: promotion re-price can land desired
	// below applied; the clamp turns that into a pause, not a bounce.
	if (stream.accumulatedEvents > 0) {
		delta = Math.max(0, delta);
	} else if (stream.accumulatedEvents < 0) {
		delta = Math.min(0, delta);
	}
	return delta;
}

/**
 * Shared pending predicate for flush and deadline. Coast halves the remainder
 * per tick (deceleration, not a slam), floored at one tick of lines, budgeted
 * at one cap per stream.
 */
function flushableNow(stream: ScrollStream, carryLines: number): number {
	const pending = effectivePending(stream, carryLines);
	const cap = flushCap(stream.config);
	let magnitude: number;
	if (coasting(stream)) {
		const taper = Math.max(Math.trunc(Math.abs(pending) / 2), Math.trunc(effectiveLinesPerTick(stream)));
		magnitude = Math.min(Math.abs(pending), taper, Math.max(0, cap - stream.coastSpent));
	} else {
		magnitude = Math.min(Math.abs(pending), cap);
	}
	return Math.sign(pending) * magnitude;
}

/**
 * Mouse wheel/trackpad scroll normalization state. Callers feed scroll events
 * via `onScroll`, apply `update.lines` to the viewport, and arm a timer for
 * `update.nextTickMs` that calls `onTick` to flush residual lines and detect
 * the stream-ending gap.
 */
export class MouseScrollState {
	private stream: ScrollStream | undefined;
	private lastRedrawAt = 0;
	/** Sub-line remainder across same-direction streams (final line units). */
	private carryLines = 0;
	private carryDirection: ScrollDirection | undefined;
	private readonly redrawCadenceMs: number;

	constructor(redrawCadenceMs = Number(process.env.Z_AGENT_SCROLL_CADENCE_MS) || REDRAW_CADENCE_MS) {
		this.redrawCadenceMs = redrawCadenceMs > 0 ? redrawCadenceMs : REDRAW_CADENCE_MS;
	}

	onScroll(direction: ScrollDirection, config: ScrollConfig, now = Date.now()): ScrollUpdate {
		const dir = config.invertDirection ? (direction === "up" ? "down" : "up") : direction;
		let lines = 0;

		if (this.stream) {
			const gap = now - this.stream.last;
			if (gap > STREAM_GAP_MS || this.stream.direction !== dir) {
				// Flip: cancel the old stream's backlog; reversal must be instant,
				// not preceded by a stale opposite-direction jump.
				const cancelBacklog = this.stream.direction !== dir;
				const stale = this.stream;
				this.stream = undefined;
				lines += this.finalizeStream(now, stale, cancelBacklog);
			}
		}

		if (!this.stream) {
			if (this.carryDirection !== dir) {
				this.carryLines = 0;
				this.carryDirection = dir;
			}
			this.stream = newStream(now, dir, config);
		}
		const stream = this.stream;
		const carryLines = this.carryLines;
		pushEvent(stream, now, dir);
		maybePromoteKind(stream, now);

		if (now - this.lastRedrawAt >= this.redrawCadenceMs || stream.justPromoted) {
			lines += this.flushLines(carryLines, now, stream);
			stream.justPromoted = false;
		}

		return { lines, nextTickMs: this.nextTickIn(now) };
	}

	/** Check whether an active stream has ended; flushes residual lines. */
	onTick(now = Date.now()): ScrollUpdate {
		let lines = 0;
		const stream = this.stream;
		if (stream) {
			const gap = now - stream.last;
			// Past the gap, defer finalize while a coast drain still has lines,
			// so the tail decays instead of bursting.
			if (gap > STREAM_GAP_MS && flushableNow(stream, this.carryLines) === 0) {
				this.stream = undefined;
				lines = this.finalizeStream(now, stream, false);
			} else {
				// Cadence-flush active streams so short bursts (especially on
				// ept=1 terminals) don't stall until the 80ms gap.
				if (now - this.lastRedrawAt >= this.redrawCadenceMs) {
					lines = this.flushLines(this.carryLines, now, stream);
				}
			}
		}
		return { lines, nextTickMs: this.nextTickIn(now) };
	}

	get hasActiveStream(): boolean {
		return this.stream !== undefined;
	}

	cancelStream(): void {
		this.stream = undefined;
		this.carryLines = 0;
		this.carryDirection = undefined;
	}

	/** Direction flips discard the backlog; gap/regrasp keeps the flush. */
	private finalizeStream(now: number, stream: ScrollStream, cancelBacklog: boolean): number {
		const carryAtFlush = this.carryLines;
		// The classification flip may re-price the stream, but must never mint
		// new demand after input ended (a post-gesture burst).
		const desiredBefore = desiredLines(stream, carryAtFlush);
		finalizeKind(stream);
		limitFinalizeReprice(stream, desiredBefore, carryAtFlush);
		// Any remaining catch-up is coast-shaped (no input since the last
		// flush), so flushLines tapers and budgets it.
		const lines = cancelBacklog ? 0 : this.flushLines(carryAtFlush, now, stream);

		if (stream.kind !== "wheel" && stream.config.mode !== "wheel") {
			// Only carry the sub-line fractional remainder, not the cap-induced
			// integer backlog — carrying whole lines would pollute the next
			// gesture with a burst it didn't earn.
			const remainder = desiredLines(stream, carryAtFlush) - stream.appliedLines;
			this.carryLines = remainder - Math.trunc(remainder);
		} else {
			this.carryLines = 0;
		}
		return lines;
	}

	private flushLines(carryLines: number, now: number, stream: ScrollStream): number {
		// A zero-delivery flush must not advance lastRedrawAt, or the clock
		// busy-spins. Every kind shares the cap; excess drains later.
		const delta = flushableNow(stream, carryLines);
		if (delta === 0) {
			return 0;
		}
		if (coasting(stream)) {
			stream.coastSpent += Math.abs(delta);
		}
		stream.appliedLines += delta;
		stream.eventsAtFlush = stream.eventCount;
		this.lastRedrawAt = now;
		return delta;
	}

	/** undefined = no tick needed; 0 = overdue. */
	private nextTickIn(now: number): number | undefined {
		const stream = this.stream;
		if (!stream) {
			return undefined;
		}
		const gap = now - stream.last;
		const flushable = flushableNow(stream, this.carryLines) !== 0;
		const sinceRedraw = now - this.lastRedrawAt;
		const untilRedraw = Math.max(0, this.redrawCadenceMs - sinceRedraw);

		if (gap > STREAM_GAP_MS) {
			// Post-gap tapered drain rides the redraw cadence until it runs dry;
			// only then does the deadline collapse to "finalize now".
			return flushable ? untilRedraw : undefined;
		}
		let next = STREAM_GAP_MS - gap;
		if (flushable) {
			next = Math.min(next, untilRedraw);
		}
		return next;
	}
}

/**
 * Unknown-to-trackpad reclassification must not mint demand after the fingers
 * stop. Upward re-price is undone; downward keeps the lower value.
 */
function limitFinalizeReprice(stream: ScrollStream, desiredBefore: number, carryLines: number): void {
	if (!isConfirmedTrackpad(stream)) {
		return;
	}
	const rate = trackpadLineRate(stream);
	if (rate <= 0) {
		return;
	}
	if (Math.abs(desiredLines(stream, carryLines)) > Math.abs(desiredBefore)) {
		stream.accelWeightedEvents = (desiredBefore - carryLines) / rate;
	}
}
