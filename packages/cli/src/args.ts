import { DEFAULT_BASH_TIMEOUT } from "@z-agent/agent";
import type { ProviderApi } from "@z-agent/ai";

export const DEFAULT_MODEL_ID = "gpt-4.1-mini";

const PROVIDER_API_VALUES: readonly ProviderApi[] = ["openai-responses", "openai-completions", "anthropic-messages"];

export interface CliArgs {
	help: boolean;
	verbose: boolean;
	yes: boolean;
	noJail: boolean;
	print: boolean;
	listModels: boolean;
	listSessions: boolean;
	durable: boolean;
	durableBackend: "jsonl" | "sqlite";
	cwd?: string;
	model?: string;
	api?: ProviderApi;
	sessionDir?: string;
	session?: string;
	resume: boolean;
	continueSession: boolean;
	extensionPaths: string[];
	promptParts: string[];
	contextWindow?: number;
	maxTokens?: number;
	bashTimeout?: number;
	bashEnv: "scrub" | "inherit";
	error?: string;
}

export function parseArgs(argv: string[]): CliArgs {
	let help = false;
	let verbose = false;
	let yes = false;
	let noJail = false;
	let print = false;
	let listModels = false;
	let listSessions = false;
	let durable = false;
	let durableBackend: "jsonl" | "sqlite" = "jsonl";
	let cwd: string | undefined;
	let model: string | undefined;
	let api: ProviderApi | undefined;
	let sessionDir: string | undefined;
	let session: string | undefined;
	let resume = false;
	let continueSession = false;
	const extensionPaths: string[] = [];
	let contextWindow: number | undefined;
	let maxTokens: number | undefined;
	let bashTimeout: number | undefined;
	let bashEnv: "scrub" | "inherit" = "scrub";
	let error: string | undefined;
	const promptParts: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--verbose" || arg === "-v") {
			verbose = true;
			continue;
		}
		if (arg === "--yes" || arg === "-y") {
			yes = true;
			continue;
		}
		if (arg === "--no-jail") {
			noJail = true;
			continue;
		}
		if (arg === "-p" || arg === "--print") {
			print = true;
			continue;
		}
		if (arg === "--durable") {
			durable = true;
			continue;
		}
		if (arg === "--durable-backend") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				error = `Missing value for ${arg}`;
				break;
			}
			if (value !== "jsonl" && value !== "sqlite") {
				error = `Invalid value for ${arg}`;
				break;
			}
			durableBackend = value;
			i += 1;
			continue;
		}
		if (arg === "--api") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				error = `Missing value for ${arg}`;
				break;
			}
			if (!PROVIDER_API_VALUES.includes(value as ProviderApi)) {
				error = `Invalid value for ${arg}`;
				break;
			}
			api = value as ProviderApi;
			i += 1;
			continue;
		}
		if (arg === "--bash-timeout") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				error = `Missing value for ${arg}`;
				break;
			}
			const parsed = Number(value);
			if (
				!/^\d+$/u.test(value) ||
				!Number.isSafeInteger(parsed) ||
				parsed < 1 ||
				parsed > DEFAULT_BASH_TIMEOUT.maxSeconds
			) {
				error = `Invalid value for ${arg} (expected 1-${DEFAULT_BASH_TIMEOUT.maxSeconds} seconds)`;
				break;
			}
			bashTimeout = parsed;
			i += 1;
			continue;
		}
		if (arg === "--bash-env") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				error = `Missing value for ${arg}`;
				break;
			}
			if (value !== "scrub" && value !== "inherit") {
				error = `Invalid value for ${arg}`;
				break;
			}
			bashEnv = value;
			i += 1;
			continue;
		}
		if (arg === "--list-models") {
			listModels = true;
			continue;
		}
		if (arg === "--list-sessions") {
			listSessions = true;
			continue;
		}
		if (arg === "--resume") {
			resume = true;
			continue;
		}
		if (arg === "--continue") {
			continueSession = true;
			continue;
		}
		if (
			arg === "--cwd" ||
			arg === "--model" ||
			arg === "--session-dir" ||
			arg === "--session" ||
			arg === "--extension" ||
			arg === "--context-window" ||
			arg === "--max-tokens"
		) {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				error = `Missing value for ${arg}`;
				break;
			}
			if (arg === "--context-window" || arg === "--max-tokens") {
				const parsed = Number(value);
				if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
					error = `Invalid value for ${arg}`;
					break;
				}
				if (arg === "--context-window") {
					contextWindow = parsed;
				} else {
					maxTokens = parsed;
				}
			} else if (arg === "--cwd") {
				cwd = value;
			} else if (arg === "--model") {
				model = value;
			} else if (arg === "--session-dir") {
				sessionDir = value;
			} else if (arg === "--session") {
				session = value;
			} else {
				extensionPaths.push(value);
			}
			i += 1;
			continue;
		}
		if (arg.startsWith("-")) {
			error = `Unknown flag: ${arg}`;
			break;
		}
		promptParts.push(arg);
	}

	return {
		help,
		verbose,
		yes,
		noJail,
		print,
		listModels,
		listSessions,
		durable,
		durableBackend,
		cwd,
		model,
		api,
		sessionDir,
		session,
		resume,
		continueSession,
		extensionPaths,
		promptParts,
		contextWindow,
		maxTokens,
		bashTimeout,
		bashEnv,
		error,
	};
}

