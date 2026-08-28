# Skills Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a complete, deterministic Agent Skills product for Z Agent, from `SKILL.md` discovery through persistent session activation, provider context injection, slash commands, and TUI completion.

**Architecture:** `@z-agent/skills` owns pure parsing, discovery, resolution, matching, state reduction, rendering, budgeting, and resource validation. `@z-agent/agent` remains filesystem-free and receives one generic `prepareContext` hook immediately before each provider request. `@z-agent/cli` owns filesystem/session effects, the skill manager, command routing, and `skill_read`; `@z-agent/tui` owns interactive completion and presentation.

**Tech Stack:** TypeScript 5.9 in erasable syntax, Node.js 22+, Vitest, Biome, the existing `@z-agent/agent` / `@z-agent/ai` packages, exact `yaml` and `picomatch` dependencies for structured frontmatter and confined manifest matching.

## Global Constraints

- Node `>=22`; run `npm install --ignore-scripts` when dependencies change.
- Use erasable TypeScript only: no parameter properties, `enum`, `namespace`, or `import =`.
- Relative imports include `.ts` extensions; direct dependencies use exact versions.
- `@z-agent/agent` must not depend on `@z-agent/skills`, filesystem code, YAML, sessions, or CLI code.
- Only `streamAssistant` and `tool.execute` are effect boundaries in the agent core.
- Skills are untrusted supplemental instructions; they never change policy, tool authorization, confirmation, or path jail.
- Project skills override user skills; project and user skills are discoverable without project trust. Extensions remain trust-gated.
- Default mode is progressive; a body is included whole or omitted, never silently truncated.
- Automatic matching activates at most 2 new skills per turn and 8 skills per session.
- Existing uncommitted TUI changes and untracked assets are user-owned; patch around them and do not revert them.
- Do not create commits unless the user explicitly asks. Stage no files during implementation.

---

## Contract Map

The following signatures are the cross-task contract. Later tasks must use these names and field meanings rather than introducing incompatible aliases.

```ts
// packages/skills/src/types.ts
export type SkillScope = "user" | "project";
export type SkillSourceKind = "manifest" | "conventional";
export type SkillMode = "progressive" | "full" | "index";

export interface SkillSource {
	scope: SkillScope;
	kind: SkillSourceKind;
	rootDir: string;
	displayPath: string;
	canonicalPath: string;
	manifestPath?: string;
}

export interface SkillMetadata {
	name: string;
	description: string;
	license?: string;
	compatibility?: string;
	keywords: string[];
	fileGlobs: string[];
	allowedTools: string[];
	disableModelInvocation: boolean;
	extra: Readonly<Record<string, unknown>>;
}

export interface SkillDiagnostic {
	code:
		| "invalid_frontmatter"
		| "invalid_metadata"
		| "manifest_invalid"
		| "manifest_escape"
		| "glob_no_match"
		| "path_unreadable"
		| "duplicate_path"
		| "name_collision"
		| "body_changed"
		| "body_missing"
		| "budget_exceeded"
		| "activation_limit";
	severity: "info" | "warning" | "error";
	message: string;
	path?: string;
	skillName?: string;
	registryVersion?: number;
}

export interface SkillDescriptor {
	metadata: SkillMetadata;
	source: SkillSource;
	baseDir: string;
	skillPath: string;
	body?: string;
	statFingerprint?: { mtimeMs: number; size: number };
	contentHash?: string;
	diagnostics: readonly SkillDiagnostic[];
}

export interface SkillIndex {
	version: number;
	skills: readonly SkillDescriptor[];
	byName: ReadonlyMap<string, SkillDescriptor>;
	diagnostics: readonly SkillDiagnostic[];
}

export interface DiscoverOptions {
	cwd: string;
	userHome?: string;
	userSkillsDir?: string;
	projectSkillsDir?: string;
	userManifest?: string;
	projectManifest?: string;
}

export interface DiscoverResult {
	skills: readonly SkillDescriptor[];
	diagnostics: readonly SkillDiagnostic[];
}

export interface MatchRequest {
	text: string;
	pathHints?: readonly string[];
	activeNames?: readonly string[];
	manualOffNames?: readonly string[];
}

export interface MatchOptions {
	threshold?: number;
	maxNew?: number;
	maxActive?: number;
}

export interface SkillMatch {
	skill: SkillDescriptor;
	score: number;
	reasons: readonly string[];
	accepted: boolean;
	exclusion?: "threshold" | "hidden" | "manual_off" | "stale" | "turn_limit" | "session_limit";
}

export interface MatchResult {
	matches: readonly SkillMatch[];
	activations: readonly SkillDescriptor[];
	diagnostics: readonly SkillDiagnostic[];
}

export type SkillStateNode = SkillActivationNode | SkillDeactivationNode | SkillModeNode;
export interface SkillActivationNode {
	type: "skill_activation";
	schemaVersion: 1;
	id: string;
	parentId: string | null;
	createdAt: number;
	skillName: string;
	canonicalPath: string;
	sourceScope: SkillScope;
	sourceKind: SkillSourceKind;
	contentHash: string;
	origin: "explicit" | "automatic" | "all" | "command";
}
export interface SkillDeactivationNode {
	type: "skill_deactivation";
	schemaVersion: 1;
	id: string;
	parentId: string | null;
	createdAt: number;
	skillName: string;
	canonicalPath?: string;
	origin: "explicit" | "command" | "reload" | "reset";
}
export interface SkillModeNode {
	type: "skill_mode";
	schemaVersion: 1;
	id: string;
	parentId: string | null;
	createdAt: number;
	mode: SkillMode;
}

export interface SkillIdentity {
	name: string;
	canonicalPath: string;
	contentHash: string;
	sourceScope: SkillScope;
	sourceKind: SkillSourceKind;
}
export interface SkillState {
	active: readonly SkillIdentity[];
	manualOffNames: readonly string[];
	mode: SkillMode;
	stale: readonly SkillIdentity[];
	diagnostics: readonly SkillDiagnostic[];
}

export interface TokenEstimator {
	(text: string): number;
}
export interface Budget {
	contextWindow: number;
	baseContextTokens?: number;
	outputReserve?: number;
	safetyReserve?: number;
	estimator?: TokenEstimator;
}
export interface RenderResult {
	text: string;
	includedNames: readonly string[];
	omittedNames: readonly string[];
	estimatedTokens: number;
	diagnostics: readonly SkillDiagnostic[];
}
export interface SkillResource {
	skillName: string;
	relativePath: string;
	mimeType: string;
	content: string | Uint8Array;
}

export function discoverSkills(options: DiscoverOptions): Promise<DiscoverResult>;
export function parseSkill(raw: string, source: SkillSource): ParseResult;
export function resolveSkillConflicts(skills: SkillDescriptor[]): ResolveResult;
export function matchSkills(request: MatchRequest, index: SkillIndex, options?: MatchOptions): MatchResult;
export function reduceSkillState(nodes: SkillStateNode[]): SkillState;
export function formatAvailableSkills(index: SkillIndex, budget: Budget): RenderResult;
export function formatActiveSkills(state: SkillState, index: SkillIndex, budget: Budget): RenderResult;
export function formatSkillInvocation(skill: SkillDescriptor, body: string, args: string, budget: Budget): RenderResult;
export function readSkillResource(index: SkillIndex, skillName: string, relativePath?: string): Promise<SkillResource>;
```

