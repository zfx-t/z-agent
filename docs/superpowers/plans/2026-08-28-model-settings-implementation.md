# Model Settings Inspect and Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator see and change the live model's `contextWindow`, `maxTokens`, and `thinking` from TUI and print surfaces, and persist alias-backed edits to `~/.pillow/config.json`.

**Architecture:** Keep the ADR-0022 alias catalog as the source of truth. Add a filesystem-free reducer in `@z-agent/cli` that formats and edits a `ModelSettingsView`. `@z-agent/cli` applies the next view to `Agent` state, provider `maxTokens`, and `SkillManager` budget. Alias edits reload-and-write `config.json` (`0600`). `@z-agent/tui` only renders an optional compact `ctx` header field. `@z-agent/agent` stays filesystem-free.

**Tech Stack:** TypeScript 5.9 (erasable syntax), Node.js 22+, Vitest, Biome, existing `@z-agent/agent` / `@z-agent/ai` / `@z-agent/tui` packages. No new dependencies.

## Outcome Contract

```text
User: Coding-agent operator
Trigger / real entrypoint: Interactive TUI (`z-agent`) and `--list-models` / print banner
Primary journey: /status and /model show contextWindow, maxTokens, thinking; /model context|max-tokens|thinking changes the live run; alias-backed values reappear after restart
Observable success: Inspect lines contain the numeric window and output cap; an edit is visible in /model and, for an alias, in config.json; the next provider/skills turn uses the new values
Non-goals: Switching model aliases at runtime, temperature/samplingParams, provider-reported usage meters, fetching context size from the vendor API, a --thinking flag (ADR-0022 forbids it)
Constraints and dependencies: ADR-0022 catalog shape and precedence; never render apiKey; in-flight skills snapshot stays immutable
Proof method: Focused Vitest files for the new reducer, config persist, slash validation, skill budget, TUI header, and args; then `npm run check`; then `--list-models` plus a TUI /model inspect+edit
```

## Global Constraints

- Node `>=22`; run `npm install --ignore-scripts` only if dependencies change (they should not).
- Erasable TypeScript only: no parameter properties, `enum`, `namespace`, or `import =`.
- Relative imports include `.ts` extensions; do not add dependencies.
- `@z-agent/agent` must not gain filesystem, config, TUI, or skills imports.
- Only `streamAssistant` and `tool.execute` remain agent-core effect boundaries.
- Never log or render `apiKey`.
- Existing uncommitted skills/TUI work is user-owned; patch around it and do not revert it.
- Do not create commits unless the user explicitly asks. Stage no files during implementation. Skip every Commit step below unless asked.

---

## File Map

| File | Responsibility |
| --- | --- |
| Create `packages/cli/src/model-settings.ts` | Pure inspect/edit reducer: parse `/model` args, format status lines, produce the next `ModelSettingsView`. No filesystem. |
| Create `packages/cli/test/model-settings.test.ts` | Unit tests for parse, format, compact window, and reduce. |
| Modify `packages/cli/src/config.ts` | Resolve CLI/env overrides for `contextWindow`/`maxTokens`; `saveCatalog`; `updateAliasSettings`; `persistAliasSettings`. |
| Modify `packages/cli/test/config.test.ts` | Persist + precedence tests. |
| Modify `packages/cli/src/args.ts` | `--context-window` and `--max-tokens` flags and help text. |
| Modify `packages/cli/test/args.test.ts` | Flag parse + help coverage. |
| Modify `packages/cli/src/skill-manager.ts` | `setBudget` updates private window/cap and rebuilds the current snapshot budget without wiping activations. |
| Modify `packages/cli/test/skill-manager.test.ts` | Budget change applies to the next `prepareContext` and leaves an old snapshot immutable. |
| Modify `packages/cli/src/interactive-commands.ts` | Register `/model`. |
| Modify `packages/cli/src/slash.ts` | Validate `/model` args through `parseModelCommand`. |
| Modify `packages/cli/test/slash.test.ts` | `/model` builtin + usage errors. |
| Modify `packages/cli/src/interactive.ts` | `/status` prints the live settings line; `/model` calls an injected handler. |
| Modify `packages/cli/src/cli.ts` | Live view, apply to Agent + SkillManager, persist alias, richer `--list-models` and print banner, pass `Agent.maxTokens` at launch. |
| Modify `packages/cli/src/compaction.ts` | Non-positive `contextWindow` falls back to `DEFAULT_WINDOW`. |
| Modify `packages/cli/test/compaction.test.ts` | Cover the `0` window fallback. |
| Modify `packages/tui/src/model.ts` | Optional `context` on `TuiHeaderState`. |
| Modify `packages/tui/src/layout.ts` | Render `ctx: …` after `model`. |
| Modify `packages/tui/test/tui.test.ts` | Header includes `ctx` when provided. |
| Modify `packages/cli/test/smoke.test.ts` | `--list-models` still lists starter alias and now shows the starter window. |
| Modify `packages/cli/README.md`, `packages/cli/src/args.ts` help, `docs/roadmap.md`, `docs/glossary.md` | Document inspect/edit surfaces. |

## Locked Product Decisions

1. **Inspected fields:** `alias` (if any), `id`, `thinking`, `contextWindow`, `maxTokens`, `persist`. Missing, `0`, or non-finite window/cap render as `unknown`. Do not invent a runtime default window for skills or display.
2. **Edit syntax (only these):**
   - `/model` → inspect
   - `/model context <positive-int>`
   - `/model max-tokens <positive-int>`
   - `/model thinking off|minimal|low|medium|high|xhigh|max`
