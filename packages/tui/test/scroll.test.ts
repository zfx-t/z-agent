import { describe, expect, it } from "vitest";
import {
	defaultScrollConfig,
	detectTerminalBrand,
	inMultiplexer,
	MouseScrollState,
	type ScrollConfig,
	speedToMultiplier,
} from "../src/scroll.ts";

function config(overrides: Partial<ScrollConfig> = {}): ScrollConfig {
	return {
		eventsPerTick: 3,
		wheelLinesPerTick: 3,
		trackpadLinesPerTick: 3,
		trackpadAccelMax: 3,
		mode: "auto",
		wheelTickDetectMaxMs: 12,
		wheelLikeMaxDurationMs: 200,
		invertDirection: false,
		accelIntervalFastMs: 8,
		accelIntervalMediumMs: 20,
		trackpadDetectMaxIntervalMs: 30,
		speedMultiplier: 1,
		viewportRows: 20,
		...overrides,
	};
}

describe("terminal detection", () => {
	it("detects brands and multiplexer re-encoding", () => {
		expect(detectTerminalBrand({ TERM_PROGRAM: "Apple_Terminal" })).toBe("apple-terminal");
		expect(detectTerminalBrand({ TERM_PROGRAM: "WezTerm" })).toBe("wezterm");
		expect(detectTerminalBrand({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
		expect(detectTerminalBrand({ TERM_PROGRAM: "vscode" })).toBe("vscode");
		expect(detectTerminalBrand({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
		expect(detectTerminalBrand({ TERM: "xterm-256color", VTE_VERSION: "7000" })).toBe("vte");
		expect(inMultiplexer({ TMUX: "/tmp/tmx" })).toBe(true);
		expect(inMultiplexer({ TERM: "screen-256color" })).toBe(true);
		expect(inMultiplexer({ TERM: "xterm-256color" })).toBe(false);
	});

	it("prices one event per notch when a multiplexer re-encodes SGR", () => {
		const mux = defaultScrollConfig({ TMUX: "1", TERM_PROGRAM: "ghostty" });
		expect(mux.eventsPerTick).toBe(1);
		expect(mux.wheelLinesPerTick).toBe(1);
		const ghostty = defaultScrollConfig({ TERM_PROGRAM: "ghostty" });
		expect(ghostty.eventsPerTick).toBe(3);
		const vscode = defaultScrollConfig({ TERM_PROGRAM: "vscode" });
		expect(vscode.eventsPerTick).toBe(1);
		expect(vscode.trackpadLinesPerTick).toBe(15);
	});

	it("maps scroll speed 1-100 to 0.1x-6x", () => {
		expect(speedToMultiplier(50)).toBeCloseTo(1);
		expect(speedToMultiplier(1)).toBeCloseTo(0.1);
		expect(speedToMultiplier(100)).toBeCloseTo(6);
	});
});

describe("MouseScrollState", () => {
	it("normalizes an ept=3 wheel notch to a fixed line count", () => {
		const state = new MouseScrollState();
		const cfg = config();
		let lines = 0;
		for (let i = 0; i < 3; i += 1) {
			lines += state.onScroll("down", cfg, 1000 + i * 3).lines;
		}
		// One notch = 3 events = 3 lines once promotion fires.
		expect(lines).toBe(3);
	});

	it("delivers at least one line per wheel gesture on ept=1 terminals", () => {
		const state = new MouseScrollState();
		// ept=1 brands price one line per notch (WezTerm/iTerm2 profile).
		const update = state.onScroll("up", config({ eventsPerTick: 1, wheelLinesPerTick: 1 }), 1000);
		expect(update.lines).toBe(-1);
	});

	it("caps each flush at half the viewport while a flick pours events in", () => {
		const state = new MouseScrollState();
		// Extreme speed: demand far exceeds any single cadence slot.
		const cfg = config({ eventsPerTick: 1, speedMultiplier: 6, viewportRows: 20 });
		let total = 0;
		for (let i = 0; i < 30; i += 1) {
			const update = state.onScroll("down", cfg, 1000 + i * 10);
			expect(update.lines).toBeLessThanOrEqual(10);
			total += update.lines;
		}
		expect(total).toBeGreaterThan(10);
		expect(state.hasActiveStream).toBe(true);
	});

	it("drains residual backlog on ticks with a tapered coast", () => {
		const state = new MouseScrollState();
		// High-speed trackpad demand outruns the per-flush cap, leaving a
		// backlog the 16ms tick drains after input stops.
		const cfg = config({ eventsPerTick: 1, speedMultiplier: 6, trackpadDetectMaxIntervalMs: 30 });
		for (let i = 0; i < 12; i += 1) {
			state.onScroll("down", cfg, 1000 + i * 10);
		}
		let drained = 0;
		for (let t = 1200; t < 1600; t += 16) {
			drained += state.onTick(t).lines;
		}
		expect(drained).toBeGreaterThan(0);
	});

	it("cancels the stale backlog instantly on direction flip", () => {
		const state = new MouseScrollState();
		const cfg = config({ eventsPerTick: 1, speedMultiplier: 6 });
		for (let i = 0; i < 10; i += 1) {
			state.onScroll("down", cfg, 1000 + i * 10);
		}
		const flip = state.onScroll("up", cfg, 1104);
		// Reversal starts a fresh stream: at most the fresh event's own lines,
		// never a burst of stale downward catch-up.
		expect(flip.lines).toBeLessThanOrEqual(0);
	});

	it("separates gestures by the 80ms stream gap", () => {
		const state = new MouseScrollState();
		const cfg = config();
		state.onScroll("down", cfg, 1000);
		state.onScroll("down", cfg, 1003);
		state.onScroll("down", cfg, 1006);
		expect(state.hasActiveStream).toBe(true);
		state.onTick(1100);
		expect(state.hasActiveStream).toBe(false);
	});

	it("inverts direction when configured", () => {
		const state = new MouseScrollState();
		const update = state.onScroll(
			"up",
			config({ eventsPerTick: 1, wheelLinesPerTick: 1, invertDirection: true }),
			1000,
		);
		expect(update.lines).toBe(1);
	});
});