export function printHelp(write: (text: string) => void = console.log): void {
	write(`z-agent — local coding agent (OpenAI Responses + TUI)

Usage:
  z-agent                         Interactive TUI (TTY)
  z-agent -p [prompt...]          Print mode (also default for non-TTY)
  z-agent --help

Flags:
  --cwd <dir>        Working directory
  --model <id>       Model id or catalog alias
  --api <api>        Provider api: openai-responses (default) | openai-completions | anthropic-messages
  --yes              Skip tool confirmation
  --no-jail          Allow paths outside cwd
  -p, --print        Print mode
  --verbose          Lifecycle events (print mode)
  --resume           Resume latest session for cwd
  --continue         Alias for --resume
  --session <id>     Open a session id
  (the TUI always opens a fresh session; use /sessions to resume)
  --session-dir <d>  Session storage directory
  --extension <p>    Load an extension module
  --durable          Use L5 harness (op.state)
  --durable-backend <b>  op.state backend: jsonl (default) | sqlite
  --list-models      List configured model aliases
  --list-sessions    List sessions for --cwd
  --context-window <n>  Override context window tokens
  --max-tokens <n>      Override max output tokens
  --bash-timeout <n>    Bash default timeout seconds (1-3600, default 600)
  --bash-env <mode>     Bash child env: scrub (default) | inherit
  -h, --help         Help

Interactive commands:
  Ctrl+P or /commands  Search available TUI commands

Env:
  OPENAI_API_KEY    API key for openai-responses/openai-completions (or config.json apiKey)
  OPENAI_BASE_URL   Optional
  ANTHROPIC_API_KEY API key for anthropic-messages (or config.json apiKey)
  ANTHROPIC_BASE_URL Optional
  OPENAI_MODEL      Alias or raw model id
  OPENAI_CONTEXT_WINDOW  Optional context window
  OPENAI_MAX_TOKENS      Optional max output tokens
  PILLOW_HOME       Override ~/.pillow

Config:
  ~/.pillow/config.json   Model catalog (aliases, thinking, context)
  ~/.pillow/keys.json     TUI key bindings (interrupt stays ctrl+c)
`);
}

export function looksLikeReasoningModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("gpt-5") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.includes("reason")
	);
}

/** Flag then env. No built-in model id — catalog / raw id live in config.ts. */
export function resolveModelId(args: CliArgs, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const flag = args.model?.trim();
	if (flag) {
		return flag;
	}
	const fromEnv = env.OPENAI_MODEL?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}