`ParseResult` and `ResolveResult` are defined in Task 1 and carry diagnostics without throwing for malformed individual resources. The CLI manager may add adapter-only types, but it must pass the package contracts unchanged.

## Task 1: Scaffold `@z-agent/skills` and Public Contracts

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/tsconfig.json`
- Create: `packages/skills/vitest.config.ts`
- Create: `packages/skills/src/types.ts`
- Create: `packages/skills/src/index.ts`
- Create: `packages/skills/test/smoke.test.ts`
- Modify: `package.json` (workspace check script)
- Modify: `package-lock.json` (exact dependency entries)

**Interfaces:**
- Consumes: none.
- Produces: the contract map above, plus `ParseResult`, `ResolveResult`, `SkillFs`, and immutable index constructors used by Tasks 2-6.

- [ ] **Step 1: Write the package smoke test.**

```ts
import { describe, expect, it } from "vitest";
import { matchSkills, parseSkill, reduceSkillState } from "../src/index.ts";

describe("@z-agent/skills public surface", () => {
	it("exports pure functions and erasable contracts", () => {
		expect(typeof parseSkill).toBe("function");
		expect(typeof matchSkills).toBe("function");
		expect(typeof reduceSkillState).toBe("function");
	});
});
```

- [ ] **Step 2: Add the package manifests.** Use the existing package export shape and exact dependencies `"yaml": "2.8.1"` and `"picomatch": "4.0.5"`; add `tsc -p packages/skills/tsconfig.json --noEmit` to the root `check` script.
- [ ] **Step 3: Add `types.ts` and `index.ts`.** Define every type in the contract map, use `Readonly*` fields for index/state outputs, and export only source modules through `src/index.ts`.
- [ ] **Step 4: Run the focused smoke test and type check.**

Run: `npx vitest --run packages/skills/test/smoke.test.ts && npx tsc -p packages/skills/tsconfig.json --noEmit`
Expected: the smoke test passes and TypeScript reports no errors.

## Task 2: Parse `SKILL.md` Frontmatter Safely

**Files:**
- Create: `packages/skills/src/parse.ts`
- Create: `packages/skills/test/parse.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `SkillSource` and `SkillDiagnostic` from Task 1.
- Produces: `parseSkill(raw: string, source: SkillSource): ParseResult`, where `ParseResult` is `{ descriptor?: SkillDescriptor; diagnostics: readonly SkillDiagnostic[] }`.