3. **Persist:** if the live view has an `alias` that exists in the catalog, reload `config.json`, patch that alias, write `0600`. Raw model ids stay `persist=session` and print a notice. Do not create aliases. Do not add `/model persist`.
4. **Apply now, take effect on the next provider call / next skills snapshot.** The in-flight skills snapshot stays immutable (same rule as `/reload`).
5. **Launch overrides complete ADR-0022 precedence** for these two numeric fields: `--context-window` / `--max-tokens` > `OPENAI_CONTEXT_WINDOW` / `OPENAI_MAX_TOKENS` > catalog entry. No `--thinking` flag. No silent built-in numeric default for a raw id.
6. **Provider cap:** today catalog `maxTokens` is copied onto `Model` but not onto `Agent.maxTokens`, so the Responses `max_output_tokens` path ignores it. Launch and `/model max-tokens` must set both `agent.state.model.maxTokens` and `agent.maxTokens`.
7. **TUI header:** optional `context` string, compact form (`128k` / `200k` / `unknown`). Full numbers live in `/status` and `/model`.
8. **`--list-models` columns:** `alias`, `id`, `contextWindow`, `maxTokens`, `thinking`, default `*`. Missing numbers print `-`.
9. **Out of scope:** runtime model switch, temperature, usage meters, vendor model-card fetch, session-file storage of overrides.

## Contract Map

Later tasks must use these names. Do not invent aliases such as `ctxWindow`, `outputTokens`, or `/context`.

```ts
// packages/cli/src/model-settings.ts
import type { ThinkingLevel } from "@z-agent/ai";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_COMMAND_USAGE =
	"Usage: /model, /model context <n>, /model max-tokens <n>, or /model thinking off|minimal|low|medium|high|xhigh|max";

export type ModelPersistMode = "alias" | "session";

export interface ModelSettingsView {
	hasModel: boolean;
	alias?: string;
	id: string;
	thinking: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
	persist: ModelPersistMode;
}

export type ParsedModelCommand =
	| { kind: "inspect" }
	| { kind: "set"; field: "context"; value: number }
	| { kind: "set"; field: "max-tokens"; value: number }
	| { kind: "set"; field: "thinking"; value: ThinkingLevel }
	| { kind: "error"; message: string };

export interface AliasSettingsPatch {
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
}

export type ModelSettingsResult =
	| { kind: "inspect"; text: string }
	| { kind: "updated"; view: ModelSettingsView; text: string; persistPatch?: AliasSettingsPatch }
	| { kind: "error"; message: string };

export function isThinkingLevel(value: string): value is ThinkingLevel;
export function finitePositiveInt(value: unknown): value is number;
export function modelSettingsView(input: {
	hasModel: boolean;
	alias?: string;
	id?: string;
	thinking?: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
}): ModelSettingsView;
export function parseModelCommand(args: string): ParsedModelCommand;
export function formatModelSettings(view: ModelSettingsView): string;
export function formatRuntimeStatus(input: {
	view: ModelSettingsView;
	skillsMode: string;
	skillsActive: number;
	cwd: string;
}): string;
export function formatCompactContext(window?: number): string;
export function formatListModelsLine(input: {
	alias: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
	isDefault?: boolean;
}): string;
export function reduceModelSettings(view: ModelSettingsView, args: string): ModelSettingsResult;
```

```ts
// packages/cli/src/config.ts additions
export interface ModelNumericOverrides {
	contextWindow?: number;
	maxTokens?: number;
}

export function resolveModel(
	ref: string | undefined,
	catalog: PillowCatalog | undefined,
	env?: NodeJS.ProcessEnv,
	overrides?: ModelNumericOverrides,
): ModelResolution;

export function updateAliasSettings(
	catalog: PillowCatalog,
	alias: string,
	patch: AliasSettingsPatch,
): PillowCatalog;

export async function saveCatalog(userPillow: string, catalog: PillowCatalog): Promise<void>;
export async function persistAliasSettings(
	userPillow: string,
	alias: string,
	patch: AliasSettingsPatch,
): Promise<void>;
```

```ts
// packages/cli/src/skill-manager.ts addition
export interface SkillManager {
	setBudget(budget: { contextWindow?: number; maxTokens?: number }): void;
}
```

```ts
// packages/tui/src/model.ts
export interface TuiHeaderState {
	cwd: string;
	model: string;
	session: string;
	context?: string;
}
```

---

### Task 1: Pure model settings reducer

**Files:**
- Create: `packages/cli/src/model-settings.ts`
- Test: `packages/cli/test/model-settings.test.ts`

**Interfaces:**
- Consumes: `ThinkingLevel` from `@z-agent/ai`
- Produces: the Contract Map functions in `model-settings.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/model-settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	MODEL_COMMAND_USAGE,
	formatCompactContext,
	formatListModelsLine,
	formatModelSettings,
	formatRuntimeStatus,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @z-agent/cli -- test/model-settings.test.ts`

Expected: FAIL with `Cannot find module '../src/model-settings.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/model-settings.ts`:

