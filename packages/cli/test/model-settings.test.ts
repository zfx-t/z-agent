import { describe, expect, it } from "vitest";
import {
	formatCompactContext,
	formatListModelsLine,
	formatModelSettings,
	formatRuntimeStatus,
	MODEL_COMMAND_USAGE,
	modelSettingsView,
	parseModelCommand,
	reduceModelSettings,
} from "../src/model-settings.ts";

const aliasView = modelSettingsView({
	hasModel: true,
	alias: "fast",
	id: "gpt-4.1-mini",
	thinking: "off",
	contextWindow: 128_000,
	maxTokens: 4_096,
});

describe("parseModelCommand", () => {
	it("inspects and sets validated fields", () => {
		expect(parseModelCommand("")).toEqual({ kind: "inspect" });
		expect(parseModelCommand("  ")).toEqual({ kind: "inspect" });
		expect(parseModelCommand("context 200000")).toEqual({ kind: "set", field: "context", value: 200_000 });
		expect(parseModelCommand("max-tokens 8192")).toEqual({ kind: "set", field: "max-tokens", value: 8_192 });
		expect(parseModelCommand("thinking high")).toEqual({ kind: "set", field: "thinking", value: "high" });
	});

	it("rejects unknown verbs and non-positive integers", () => {
		expect(parseModelCommand("switch fast")).toEqual({ kind: "error", message: MODEL_COMMAND_USAGE });
		expect(parseModelCommand("context")).toEqual({ kind: "error", message: MODEL_COMMAND_USAGE });
		expect(parseModelCommand("context 0")).toEqual({ kind: "error", message: MODEL_COMMAND_USAGE });
		expect(parseModelCommand("context 12.5")).toEqual({ kind: "error", message: MODEL_COMMAND_USAGE });
		expect(parseModelCommand("context 12345678901234567890")).toEqual({
			kind: "error",
			message: MODEL_COMMAND_USAGE,
		});
		expect(parseModelCommand("thinking loud")).toEqual({ kind: "error", message: MODEL_COMMAND_USAGE });
	});
});

describe("formatters", () => {
	it("renders inspect, status, compact, and list lines", () => {
		expect(formatModelSettings(aliasView)).toBe(
			"[model] alias=fast id=gpt-4.1-mini thinking=off contextWindow=128000 maxTokens=4096 persist=alias",
		);
		expect(
			formatModelSettings(
				modelSettingsView({
					hasModel: true,
					id: "gpt-4.1",
					thinking: "medium",
				}),
			),
		).toBe("[model] id=gpt-4.1 thinking=medium contextWindow=unknown maxTokens=unknown persist=session");
		expect(formatModelSettings(modelSettingsView({ hasModel: false }))).toBe("[model] none");
		expect(
			formatRuntimeStatus({
				view: aliasView,
				skillsMode: "progressive",
				skillsActive: 2,
				cwd: "/tmp/app",
			}),
		).toBe(
			"[status] model=fast(gpt-4.1-mini) thinking=off contextWindow=128000 maxTokens=4096 persist=alias skills=progressive:2 cwd=/tmp/app",
		);
		expect(formatCompactContext(128_000)).toBe("128k");
		expect(formatCompactContext(200_000)).toBe("200k");
		expect(formatCompactContext(2_000_000)).toBe("2m");
		expect(formatCompactContext(128_001)).toBe("128001");
		expect(formatCompactContext(0)).toBe("unknown");
		expect(formatCompactContext(undefined)).toBe("unknown");
		expect(
			formatListModelsLine({
				alias: "fast",
				id: "gpt-4.1-mini",
				contextWindow: 128_000,
				maxTokens: 4_096,
				thinking: "off",
				isDefault: true,
			}),
		).toBe("fast\tgpt-4.1-mini\t128000\t4096\toff *");
		expect(formatListModelsLine({ alias: "smart", id: "gpt-5", thinking: "high" })).toBe("smart\tgpt-5\t-\t-\thigh");
	});
});

describe("reduceModelSettings", () => {
	it("updates one field and marks alias persist", () => {
		const result = reduceModelSettings(aliasView, "context 200000");
		expect(result).toEqual({
			kind: "updated",
			view: { ...aliasView, contextWindow: 200_000 },
			text: "[model] alias=fast id=gpt-4.1-mini thinking=off contextWindow=200000 maxTokens=4096 persist=alias",
			persistPatch: { contextWindow: 200_000 },
		});
	});

	it("keeps raw ids session-only", () => {
		const raw = modelSettingsView({ hasModel: true, id: "gpt-4.1", thinking: "off", contextWindow: 64_000 });
		const result = reduceModelSettings(raw, "max-tokens 1024");
		expect(result.kind).toBe("updated");
		if (result.kind === "updated") {
			expect(result.view.persist).toBe("session");
			expect(result.view.maxTokens).toBe(1024);
			expect(result.persistPatch).toBeUndefined();
			expect(result.text).toContain("persist=session");
		}
	});

	it("inspects and surfaces parse errors", () => {
		expect(reduceModelSettings(aliasView, "")).toEqual({
			kind: "inspect",
			text: formatModelSettings(aliasView),
		});
		expect(reduceModelSettings(aliasView, "nope")).toEqual({ kind: "error", message: MODEL_COMMAND_USAGE });
	});
});