- [ ] **Step 1: Write parser tests for valid and invalid documents.** Cover a YAML document with `name`, `description`, `metadata.keywords`, `metadata.file-globs`, `allowed-tools` as both string and array, `disable-model-invocation`, unknown fields, missing required fields, invalid name/description, and a legacy H1-only file. Assert that required-field failures omit `descriptor`, while optional violations retain the descriptor and emit warnings.
- [ ] **Step 2: Write parser safety-limit tests.** Feed a frontmatter block over the configured byte limit, deeply nested YAML, and oversized arrays. Assert `invalid_frontmatter` with `severity: "error"` and no uncaught parser exception.
- [ ] **Step 3: Implement delimiter extraction and YAML parsing.** Require the document to begin with `---` followed by a closing `---`; parse with the structured `yaml` document API and bounded collection/depth options. Split `body` after the closing delimiter without inferring a name from Markdown headings.
- [ ] **Step 4: Implement schema normalization.** Validate `name` against `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` with no `--`, cap description at 1024 characters, normalize invalid keyword/glob values out with warnings, split `allowed-tools` on whitespace when it is a string, and retain unknown frontmatter fields in `extra`.
- [ ] **Step 5: Run the parser test.**

Run: `npx vitest --run packages/skills/test/parse.test.ts`
Expected: all frontmatter, warning, and safety-limit cases pass.

## Task 3: Recursive Discovery, Manifests, and Path Confinement