```ts
import type { ThinkingLevel } from "@z-agent/ai";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_COMMAND_USAGE =
	"Usage: /model, /model context <n>, /model max-tokens <n>, or /model thinking off|minimal|low|medium|high|xhigh|max";

export type ModelPersistMode = "alias" | "session";

export interface ModelSettingsView {
	hasModel: boolean;
	alias?: string;
	id: string;
	thinking: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
	persist: ModelPersistMode;
}

export type ParsedModelCommand =
	| { kind: "inspect" }
	| { kind: "set"; field: "context"; value: number }
	| { kind: "set"; field: "max-tokens"; value: number }
	| { kind: "set"; field: "thinking"; value: ThinkingLevel }
	| { kind: "error"; message: string };

export interface AliasSettingsPatch {
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
}

export type ModelSettingsResult =
	| { kind: "inspect"; text: string }
	| { kind: "updated"; view: ModelSettingsView; text: string; persistPatch?: AliasSettingsPatch }
	| { kind: "error"; message: string };

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
}

export function finitePositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

function optionalPositive(value: number | undefined): number | undefined {
	return finitePositiveInt(value) ? value : undefined;
}

export function modelSettingsView(input: {
	hasModel: boolean;
	alias?: string;
	id?: string;
	thinking?: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
}): ModelSettingsView {
	if (!input.hasModel) {
		return { hasModel: false, id: "none", thinking: "off", persist: "session" };
	}
	const alias = input.alias?.trim();
	return {
		hasModel: true,
		...(alias ? { alias } : {}),
		id: input.id?.trim() || "unknown",
		thinking: input.thinking ?? "off",
		...(optionalPositive(input.contextWindow) !== undefined
			? { contextWindow: optionalPositive(input.contextWindow) }
			: {}),
		...(optionalPositive(input.maxTokens) !== undefined ? { maxTokens: optionalPositive(input.maxTokens) } : {}),
		persist: alias ? "alias" : "session",
	};
}

function splitArgs(args: string): { first: string; rest: string } {
	const trimmed = args.trim();
	const separator = trimmed.search(/\s/u);
	return separator < 0
		? { first: trimmed, rest: "" }
		: { first: trimmed.slice(0, separator), rest: trimmed.slice(separator).trimStart() };
}

function parsePositiveIntToken(token: string): number | undefined {
	if (!/^\d+$/u.test(token)) {
		return undefined;
	}
	const value = Number(token);
	return finitePositiveInt(value) ? value : undefined;
}

export function parseModelCommand(args: string): ParsedModelCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { kind: "inspect" };
	}
	const { first, rest } = splitArgs(trimmed);
	if (first === "context" || first === "max-tokens") {
		const value = parsePositiveIntToken(rest);
		if (value === undefined || rest.includes(" ")) {
			return { kind: "error", message: MODEL_COMMAND_USAGE };
		}
		return { kind: "set", field: first, value };
	}
	if (first === "thinking" && isThinkingLevel(rest)) {
		return { kind: "set", field: "thinking", value: rest };
	}
	return { kind: "error", message: MODEL_COMMAND_USAGE };
}

function renderCount(value: number | undefined): string {
	return optionalPositive(value) === undefined ? "unknown" : String(value);
}

export function formatModelSettings(view: ModelSettingsView): string {
	if (!view.hasModel) {
		return "[model] none";
	}
	const alias = view.alias ? `alias=${view.alias} ` : "";
	return `[model] ${alias}id=${view.id} thinking=${view.thinking} contextWindow=${renderCount(view.contextWindow)} maxTokens=${renderCount(view.maxTokens)} persist=${view.persist}`;
}

export function formatRuntimeStatus(input: {
	view: ModelSettingsView;
	skillsMode: string;
	skillsActive: number;
	cwd: string;
}): string {
	const label = !input.view.hasModel
		? "none"
		: input.view.alias
			? `${input.view.alias}(${input.view.id})`
			: input.view.id;
	return `[status] model=${label} thinking=${input.view.thinking} contextWindow=${renderCount(input.view.contextWindow)} maxTokens=${renderCount(input.view.maxTokens)} persist=${input.view.persist} skills=${input.skillsMode}:${input.skillsActive} cwd=${input.cwd}`;
}

export function formatCompactContext(window?: number): string {
	const value = optionalPositive(window);
	if (value === undefined) {
		return "unknown";
	}
	if (value >= 1_000_000 && value % 1_000_000 === 0) {
		return `${value / 1_000_000}m`;
	}
	if (value >= 1_000 && value % 1_000 === 0) {
		return `${value / 1_000}k`;
	}
	return String(value);
}

export function formatListModelsLine(input: {
	alias: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
	isDefault?: boolean;
}): string {
	const window = optionalPositive(input.contextWindow);
	const tokens = optionalPositive(input.maxTokens);
	const marker = input.isDefault ? " *" : "";
	return `${input.alias}\t${input.id}\t${window ?? "-"}\t${tokens ?? "-"}\t${input.thinking ?? "-"}${marker}`;
}

export function reduceModelSettings(view: ModelSettingsView, args: string): ModelSettingsResult {
	const parsed = parseModelCommand(args);
	if (parsed.kind === "error") {
		return parsed;
	}
	if (parsed.kind === "inspect") {
		return { kind: "inspect", text: formatModelSettings(view) };
	}
	if (!view.hasModel) {
		return { kind: "error", message: "no model in use" };
	}
	const next = { ...view };
	const persistPatch: AliasSettingsPatch = {};
	if (parsed.field === "context") {
		next.contextWindow = parsed.value;
		persistPatch.contextWindow = parsed.value;
	} else if (parsed.field === "max-tokens") {
		next.maxTokens = parsed.value;
		persistPatch.maxTokens = parsed.value;
	} else {
		next.thinking = parsed.value;
		persistPatch.thinking = parsed.value;
	}
	return {
		kind: "updated",
		view: next,
		text: formatModelSettings(next),
		...(next.persist === "alias" ? { persistPatch } : {}),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @z-agent/cli -- test/model-settings.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

Skip unless the user asked to commit.

```bash
git add packages/cli/src/model-settings.ts packages/cli/test/model-settings.test.ts
git commit -m "feat: add model settings inspect and edit reducer"
```

---

### Task 2: Catalog persist and numeric precedence

**Files:**
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/test/config.test.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/test/args.test.ts`

