/**
 * Child-environment policy for the bash tool. Pure derivation from a source
 * env (defaults `process.env`); no effects. Default mode scrubs secret-shaped
 * variable names so model-issued commands cannot read provider credentials.
 */

/** Name patterns removed in scrub mode. Case-insensitive, full-key anchored. */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
	/_API_KEY$/iu,
	/_SECRET(_KEY|_ACCESS_KEY)?$/iu,
	/_TOKEN$/iu,
	/_PASSWORD$/iu,
	/_PASSWD$/iu,
	/_CREDENTIALS?$/iu,
	/_PRIVATE_KEY$/iu,
	/^AWS_SESSION_TOKEN$/iu,
	/^GH_TOKEN$/iu,
	/^GITHUB_TOKEN$/iu,
	/^NPM_TOKEN$/iu,
	/^OPENAI_API_KEY$/iu,
	/^ANTHROPIC_API_KEY$/iu,
	/^AZURE_OPENAI_API_KEY$/iu,
	/^GOOGLE_API_KEY$/iu,
	/^HF_TOKEN$/iu,
	/^DATABASE_URL$/iu,
];

/**
 * Keys the child always needs; never scrubbed regardless of patterns.
 * Compared against the normalized key (uppercase on win32). `LC_` is a prefix,
 * handled separately.
 */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"LANG",
	"TERM",
	"TMPDIR",
	"TEMP",
	"TMP",
	"COMSPEC",
	"SYSTEMROOT",
	"PATHEXT",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PWD",
]);

export interface BashEnvPolicy {
	/** "scrub" applies the denylist; "inherit" copies the source unchanged. */
	mode: "scrub" | "inherit";
	/** Extra name patterns to drop, on top of {@link DEFAULT_SECRET_PATTERNS}. */
	deny?: readonly RegExp[];
	/** Exact key names that win over deny patterns (normalized on win32). */
	allow?: readonly string[];
	/** Applied last, verbatim; may set names the source never had. */
	set?: Readonly<Record<string, string>>;
}

export const DEFAULT_BASH_ENV_POLICY: BashEnvPolicy = { mode: "scrub" };

export function buildChildEnv(
	source: NodeJS.ProcessEnv,
	policy: BashEnvPolicy = DEFAULT_BASH_ENV_POLICY,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	const normalize = (key: string): string => (platform === "win32" ? key.toUpperCase() : key);
	if (policy.mode === "inherit") {
		for (const [key, value] of Object.entries(source)) {
			if (value !== undefined) {
				env[key] = value;
			}
		}
	} else {
		const deny = [...DEFAULT_SECRET_PATTERNS, ...(policy.deny ?? [])];
		const allow = new Set((policy.allow ?? []).map(normalize));
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined) {
				continue;
			}
			const cmp = normalize(key);
			if (PROTECTED_KEYS.has(cmp) || cmp.startsWith("LC_") || allow.has(cmp)) {
				env[key] = value;
				continue;
			}
			if (deny.some((pattern) => pattern.test(cmp))) {
				continue;
			}
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(policy.set ?? {})) {
		env[key] = value;
	}
	return env;
}