**Files:**
- Create: `packages/skills/src/discover.ts`
- Create: `packages/skills/test/discover.test.ts`
- Modify: `packages/skills/src/types.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `parseSkill` and `DiscoverOptions` from Tasks 1-2.
- Produces: `discoverSkills(options): Promise<DiscoverResult>` and an injectable `SkillFs` adapter so tests can model symlinks and unreadable paths without changing production behavior.

- [ ] **Step 1: Write temporary-directory discovery tests.** Create user and project roots containing a root `SKILL.md`, nested skill roots, hidden directories, `node_modules`, and `.gitignore`/`.ignore` patterns. Assert root skills stop recursion, hidden and ignored entries are skipped, entries are sorted, and unreadable files produce diagnostics while other skills load.
- [ ] **Step 2: Write manifest tests.** Create both `skills.json` files with directory, exact `SKILL.md`, and `**/*.md` entries. Assert only directories and files named exactly `SKILL.md` become candidates, no-match globs emit `glob_no_match`, and manifest results are additive to conventional discovery.
- [ ] **Step 3: Write lexical and canonical escape tests.** Assert absolute paths, lexical `..`, a symlink whose target exits the manifest root, and a broken link are rejected with `manifest_escape` or `path_unreadable`; assert a symlink staying inside the root is accepted once by canonical path.
- [ ] **Step 4: Implement discovery adapters.** Resolve default roots to `$PILLOW_HOME/skills`, `{cwd}/.pillow/skills`, and their `skills.json` files; recurse with sorted `readdir`, stop at a directory containing `SKILL.md`, skip hidden/node_modules, honor applicable ignore files, and record `scope`, `kind`, display path, base directory, stat fingerprint, and canonical path.
- [ ] **Step 5: Implement manifest expansion.** Resolve each relative entry against the manifest directory, reject absolute/lexical escapes before globbing, use `picomatch` for normalized relative matching, canonicalize every result, and apply a realpath containment check before parsing.
- [ ] **Step 6: Run discovery tests.**

Run: `npx vitest --run packages/skills/test/discover.test.ts`
Expected: deterministic candidate order and all containment diagnostics pass.

## Task 4: Conflict Resolution and Immutable Index

**Files:**
- Create: `packages/skills/src/resolve.ts`
- Create: `packages/skills/test/resolve.test.ts`
- Modify: `packages/skills/src/discover.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `SkillDescriptor[]` from `discoverSkills`.
- Produces: `resolveSkillConflicts(skills): ResolveResult`, with `{ index: SkillIndex; diagnostics: readonly SkillDiagnostic[] }` and deterministic source ranking.

- [ ] **Step 1: Write precedence tests.** Provide same-name descriptors from project manifest, project conventional, user manifest, and user conventional sources. Assert the selected descriptor follows exactly that order, then normalized name and canonical path as tie-breakers.
- [ ] **Step 2: Write duplicate/collision tests.** Assert identical canonical paths produce `duplicate_path`, distinct paths with the same name produce `name_collision`, and only the highest-ranked descriptor is addressable through `byName`.
- [ ] **Step 3: Implement rank and index construction.** Sort by rank, normalize names with NFKC/lowercase for lookup while preserving display metadata, aggregate diagnostics, freeze/copy arrays and maps, and increment an explicit registry version supplied by the caller or defaulted to `1`.
- [ ] **Step 4: Integrate discovery resolution.** Make `discoverSkills` return candidates and diagnostics; have the CLI call `resolveSkillConflicts` before exposing an index rather than implementing precedence in CLI code.
- [ ] **Step 5: Run resolution tests.**

Run: `npx vitest --run packages/skills/test/resolve.test.ts`
Expected: selected names, provenance, and diagnostics are stable across repeated runs.

## Task 5: Deterministic Matching and Branch-Local State Reduction

**Files:**
- Create: `packages/skills/src/match.ts`
- Create: `packages/skills/src/state.ts`
- Create: `packages/skills/test/match.test.ts`
- Create: `packages/skills/test/state.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `SkillIndex`, `MatchRequest`, and `SkillStateNode` from Tasks 1 and 4.
- Produces: `matchSkills` and `reduceSkillState`, including explainable reasons, manual-off tombstones, stale identities, and mode transitions.

- [ ] **Step 1: Write matcher signal tests.** Assert NFKC/lowercase tokenization and each score signal: exact name phrase (100), name overlap (40/token capped 80), keyword overlap (30/token capped 60), description overlap (6/token capped 30), and matching explicit file globs (35/glob capped 70), with total capped at 100 and threshold 35.
- [ ] **Step 2: Write matcher exclusion/cap tests.** Assert hidden skills are excluded from automatic matches, manual-off names stay excluded, active names do not count as new activations, stable score/source/name/path ordering is used, and turn/session limits produce `activation_limit` diagnostics and reasons.
- [ ] **Step 3: Implement the pure matcher.** Match only request text and explicit path hints; never inspect bodies or transcript messages. Return every considered candidate with score, reasons, acceptance, and exclusion code; return at most `maxNew ?? 2` activations while respecting `maxActive ?? 8`.
- [ ] **Step 4: Write state reducer tests.** Replay root-to-leaf activation, deactivation, and mode nodes; assert branch rollback by truncating the node list, `/new` equivalent empty input, reset semantics, manual-off tombstones, duplicate activation replacement, and stale identity retention in audit state.
- [ ] **Step 5: Implement `reduceSkillState`.** Apply nodes in order, remove an active identity on matching deactivation, clear a name's manual-off tombstone only on explicit activation, default mode to `progressive`, and preserve malformed/stale diagnostics without silently rebinding same-name skills.
- [ ] **Step 6: Run both focused tests.**

Run: `npx vitest --run packages/skills/test/match.test.ts packages/skills/test/state.test.ts`
Expected: all scores, exclusions, branch projections, and tombstone assertions pass.

## Task 6: Context Rendering, Token Budgeting, and Resource Reads

**Files:**
- Create: `packages/skills/src/render.ts`
- Create: `packages/skills/src/resource.ts`
- Create: `packages/skills/test/render.test.ts`
- Create: `packages/skills/test/resource.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `SkillIndex`, `SkillState`, `Budget`, and `SkillDescriptor` from Tasks 1, 4, and 5.
- Produces: the three rendering functions and `readSkillResource` from the contract map; default estimator is `Math.ceil(serializedChars / 4)`.

- [ ] **Step 1: Write rendering tests.** Assert XML escaping for names/descriptions/locations, omission of private canonical paths, `<available_skills>`, `<active_skills>`, and `<matched_skills>` ordering, hidden-skill filtering, `skill_read` hints, and the explicit invocation wrapper with complete body plus `<user_instructions>` arguments.
- [ ] **Step 2: Write budget tests.** Assert available tokens are `contextWindow - baseContext - outputReserve - safetyReserve`, skills consume no more than 15% of the window, explicit body has highest priority, entries are whole-or-omitted, and invalid/missing context windows fail with a diagnostic instead of unbounded injection.
- [ ] **Step 3: Implement renderer and estimator.** Use an injectable `TokenEstimator`, default reserves of `maxTokens`/10% and 5% safety, stable allocation priority, and `budget_exceeded` diagnostics for omitted entries. Return included and omitted names for `/skills` reporting.
- [ ] **Step 4: Write resource security tests.** Assert default `SKILL.md`, UTF-8 text and supported image bytes, rejection of absolute paths, `..` traversal, directories, symlink escapes, and unindexed skill names; assert reads never widen ordinary coding-tool jail.
- [ ] **Step 5: Implement resource validation.** Resolve by indexed name, normalize a relative path, use `lstat`/`realpath`, require a regular file inside `baseDir`, apply bounded I/O, and return MIME-tagged `string | Uint8Array` content without executing or listing files.
- [ ] **Step 6: Run renderer/resource tests.**

Run: `npx vitest --run packages/skills/test/render.test.ts packages/skills/test/resource.test.ts`
Expected: XML, budget, body-integrity, and path-jail tests pass.

## Task 7: Add the Agent `prepareContext` Seam

**Files:**
- Modify: `packages/agent/src/types.ts:313-412`
- Modify: `packages/agent/src/stream-assistant.ts:37-145`
- Modify: `packages/agent/src/agent.ts:91-235,441-487`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/test/agent-loop.test.ts`
- Modify: `packages/agent/test/agent.test.ts`

**Interfaces:**
- Consumes: the existing `AgentContext`, `AgentLoopConfig`, and `AgentOptions` contracts.
- Produces: `prepareContext?: (context: AgentContext) => AgentContext | Promise<AgentContext>` on both loop and shell options. The hook receives a read-only snapshot and its returned context is local to one provider request.

- [x] **Step 1: Write the failing loop regression test.** Add a `prepareContext` callback that records `context.messages.length`, appends a marker only to a returned `messages` copy, and assert that the provider sees the marker while the caller's live `context.messages` does not. Use two scripted responses (assistant tool call, then text) to prove the hook runs before both provider requests.
- [x] **Step 2: Add queue-boundary coverage.** In the same test file, enqueue steering and follow-up messages and assert the callback is invoked for the first, post-tool, steering, and follow-up provider calls in that exact order. Assert every callback receives a distinct context object and cannot observe a later mutation.
- [x] **Step 3: Implement the loop type and provider order.** Add the field to `AgentLoopConfig`; in `streamAssistant`, replace the initial local with:

```ts
let preparedContext = context;
if (config.prepareContext) {
	preparedContext = await config.prepareContext({
		...context,
		messages: context.messages.slice(),
		tools: context.tools?.slice(),
	});
}
let messages = preparedContext.messages;
if (config.transformContext) {
	messages = await config.transformContext(messages, signal);
}
```

Build the LLM context and tool schemas from `preparedContext`, never mutate the hook input, and keep the existing stream error encoding behavior.
- [x] **Step 4: Thread the shell option.** Add `prepareContext` to `AgentOptions`, a public `Agent.prepareContext` field, constructor assignment, and `createLoopConfig()` forwarding. Do not import a skills type or package into `@z-agent/agent`.
- [x] **Step 5: Verify agent regressions.**

Run: `npx vitest --run packages/agent/test/agent-loop.test.ts packages/agent/test/agent.test.ts`
Expected: new hook tests pass and existing stream/tool ordering tests remain green.

## Task 8: Persist Skill Control Nodes in the Session Tree

**Files:**
- Modify: `packages/cli/src/sessions.ts:10-166`
- Modify: `packages/cli/test/sessions.test.ts`
- Create: `packages/cli/test/skill-session.test.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Consumes: `SkillStateNode`, `SkillActivationNode`, `SkillDeactivationNode`, `SkillModeNode`, and `reduceSkillState` from `@z-agent/skills`.
- Produces: `SessionEntryType` including `skill_activation`, `skill_deactivation`, and `skill_mode`; `appendSkillActivation`, `appendSkillDeactivation`, `appendSkillMode`, and `skillStateOnLeaf(session): SkillState`.

- [ ] **Step 1: Write persistence tests before changing the union.** Append a message, an activation, a mode change, a deactivation, and a second message; assert `messagesOnLeaf` returns only the two messages, `skillStateOnLeaf` returns the active/mode projection, and `rootToLeaf(branch(session, activationId))` rolls back later controls.
- [ ] **Step 2: Write compatibility tests.** Load a JSONL session containing only the old `message`/`compaction`/`label` node types and assert it restores with `progressive` mode and no active skills. Save and reload a session with control nodes and assert all fields, parent IDs, hashes, origins, and schema version `1` survive exactly.
- [ ] **Step 3: Implement typed node constructors.** Extend `SessionNode` with the three discriminated shapes and add constructors that set `id`, `parentId: session.leafId`, and `createdAt` before advancing `leafId`:

```ts
export function appendSkillActivation(session: SessionRecord, node: Omit<SkillActivationNode, "id" | "parentId" | "createdAt">): SessionNode;
export function appendSkillDeactivation(session: SessionRecord, node: Omit<SkillDeactivationNode, "id" | "parentId" | "createdAt">): SessionNode;
export function appendSkillMode(session: SessionRecord, mode: SkillMode): SessionNode;
```

Keep controls out of `AgentMessage[]`; `messagesOnLeaf` continues filtering only `type === "message"`.
- [ ] **Step 4: Implement the leaf projection.** Pass only control nodes from `rootToLeaf` to `reduceSkillState`, preserving their order. Do not rewrite or summarize controls during compaction.
- [ ] **Step 5: Run session tests.**

Run: `npx vitest --run packages/cli/test/sessions.test.ts packages/cli/test/skill-session.test.ts`
Expected: old-session compatibility, branch rollback, and JSONL round-trip tests pass.

## Task 9: Build the CLI Skill Registry Manager and `skill_read`

**Files:**
- Create: `packages/cli/src/skill-manager.ts`
- Create: `packages/cli/test/skill-manager.test.ts`
- Replace: `packages/cli/src/skills.ts`
- Replace: `packages/cli/test/skills.test.ts`
- Modify: `packages/cli/src/cli.ts:137-235,240-305`
- Modify: `packages/cli/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `discoverSkills`, `resolveSkillConflicts`, `matchSkills`, renderers, `readSkillResource`, session control constructors, and `AgentTool`.
- Produces: `createSkillManager(options): Promise<SkillManager>` with:

```ts
export interface SkillContextSnapshot {
	registryVersion: number;
	index: SkillIndex;
	state: SkillState;
	mode: SkillMode;
	matched: MatchResult;
	budget: Budget;
	explicitInvocation?: { skill: SkillDescriptor; args: string; body: string };
}

export interface SkillManager {
	getIndex(): SkillIndex;
	getState(): SkillState;
	reload(): Promise<ReloadResult>;
	activate(name: string, origin: "explicit" | "automatic" | "all" | "command"): Promise<SkillActionResult>;
	deactivate(name: string, origin?: "explicit" | "command" | "reload" | "reset"): Promise<SkillActionResult>;
	setMode(mode: SkillMode): Promise<SkillActionResult>;
	matchAndActivate(text: string, pathHints?: readonly string[]): Promise<MatchResult>;
	prepareSnapshot(input?: { text?: string; pathHints?: readonly string[]; explicitName?: string; args?: string }): Promise<SkillContextSnapshot>;
	createReadTool(): AgentTool;
}
```

- [ ] **Step 1: Write manager tests with isolated temp roots.** Assert project-over-user resolution, registry version changes on reload, active state restored from `skillStateOnLeaf`, explicit activation of hidden skills, automatic matching limits, and a snapshot that remains unchanged after a subsequent reload.
- [ ] **Step 2: Write trust-split tests.** Mock `ensureProjectTrust` as false and assert skills still discover/activate while `discoverExtensionPaths` and extension loading are skipped. Assert no private canonical path is present in the model-facing snapshot text.
- [ ] **Step 3: Implement startup/reload lifecycle.** Construct discovery options from `pillowUserDir()`/`pillowProjectDir(cwd)`, resolve into an immutable index, reconcile active identities by name + canonical path + content hash, retain stale identities for audit, and append deactivation nodes for removed identities. `/reload` swaps the index only after all parsing and resolution finish.
- [ ] **Step 4: Implement activation and snapshot preparation.** Explicit activation reads and hashes the complete `SKILL.md` body before appending a control node; automatic activation uses `matchSkills` and appends no more than the configured caps; snapshot creation copies index/state/matches and loads bodies only for explicit invocation or `full` mode.
- [ ] **Step 5: Implement the read-only tool.** Create a zod schema `{ skill: z.string(), path: z.string().optional() }`, call `readSkillResource` inside `execute`, return text/image content and bounded details, and never alter `createAllTools`' ordinary jail or confirmation policy.
- [ ] **Step 6: Wire the CLI startup.** Add `@z-agent/skills` as an exact dependency, instantiate the manager regardless of trust, keep extensions under the existing trust branch, remove `formatSkillsPrompt(skills)` from static `systemPrompt`, append the read tool to the coding tools, and pass the manager snapshot hook to `Agent`.
- [ ] **Step 7: Run manager and existing skill tests.**

Run: `npx vitest --run packages/cli/test/skills.test.ts packages/cli/test/skill-manager.test.ts`
Expected: discovery, trust split, reload, snapshot immutability, and `skill_read` security tests pass.

## Task 10: Slash Parser, Commands, and Streaming FIFO Queue

**Files:**
- Create: `packages/cli/src/slash.ts`
- Create: `packages/cli/test/slash.test.ts`
- Modify: `packages/cli/src/interactive-commands.ts`
- Modify: `packages/cli/src/interactive.ts`
- Modify: `packages/cli/src/print.ts`
- Modify: `packages/cli/test/interactive.test.ts`

**Interfaces:**
- Consumes: `SkillManager`, built-in command names, and the existing `Agent.steer`/`Agent.prompt` APIs.
- Produces: `parseSlashInput(line, index, commands): ParsedInput`, `commandMenuItems(commands)`, and `runInteractive` callbacks for skill actions.

```ts
export type ParsedInput =
	| { kind: "builtin"; name: string; args: string }
	| { kind: "skill"; name: string; args: string; explicit: boolean }
	| { kind: "text"; text: string }
	| { kind: "error"; message: string };

export function parseSlashInput(
	line: string,
	index: SkillIndex,
	commands?: readonly InteractiveCommand[],
): ParsedInput;
```

- [x] **Step 1: Write parser precedence tests.** Assert built-ins win over same-named skills, exact `/<skill-name>` and `/skill <name> args` invoke the selected skill, `/skill -name`, `/skill all`, `/skills query`, `/skills mode progressive|full|index`, and `/reload` parse correctly. Assert unknown slash text remains ordinary text, while malformed `/skill` returns `kind: "error"`.
- [x] **Step 2: Implement the pure parser.** Tokenize only the command prefix, preserve the remainder as `args`, check built-ins first, then exact skill names, and do not activate or read files inside the parser.
- [ ] **Step 3: Write interactive command tests.** Exercise `/skills` filtering/status output, mode changes, explicit argument non-persistence, hidden-skill invocation, `/new`, `/reset`, and pending FIFO behavior while a provider run is active. Assert a queued `/reload` is applied before later queued skill actions and the active provider request keeps its old snapshot.
- [ ] **Step 4: Implement command execution.** Add `/skills`, `/skill`, and `/reload` to the command registry; execute parsed actions at safe boundaries, append session controls, print structured diagnostics without private bodies, and route ordinary text through automatic matching before `agent.prompt`.
- [ ] **Step 5: Integrate TUI streaming and print mode.** Change `submitTuiInputDuringRun` to enqueue parsed slash actions separately from ordinary steering text. Reuse `parseSlashInput` in `runPrint`; print mode has no completion UI but has identical explicit syntax and error handling.
- [ ] **Step 6: Run command tests.**

Run: `npx vitest --run packages/cli/test/slash.test.ts packages/cli/test/interactive.test.ts`
Expected: precedence, arguments, queue ordering, reload status, and print-mode parser cases pass.

## Task 11: TUI Slash Completion with Tab Cycling

**Files:**
- Modify: `packages/tui/src/keys.ts`
- Modify: `packages/tui/src/editor.ts`
- Modify: `packages/tui/src/model.ts`
- Modify: `packages/tui/src/layout.ts`
- Modify: `packages/tui/src/session.ts`
- Modify: `packages/tui/src/index.ts`
- Modify: `packages/tui/test/tui.test.ts`
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Consumes: command and skill names from the CLI completion provider.
- Produces: `shiftTab` key parsing, `TuiCompletionCandidate`, a fixed-height completion popup, and editor range replacement that leaves arguments and cursor-relative text intact.

```ts
export type Key = ExistingKey | { type: "shiftTab" };
export interface TuiCompletionCandidate { token: string; description: string; kind: "command" | "skill"; }
export interface TuiCompletionState { items: readonly TuiCompletionCandidate[]; index: number; tokenStart: number; tokenEnd: number; }
```

- [ ] **Step 1: Write key/editor tests.** Assert `parseKey("\x1b[Z")` is `shiftTab`, incomplete escape sequences remain buffered, `EditorBuffer` can replace a `[start,end)` range, and replacing `/ski` in `/ski arg text` yields `/skill arg text` with the argument unchanged.
- [ ] **Step 2: Implement completion ranking.** Add a pure helper that orders exact, case-insensitive prefix, case-insensitive substring, ordered fuzzy subsequence, then stable kind/name ties. It returns a maximum of the configured popup rows and never invokes commands.
- [ ] **Step 3: Implement session state and dispatch.** Detect a first editor token beginning with `/`; maintain completion state on character/backspace/cursor edits; intercept `Tab` to accept/cycle, `shiftTab` to cycle backward, and `Esc` to cancel. When no popup is active, preserve the existing Tab transcript focus behavior and confirmation priority.
- [ ] **Step 4: Render the popup.** Add completion data to `TuiFrameState`, render a bounded popup above the editor with the selected row marked, preserve width clipping and ANSI sanitization, and keep the 80x24 footer/editor usable.
- [ ] **Step 5: Wire candidates from CLI.** Pass a callback from `cli.ts` that combines `INTERACTIVE_COMMANDS` and visible skill names; refresh candidates after `/reload` without activating a skill.
- [ ] **Step 6: Run TUI tests.**

Run: `npx vitest --run packages/tui/test/tui.test.ts`
Expected: ranking, Tab/Shift+Tab/Esc behavior, argument preservation, popup bounds, existing inspector focus, and confirmation regressions pass.

## Task 12: Dynamic Provider Context and Session Lifecycle Integration

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/interactive.ts`
- Modify: `packages/cli/src/compaction.ts`
- Modify: `packages/cli/test/smoke.test.ts`
- Create: `packages/cli/test/skills-provider-context.test.ts`

**Interfaces:**
- Consumes: `SkillManager.prepareSnapshot`, `formatAvailableSkills`, `formatActiveSkills`, `formatSkillInvocation`, session control helpers, and Agent `prepareContext`.
- Produces: a provider hook that builds one immutable snapshot immediately before every request and never stores supplemental XML in `Agent.state.messages`.

- [ ] **Step 1: Write provider-context tests.** Capture every scripted provider context and assert sections appear in order, the first request includes metadata without eagerly loading all bodies, explicit invocation includes a complete body and current-only args, and a reload during streaming affects only the next request.
- [ ] **Step 2: Write lifecycle tests.** Assert `/new` starts with empty skill state, `/reset` clears active/manual-off/mode state, resume restores controls before reconciliation, compaction leaves controls intact, and stale/missing hashes are reported but not rebound silently.
- [ ] **Step 3: Implement the immutable hook.** In `cli.ts`, close over the manager and pass:

```ts
prepareContext: async (context) => {
	const snapshot = await skillManager.prepareSnapshot({ text: currentRequestText, pathHints: currentPathHints });
	const rendered = renderSkillSnapshot(snapshot);
	return { ...context, systemPrompt: `${context.systemPrompt}${rendered}` };
},
```

The hook must copy `messages`/`tools`, use the snapshot captured for that request, and leave the live transcript unchanged. Update the request text/path hints at each safe turn boundary, including steering/follow-up.
- [ ] **Step 4: Integrate new/reset/resume/compaction.** Restore `skillStateOnLeaf` whenever `session` changes, append control nodes for actions, reset manager state alongside `agent.reset()`, and ensure compaction only changes message nodes.
- [ ] **Step 5: Run provider-context tests.**

Run: `npx vitest --run packages/cli/test/skills-provider-context.test.ts packages/cli/test/smoke.test.ts`
Expected: dynamic sections, immutable snapshots, lifecycle restoration, and no-control-node-in-transcript assertions pass.

## Task 13: ADR, Glossary, and Product Documentation

**Files:**
- Modify: `docs/adr/0022-pillow-home.md`
- Modify: `docs/glossary.md`
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/tui/README.md`
- Create: `packages/skills/README.md`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: the implemented public APIs and the approved skills product specification.
- Produces: documentation that describes the trust split, `.pillow` roots, progressive disclosure, control-node persistence, slash syntax, `skill_read`, and completion behavior without claiming remote installation or authorization from `allowed-tools`.

- [ ] **Step 1: Update ADR-0022.** Replace the statement that skills and extensions share one trust gate with separate bullets: skills discovery/activation is local and available without project trust; executable extensions remain trust-gated. Record project-over-user precedence and manifest confinement.
- [ ] **Step 2: Add glossary terms.** Define discovered/active/loaded/stale skill states, manual-off tombstone, skill snapshot, skill control node, progressive/full/index modes, and `prepareContext`; revise the existing “Skills / extensions / project trust” entry.
- [ ] **Step 3: Document user-facing operation.** Add examples for `/<skill-name> [args]`, `/skill`, `/skills`, `/skills mode`, `/reload`, `Tab`/`Shift+Tab`, and the constrained `skill_read` tool. State that skill instructions are untrusted supplemental context and `allowed-tools` is advisory.
- [ ] **Step 4: Run documentation consistency checks.**

Run: `rg -n "\.agents|skills and extensions|formatSkillsPrompt|H1-only|allowed-tools.*author" docs README.md packages/*/README.md`
Expected: no stale product claims remain; historical ADR references are updated or explicitly marked as superseded.

## Task 14: Focused Verification and Entry-Point Proof

**Files:**
- Modify: `packages/skills/test/*.test.ts` only when a discovered gap is identified by the preceding tasks.
- Modify: `packages/cli/test/*.test.ts` only for integration regressions found during verification.
- Create: `docs/evidence/skills-product-evidence.json` only after an observable entry-point run succeeds.

**Interfaces:**
- Consumes: all package APIs and the real `npm run z-agent` entrypoint.
- Produces: passing focused tests, a clean repository check, and evidence that the interactive and print paths use the same command/activation semantics.

- [ ] **Step 1: Install exact dependencies if package manifests changed.**

Run: `npm install --ignore-scripts`
Expected: lockfile resolves exact `yaml` and `picomatch` versions and workspace links include `@z-agent/skills`.

- [ ] **Step 2: Run changed tests by package.**

Run: `npx vitest --run packages/skills/test packages/agent/test/agent-loop.test.ts packages/agent/test/agent.test.ts packages/cli/test/skills.test.ts packages/cli/test/skill-manager.test.ts packages/cli/test/slash.test.ts packages/cli/test/skills-provider-context.test.ts packages/cli/test/sessions.test.ts packages/cli/test/skill-session.test.ts packages/tui/test/tui.test.ts`
Expected: all selected tests pass; do not run unrelated full suites merely because the plan exists.

- [ ] **Step 3: Run the repository check.**

Run: `npm run check`
Expected: Biome completes without warnings and all six package TypeScript projects, including `packages/skills`, type-check successfully.

- [ ] **Step 4: Verify print mode.** In an isolated temporary cwd with a minimal `.pillow/skills/demo/SKILL.md` and configured model, run:

```bash
npx z-agent -p --yes '/demo review this file'
```

Expected: the explicit invocation is parsed, the body is included for that request, arguments are not persisted as skill configuration, and the saved session contains a `skill_activation` node but no skill XML message.

- [ ] **Step 5: Verify interactive mode.** Run `npm run z-agent` in a TTY, type `/de`, press `Tab`, confirm the command token completes while any argument remains, press `Enter`, then inspect `/skills` and `/reload`. Verify a running provider keeps its old snapshot while queued commands execute FIFO at the safe boundary. Repeat with `NO_COLOR=1` and fixed 80x24 dimensions.
- [ ] **Step 6: Create evidence only after observation.** Record focused commands, `npm run check`, TTY dimensions, completion/activation observations, limitations, and artifact paths in `docs/evidence/skills-product-evidence.json`; do not claim entry-point verification if no configured model or TTY is available.

## Self-Review Against the Specification

1. **Spec coverage:** Tasks 1-6 cover package contracts, parsing, recursive and manifest discovery, path safety, precedence, deterministic matching, state reduction, rendering, budgeting, and resource reads. Task 7 covers the provider seam. Tasks 8-12 cover control-node persistence, trust split, CLI manager, `skill_read`, dynamic snapshots, slash syntax, FIFO streaming behavior, lifecycle operations, and TUI completion. Task 13 covers ADR/glossary/product docs. Task 14 covers focused tests, `npm run check`, print/TUI proof, and evidence. No requirement in sections 1-17 is intentionally unassigned.
2. **Placeholder scan:** The plan contains no `TBD`, `TODO`, “implement later”, or unnamed edge-case steps. Every task names exact files, public interfaces, test commands, and expected outcomes.
3. **Type consistency:** `SkillIndex`, `SkillState`, `SkillStateNode`, `Budget`, `RenderResult`, `SkillContextSnapshot`, `SkillManager`, `ParsedInput`, and `TuiCompletionState` are introduced before later tasks consume them. The agent hook is named `prepareContext` consistently in `AgentOptions`, `AgentLoopConfig`, `streamAssistant`, and CLI wiring.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-27-skills-product-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, and integrate each independently testable deliverable.

**2. Inline Execution** - execute the tasks in this session using executing-plans with checkpoints.

Choose `1` or `2`.
