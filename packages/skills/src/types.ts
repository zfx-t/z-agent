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
	keywords: readonly string[];
	fileGlobs: readonly string[];
	allowedTools: readonly string[];
	disableModelInvocation: boolean;
	extra: Readonly<Record<string, unknown>>;
}

export type SkillDiagnosticCode =
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

export interface SkillDiagnostic {
	code: SkillDiagnosticCode;
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
	/** Canonical paths captured while the descriptor was discovered. */
	canonicalBaseDir?: string;
	canonicalSkillPath?: string;
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

export interface SkillFsEntry {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface SkillFsStat {
	mtimeMs: number;
	size: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface SkillFs {
	readFile(path: string, encoding: "utf8"): Promise<string>;
	/** Must return at most `maxBytes`; adapters without this capability are rejected by discovery. */
	readFilePrefix?(path: string, maxBytes: number): Promise<string>;
	readdir(path: string): Promise<readonly SkillFsEntry[]>;
	lstat(path: string): Promise<SkillFsStat>;
	stat(path: string): Promise<SkillFsStat>;
	realpath(path: string): Promise<string>;
}

export interface DiscoverOptions {
	cwd: string;
	userHome?: string;
	userSkillsDir?: string;
	projectSkillsDir?: string;
	userManifest?: string;
	projectManifest?: string;
	fs?: SkillFs;
}

export interface DiscoverResult {
	skills: readonly SkillDescriptor[];
	diagnostics: readonly SkillDiagnostic[];
}

export interface ParseResult {
	descriptor?: SkillDescriptor;
	diagnostics: readonly SkillDiagnostic[];
}

export interface ResolveOptions {
	version?: number;
}

export interface ResolveResult {
	index: SkillIndex;
	diagnostics: readonly SkillDiagnostic[];
}

export interface MatchRequest {
	text: string;
	pathHints?: readonly string[];
	activeNames?: readonly string[];
	manualOffNames?: readonly string[];
	staleNames?: readonly string[];
}

export interface MatchOptions {
	threshold?: number;
	maxNew?: number;
	maxActive?: number;
}

export type SkillMatchExclusion = "threshold" | "hidden" | "manual_off" | "stale" | "turn_limit" | "session_limit";

export interface SkillMatch {
	skill: SkillDescriptor;
	score: number;
	reasons: readonly string[];
	accepted: boolean;
	exclusion?: SkillMatchExclusion;
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

export type TokenEstimator = (text: string) => number;

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

export interface SkillInvocation {
	skill: SkillDescriptor;
	body: string;
	args?: string;
}

export interface RenderSkillContextInput {
	index: SkillIndex;
	state: SkillState;
	matches?: MatchResult;
	explicitInvocation?: SkillInvocation;
	/** Full-mode bodies keyed by normalized skill name. Descriptor bodies are the fallback. */
	bodies?: ReadonlyMap<string, string>;
}

export interface SkillResource {
	skillName: string;
	relativePath: string;
	mimeType: string;
	content: string | Uint8Array;
}

export interface LoadedSkillBody {
	skillName: string;
	body: string;
	contentHash: string;
}