**Interfaces:**
- Consumes: `AliasSettingsPatch` from `./model-settings.ts`
- Produces: `ModelNumericOverrides`, `updateAliasSettings`, `saveCatalog`, `persistAliasSettings`; `resolveModel(..., overrides?)`; `CliArgs.contextWindow` / `CliArgs.maxTokens`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/config.test.ts` (keep the existing describe blocks):

```ts
import { persistAliasSettings, saveCatalog, updateAliasSettings } from "../src/config.ts";

describe("alias settings persist", () => {
	it("patches one alias without dropping siblings or apiKey", () => {
		const catalog = {
			version: 1 as const,
			defaultModel: "fast",
			models: {
				fast: { id: "gpt-4.1-mini", apiKey: "sk-keep", contextWindow: 128_000 },
				smart: { id: "gpt-5", thinking: "high" as const },
			},
		};
		const next = updateAliasSettings(catalog, "fast", { contextWindow: 200_000, maxTokens: 8_192 });
		expect(next.models.fast).toEqual({
			id: "gpt-4.1-mini",
			apiKey: "sk-keep",
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		expect(next.models.smart).toEqual({ id: "gpt-5", thinking: "high" });
	});

	it("writes 0600 and reloads the latest file before patching", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-pillow-save-"));
		await saveCatalog(dir, {
			version: 1,
			defaultModel: "fast",
			models: { fast: { id: "gpt-4.1-mini", apiKey: "sk-file", contextWindow: 128_000 } },
		});
		await persistAliasSettings(dir, "fast", { contextWindow: 256_000, thinking: "low" });
		const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf-8"));
		expect(raw.models.fast).toMatchObject({
			id: "gpt-4.1-mini",
			apiKey: "sk-file",
			contextWindow: 256_000,
			thinking: "low",
		});
	});

	it("prefers CLI overrides, then env, then catalog", () => {
		const catalog = parseCatalog(
			JSON.stringify({
				version: 1,
				defaultModel: "fast",
				models: { fast: { id: "gpt-4.1-mini", contextWindow: 128_000, maxTokens: 4_096 } },
			}),
		).catalog;
		const file = resolveModel("fast", catalog, {});
		expect(file.hasModel && file.contextWindow).toBe(128_000);
		const env = resolveModel("fast", catalog, {
			OPENAI_CONTEXT_WINDOW: "200000",
			OPENAI_MAX_TOKENS: "2048",
		});
		expect(env.hasModel && env.contextWindow).toBe(200_000);
		expect(env.hasModel && env.maxTokens).toBe(2_048);
		const flag = resolveModel(
			"fast",
			catalog,
			{ OPENAI_CONTEXT_WINDOW: "200000", OPENAI_MAX_TOKENS: "2048" },
			{ contextWindow: 300_000, maxTokens: 512 },
		);
		expect(flag.hasModel && flag.contextWindow).toBe(300_000);
		expect(flag.hasModel && flag.maxTokens).toBe(512);
		const raw = resolveModel("gpt-4.1", catalog, {});
		expect(raw.hasModel && raw.contextWindow).toBeUndefined();
		expect(raw.hasModel && raw.maxTokens).toBeUndefined();
	});
});
```

Add to `packages/cli/test/args.test.ts` inside `describe("parseArgs")`:

```ts
	it("parses context window and max token flags", () => {
		const args = parseArgs(["--context-window", "200000", "--max-tokens", "8192"]);
		expect(args.contextWindow).toBe(200_000);
		expect(args.maxTokens).toBe(8_192);
		expect(parseArgs(["--context-window", "0"]).error).toBe("Invalid value for --context-window");
		expect(parseArgs(["--max-tokens"]).error).toBe("Missing value for --max-tokens");
	});
```

In the help test, add:

```ts
		expect(help).toContain("--context-window");
		expect(help).toContain("--max-tokens");
		expect(help).toContain("OPENAI_CONTEXT_WINDOW");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace @z-agent/cli -- test/config.test.ts test/args.test.ts`

Expected: FAIL — `updateAliasSettings` / `persistAliasSettings` / `saveCatalog` are not exported; `contextWindow` is not on `CliArgs`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/config.ts`:

1. Add the import:

```ts
import type { AliasSettingsPatch } from "./model-settings.ts";
```

2. Add the override type next to `ModelResolution`:

```ts
export interface ModelNumericOverrides {
	contextWindow?: number;
	maxTokens?: number;
}
```

3. Add this helper above `resolveModel`:

```ts
function positiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
	const raw = env[key]?.trim();
	if (!raw) {
		return undefined;
	}
	if (!/^\d+$/u.test(raw)) {
		return undefined;
	}
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveNumericField(
	override: number | undefined,
	envValue: number | undefined,
	fileValue: number | undefined,
): number | undefined {
	return override ?? envValue ?? fileValue;
}
```

4. Change `resolveModel` to accept `overrides: ModelNumericOverrides = {}` and set:

```ts
contextWindow: resolveNumericField(
	overrides.contextWindow,
	positiveIntEnv(env, "OPENAI_CONTEXT_WINDOW"),
	entry.contextWindow, // or undefined on the raw-id branch
),
maxTokens: resolveNumericField(
	overrides.maxTokens,
	positiveIntEnv(env, "OPENAI_MAX_TOKENS"),
	entry.maxTokens, // or undefined on the raw-id branch
),
```

On the raw-id branch, `fileValue` is `undefined`. Overrides and env still apply.

5. Add persist helpers (never log `apiKey`):

```ts
export function updateAliasSettings(
	catalog: PillowCatalog,
	alias: string,
	patch: AliasSettingsPatch,
): PillowCatalog {
	const current = catalog.models[alias];
	if (!current) {
		throw new Error(`alias ${alias} is not in config.json`);
	}
	return {
		...catalog,
		models: {
			...catalog.models,
			[alias]: {
				...current,
				...patch,
			},
		},
	};
}

export async function saveCatalog(userPillow: string, catalog: PillowCatalog): Promise<void> {
	const path = configPath(userPillow);
	const body = `${JSON.stringify(catalog, null, 2)}\n`;
	await writeFile(path, body, { encoding: "utf-8", mode: 0o600 });
	await chmod(path, 0o600);
}

export async function persistAliasSettings(
	userPillow: string,
	alias: string,
	patch: AliasSettingsPatch,
): Promise<void> {
	const loaded = await loadCatalog(userPillow);
	if (!loaded.catalog) {
		throw new Error(loaded.warning ?? "could not read config.json");
	}
	await saveCatalog(userPillow, updateAliasSettings(loaded.catalog, alias, patch));
}
```

In `packages/cli/src/args.ts`:

1. Add `contextWindow?: number` and `maxTokens?: number` to `CliArgs`.
2. In `parseArgs`, extend the valued-flag list:

```ts
		if (
			arg === "--cwd" ||
			arg === "--model" ||
			arg === "--session-dir" ||
			arg === "--session" ||
			arg === "--extension" ||
			arg === "--context-window" ||
			arg === "--max-tokens"
		) {
```

3. After reading `value`, if `arg === "--context-window"` or `arg === "--max-tokens"`:

```ts
			if (!/^\d+$/u.test(value) || Number(value) <= 0) {
				error = `Invalid value for ${arg}`;
				break;
			}
			if (arg === "--context-window") {
				contextWindow = Number(value);
			} else {
				maxTokens = Number(value);
			}
```

4. Return the new fields from `parseArgs`.
5. Add to `printHelp` Flags and Env:

```
  --context-window <n>  Override context window tokens
  --max-tokens <n>      Override max output tokens
```

```
  OPENAI_CONTEXT_WINDOW  Optional context window
  OPENAI_MAX_TOKENS      Optional max output tokens
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace @z-agent/cli -- test/config.test.ts test/args.test.ts`

Expected: PASS. Existing `resolveModel` tests keep working because the fourth argument is optional.

- [ ] **Step 5: Commit**

Skip unless asked.

```bash
git add packages/cli/src/config.ts packages/cli/test/config.test.ts packages/cli/src/args.ts packages/cli/test/args.test.ts
git commit -m "feat: persist alias model settings and honor numeric overrides"
```

---

### Task 3: Live budget apply on SkillManager

**Files:**
- Modify: `packages/cli/src/skill-manager.ts` (`SkillManager` interface near line 124; `DefaultSkillManager` fields near line 259)
- Modify: `packages/cli/test/skill-manager.test.ts`

**Interfaces:**
- Consumes: `setBudget({ contextWindow?: number; maxTokens?: number })`
- Produces: next `prepareContext` uses the new budget; a snapshot captured before `setBudget` keeps the old window

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/skill-manager.test.ts`:

```ts
	it("applies a new context budget to later snapshots only", async () => {
		const paths = await fixture();
		await writeSkill(paths.projectPillow, "review", { body: "PROJECT V1" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
			maxTokens: 2_000,
		});
		const before = await manager.prepareSnapshot({ text: "review" });
		expect(before.budget.contextWindow).toBe(64_000);
		expect(before.budget.outputReserve).toBe(2_000);
		manager.setBudget({ contextWindow: 200_000, maxTokens: 8_192 });
		expect(manager.getSnapshot().budget.contextWindow).toBe(200_000);
		expect(manager.getSnapshot().budget.outputReserve).toBe(8_192);
		expect(before.budget.contextWindow).toBe(64_000);
		expect(before.budget.outputReserve).toBe(2_000);
		const after = await manager.prepareSnapshot({ text: "review" });
		expect(after.budget.contextWindow).toBe(200_000);
		expect(after.budget.outputReserve).toBe(8_192);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @z-agent/cli -- test/skill-manager.test.ts`

Expected: FAIL with `setBudget is not a function`

- [ ] **Step 3: Write minimal implementation**

1. Add to the `SkillManager` interface:

```ts
	setBudget(budget: { contextWindow?: number; maxTokens?: number }): void;
```

2. Change the private fields from `readonly`/`const-like` assignment to mutable (`private contextWindow: number` is already mutable; keep `private maxTokens?: number`).

3. Add this method on `DefaultSkillManager` next to `getDiagnostics`:

```ts
	setBudget(budget: { contextWindow?: number; maxTokens?: number }): void {
		if (budget.contextWindow !== undefined) {
			this.contextWindow = budget.contextWindow;
		}
		if (budget.maxTokens !== undefined) {
			this.maxTokens = budget.maxTokens;
		}
		this.snapshot = this.makeSnapshot(
			this.snapshot.matched,
			this.snapshot.bodies,
			this.snapshot.explicitInvocation,
		);
	}
```

Do **not** call `refreshSnapshot()` here. That helper uses `emptyMatchResult()` and would drop matched/explicit activation.

`makeSnapshot` already reads `this.contextWindow` / `this.maxTokens` into `budget`. Confirm `snapshot.bodies` is acceptable as `ReadonlyMap<string, string>` (it is an immutable map). If the TypeScript checker rejects the immutable-map type, pass `new Map(this.snapshot.bodies)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @z-agent/cli -- test/skill-manager.test.ts`

Expected: PASS, including the existing "unknown context window" test.

- [ ] **Step 5: Commit**

Skip unless asked.

```bash
git add packages/cli/src/skill-manager.ts packages/cli/test/skill-manager.test.ts
git commit -m "feat: allow live skill context budget updates"
```

---

### Task 4: Slash `/model` and richer `/status`

**Files:**
- Modify: `packages/cli/src/interactive-commands.ts`
- Modify: `packages/cli/src/slash.ts`
- Modify: `packages/cli/test/slash.test.ts`
- Modify: `packages/cli/src/interactive.ts`

**Interfaces:**
- Consumes: `parseModelCommand` / `MODEL_COMMAND_USAGE`; `formatRuntimeStatus` via `options.formatStatus`; `options.onModel(args)`
- Produces: `/model` is a builtin; malformed `/model` is `kind: "error"`; `/status` prints the injected status line

- [ ] **Step 1: Write the failing slash tests**

Add to `packages/cli/test/slash.test.ts`:

```ts
	it("treats /model as a builtin and validates args", () => {
		expect(parseSlashInput("/model", index())).toEqual({ kind: "builtin", name: "/model", args: "" });
		expect(parseSlashInput("/model context 200000", index())).toEqual({
			kind: "builtin",
			name: "/model",
			args: "context 200000",
		});
		expect(parseSlashInput("/model context 0", index())).toEqual({
			kind: "error",
			message:
				"Usage: /model, /model context <n>, /model max-tokens <n>, or /model thinking off|minimal|low|medium|high|xhigh|max",
		});
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @z-agent/cli -- test/slash.test.ts`

Expected: FAIL — `/model context 200000` is `{ kind: "text" }` because `/model` is not registered, or validation is missing.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/interactive-commands.ts`, add after `/status`:

```ts
	{ name: "/model", description: "Show or set model context and parameters" },
```

In `packages/cli/src/slash.ts`, import `parseModelCommand` and extend `validateBuiltin`:

```ts
	if (name === "/model") {
		const parsed = parseModelCommand(args);
		return parsed.kind === "error" ? parsed.message : undefined;
	}
```

In `packages/cli/src/interactive.ts`, extend `runInteractive` options:

```ts
	formatStatus?: () => string;
	onModel?: (args: string) => Promise<void> | void;
```

Replace the `/status` branch:

```ts
			if (builtin?.name === "/status" || line === "/status") {
				if (options.formatStatus) {
					options.tui.appendLine(options.formatStatus());
				} else {
					options.tui.showStatus();
				}
				return "continue";
			}
			if (builtin?.name === "/model") {
				await options.onModel?.(builtin.args);
				return "continue";
			}
```

Keep using the existing `builtin` binding already computed above `line`. `/model` submitted during a run stays queued until idle (it is not a skill builtin). That is intended: the current provider request keeps its snapshot.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace @z-agent/cli -- test/slash.test.ts`

Expected: PASS. Also run `npm test --workspace @z-agent/cli -- test/skill-commands.test.ts` as a regression because `INTERACTIVE_COMMANDS` is shared.

Expected: PASS

- [ ] **Step 5: Commit**

Skip unless asked.

```bash
git add packages/cli/src/interactive-commands.ts packages/cli/src/slash.ts packages/cli/test/slash.test.ts packages/cli/src/interactive.ts
git commit -m "feat: add /model slash command and richer /status"
```

---

### Task 5: TUI header `ctx` field

**Files:**
- Modify: `packages/tui/src/model.ts` (`TuiHeaderState`)
- Modify: `packages/tui/src/layout.ts` (`renderHeader`)
- Modify: `packages/tui/test/tui.test.ts`

**Interfaces:**
- Consumes: optional `header.context: string`
- Produces: header text contains `ctx: 128k` when `context` is set; existing headers without `context` stay unchanged

- [ ] **Step 1: Write the failing test**

In `packages/tui/test/tui.test.ts`, add a `renderFrame` case (monochrome so the assertion is stable):

```ts
	it("shows compact context in the header when provided", () => {
		const frame = renderFrame(
			{
				status: "model=fast",
				header: {
					cwd: "/tmp/project",
					model: "fast(gpt-4.1-mini)",
					context: "128k",
					session: "branch-a",
				},
				transcript: [],
				editorLines: [""],
				streaming: false,
				colors: false,
			},
			120,
			12,
		).map(stripAnsi);
		const header = frame[0] ?? "";
		expect(header).toContain("model: fast(gpt-4.1-mini)");
		expect(header).toContain("ctx: 128k");
		expect(header).toContain("session: branch-a");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @z-agent/tui -- test/tui.test.ts`

Expected: FAIL — `ctx: 128k` is absent.

- [ ] **Step 3: Write minimal implementation**

In `packages/tui/src/model.ts`:

```ts
export interface TuiHeaderState {
	cwd: string;
	model: string;
	session: string;
	context?: string;
}
```

In `packages/tui/src/layout.ts` `renderHeader`, insert the ctx field immediately after model:

```ts
	const fields = [
		paint("strong", " Z AGENT "),
		paint("muted", `cwd: ${clean(state.header.cwd)}`),
		paint("muted", `model: ${clean(state.header.model)}`),
		...(state.header.context ? [paint("muted", `ctx: ${clean(state.header.context)}`)] : []),
		paint(statusTone, `status: ${state.streaming ? "RUNNING" : "READY"}`),
		paint("muted", `session: ${clean(state.header.session)}`),
	];
```

Do not add a second header row. Existing clip-from-the-right behavior stays; narrow terminals lose `session` then `status` then `ctx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @z-agent/tui -- test/tui.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

Skip unless asked.

```bash
git add packages/tui/src/model.ts packages/tui/src/layout.ts packages/tui/test/tui.test.ts
git commit -m "feat: show compact model context in the TUI header"
```

---

### Task 6: Product wiring, compaction fallback, and docs

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/compaction.ts` (`shouldCompact`)
- Modify: `packages/cli/test/compaction.test.ts`
- Modify: `packages/cli/test/smoke.test.ts`
- Modify: `packages/cli/README.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/glossary.md`

**Interfaces:**
- Consumes: `modelSettingsView`, `reduceModelSettings`, `formatRuntimeStatus`, `formatCompactContext`, `formatListModelsLine`, `persistAliasSettings`, `SkillManager.setBudget`
- Produces: live inspect/edit in TUI and print; launch-time `Agent.maxTokens`; `--list-models` columns

- [ ] **Step 1: Write the failing compaction and smoke assertions**

Add to `packages/cli/test/compaction.test.ts`:

```ts
	it("treats a missing or non-positive window as the default window", () => {
		expect(shouldCompact([user("hi")], { contextWindow: 0 })).toBe(false);
		expect(shouldCompact([user("hi")], { contextWindow: Number.NaN })).toBe(false);
	});
```

In `packages/cli/test/smoke.test.ts`, keep the existing `--list-models` assertions and add:

```ts
		expect(result.stdout).toContain("128000");
		expect(result.stdout).toContain("4096");
```

- [ ] **Step 2: Run those tests to verify the new assertions fail**

Run: `npm test --workspace @z-agent/cli -- test/compaction.test.ts test/smoke.test.ts`

Expected: compaction `contextWindow: 0` currently treats `0` as a real window (`0 ?? DEFAULT` is `0`), so a tiny transcript still exceeds `0 - reserve` and the new test fails. Smoke fails because `--list-models` does not print `128000`.

- [ ] **Step 3: Implement wiring**

**Compaction.** In `packages/cli/src/compaction.ts` `shouldCompact`:

```ts
	const window =
		options.contextWindow !== undefined &&
		Number.isFinite(options.contextWindow) &&
		options.contextWindow > 0
			? options.contextWindow
			: DEFAULT_WINDOW;
```

**`cli.ts` launch resolution.** After `const resolved = resolveModel(...)`, pass numeric flags:

```ts
	const resolved = resolveModel(modelRefFromArgs(args.model), loaded.catalog, process.env, {
		contextWindow: args.contextWindow,
		maxTokens: args.maxTokens,
	});
```

Replace the `--list-models` loop with:

```ts
		for (const [alias, model] of Object.entries(loaded.catalog.models)) {
			console.log(
				formatListModelsLine({
					alias,
					id: model.id,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					thinking: model.thinking,
					isDefault: alias === loaded.catalog.defaultModel,
				}),
			);
		}
```

Hold a mutable live view next to `skillManager` creation:

```ts
	let settings = modelSettingsView({
		hasModel: resolved.hasModel,
		alias: resolved.hasModel ? resolved.alias : undefined,
		id: resolved.hasModel ? resolved.id : undefined,
		thinking: resolved.hasModel ? resolved.thinking : "off",
		contextWindow: resolved.hasModel ? resolved.contextWindow : undefined,
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
	});
```

Import `formatCompactContext`, `formatListModelsLine`, `formatRuntimeStatus`, `modelSettingsView`, `reduceModelSettings` from `./model-settings.ts` and `persistAliasSettings` from `./config.ts`.

Change TUI `status` / `header` closures so they read current values, not the launch-time `statusModel` string:

```ts
				status: () =>
					formatRuntimeStatus({
						view: settings,
						skillsMode: skillManager.getState().mode,
						skillsActive: skillManager.getState().active.length,
						cwd,
					}).replace(/^\[status\] /, ""),
				header: () => ({
					cwd,
					model: settings.hasModel
						? settings.alias
							? `${settings.alias}(${settings.id})`
							: settings.id
						: "none",
					context: formatCompactContext(settings.contextWindow),
					session: session.header.id.slice(0, 12),
				}),
```

The `status` callback is still used by `showStatus()` fallback and the header-less path. Stripping the `[status] ` prefix keeps that callback a compact line. `/status` uses `formatStatus` below and keeps the prefix.

When constructing `Agent`, pass the provider cap:

```ts
	agent = new Agent({
		streamFn,
		apiKey,
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
		// existing hooks...
		initialState: {
			model,
			thinkingLevel: resolved.hasModel ? resolved.thinking : "off",
			// ...
		},
	});
```

Add a helper in `main` (same file, above `runInteractive`):

```ts
	const applySettings = async (argsText: string): Promise<void> => {
		const result = reduceModelSettings(settings, argsText);
		if (result.kind === "error") {
			writeSkillStatus("error", result.message);
			return;
		}
		if (result.kind === "inspect") {
			writeSkillStatus("info", result.text);
			return;
		}
		settings = result.view;
		agent.state.model = {
			...agent.state.model,
			contextWindow: settings.contextWindow,
			maxTokens: settings.maxTokens,
		};
		agent.state.thinkingLevel = settings.thinking;
		agent.maxTokens = settings.maxTokens;
		skillManager.setBudget({
			contextWindow: settings.contextWindow ?? 0,
			maxTokens: settings.maxTokens,
		});
		if (result.persistPatch && settings.alias) {
			try {
				await persistAliasSettings(userPillow, settings.alias, result.persistPatch);
				writeSkillStatus("info", result.text);
			} catch (error) {
				writeSkillStatus(
					"warning",
					`${result.text} persist=failed (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			return;
		}
		if (settings.persist === "session") {
			writeSkillStatus("info", `${result.text} (not saved; no catalog alias)`);
			return;
		}
		writeSkillStatus("info", result.text);
	};
```

`writeSkillStatus` is declared after `agent` today. Place `applySettings` after `writeSkillStatus` so it can call it. `runInteractive` is later; that order is fine.

Print banner:

```ts
		console.error(
			`[mode] print model=${settings.hasModel ? (settings.alias ? `${settings.alias}(${settings.id})` : settings.id) : "none"} contextWindow=${settings.contextWindow ?? "unknown"} maxTokens=${settings.maxTokens ?? "unknown"} thinking=${settings.thinking} cwd=${cwd}`,
		);
```

Pass into `runInteractive`:

```ts
		formatStatus: () =>
			formatRuntimeStatus({
				view: settings,
				skillsMode: skillManager.getState().mode,
				skillsActive: skillManager.getState().active.length,
				cwd,
			}),
		onModel: async (modelArgs) => {
			await applySettings(modelArgs);
		},
```

**Docs.** In `packages/cli/README.md` Interactive Commands, add `/model` and mention that `/status` includes thinking, context window, max tokens, and persist mode.

In `docs/roadmap.md`, add:

```md
## Phase 2.8 — Model settings inspect and edit

`/status` and `/model` show `contextWindow`, `maxTokens`, and `thinking`. Alias-backed edits persist to `~/.pillow/config.json`. `--context-window` / `--max-tokens` and matching env vars complete ADR-0022 numeric precedence.
```

In `docs/glossary.md`, add:

```md
## Model settings

Live inspect/edit surface for the resolved catalog model: `contextWindow`, `maxTokens`, and `thinking`. `/model` updates the current Agent and skills budget. Alias-backed values write `~/.pillow/config.json`. Raw model ids stay session-only. (ADR-0022)
```

- [ ] **Step 4: Run focused tests, then typecheck**

Run, in order:

```bash
npm test --workspace @z-agent/cli -- test/model-settings.test.ts test/config.test.ts test/args.test.ts test/slash.test.ts test/skill-manager.test.ts test/compaction.test.ts test/smoke.test.ts
npm test --workspace @z-agent/tui -- test/tui.test.ts
npm run check
```

Expected: all PASS. `npm run check` must be clean. If `check` reports unused locals or formatting, fix them in the files this plan touched.

Manual proof after check (do not claim done without it):

```bash
PILLOW_HOME=/tmp/pillow-model-settings-proof npm run z-agent --workspace @z-agent/cli -- --list-models
```

Expected stdout includes `fast`, `gpt-4.1-mini`, `128000`, `4096`. Then in a TTY:

1. `z-agent`
2. `/status` shows `contextWindow` and `maxTokens`
3. `/model context 200000`
4. `/model` shows `200000` and `persist=alias`
5. Restart and `/model` still shows `200000`
6. `~/.pillow/config.json` (or `$PILLOW_HOME/config.json`) has `"contextWindow": 200000` and still has no leaked key in logs

- [ ] **Step 5: Commit**

Skip unless asked.

```bash
git add packages/cli/src/cli.ts packages/cli/src/compaction.ts packages/cli/test/compaction.test.ts packages/cli/test/smoke.test.ts packages/cli/README.md docs/roadmap.md docs/glossary.md
git commit -m "feat: inspect and edit live model context settings"
```

---

## Self-Review

**Spec coverage**

| Requirement | Task |
| --- | --- |
| View context window and parameters in TUI | Task 4 `/status` + `/model`; Task 5 header `ctx`; Task 6 live closures |
| View in print / listing | Task 1 `formatListModelsLine`; Task 6 `--list-models` + print banner |
| Edit context window, max tokens, thinking | Task 1 reducer; Task 4 slash; Task 6 `applySettings` |
| Persist alias edits to config.json | Task 2 persist helpers; Task 6 `persistAliasSettings` |
| Raw id stays session-only | Task 1 `persist=session`; Task 6 notice |
| Next turn uses new values; in-flight snapshot stays old | Task 3 `setBudget` + old snapshot assertion |
| ADR-0022 numeric precedence | Task 2 `resolveModel` overrides + env; Task 6 flag pass-through |
| Provider honors `maxTokens` | Task 6 `Agent.maxTokens` at launch and on edit |
| No apiKey render | persist writes JSON; formatters never include key |
| No model switch / no `--thinking` / no temperature | locked non-goals |

**Placeholder scan:** no TBD/TODO. Commands, types, and file paths are exact.

**Type consistency:** `ModelSettingsView`, `reduceModelSettings`, `AliasSettingsPatch`, `setBudget`, `TuiHeaderState.context`, and `resolveModel(..., overrides?)` are used under the same names in later tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-28-model-settings-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
