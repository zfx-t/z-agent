export const DEFAULT_MODEL_ID = "gpt-4.1-mini";

export interface CliArgs {
	help: boolean;
	verbose: boolean;
	yes: boolean;
	noJail: boolean;
	print: boolean;
	listModels: boolean;
	listSessions: boolean;
	durable: boolean;
	cwd?: string;
	model?: string;
	sessionDir?: string;
	session?: string;
	resume: boolean;
	continueSession: boolean;
	extensionPaths: string[];
	promptParts: string[];
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
	let cwd: string | undefined;
	let model: string | undefined;
	let sessionDir: string | undefined;
	let session: string | undefined;
	let resume = false;
	let continueSession = false;
	const extensionPaths: string[] = [];
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
			arg === "--extension"
		) {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				error = `Missing value for ${arg}`;
				break;
			}
			if (arg === "--cwd") {
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
		cwd,
		model,
		sessionDir,
		session,
		resume,
		continueSession,
		extensionPaths,
		promptParts,
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
  --model <id>       Model id
  --yes              Skip tool confirmation
  --no-jail          Allow paths outside cwd
  -p, --print        Print mode
  --verbose          Lifecycle events (print mode)
  --resume           Resume latest session for cwd
  --continue         Alias for --resume
  --session <id>     Open a session id
  (TUI also offers a session picker and /sessions)
  --session-dir <d>  Session storage directory
  --extension <p>    Load an extension module
  --durable          Use L5 harness (JSONL op.state)
  --list-models      List configured model aliases
  --list-sessions    List sessions for --cwd
  -h, --help         Help

Interactive commands:
  Ctrl+P or /commands  Search available TUI commands

Env:
  OPENAI_API_KEY    API key (or config.json apiKey)
  OPENAI_BASE_URL   Optional
  OPENAI_MODEL      Alias or raw model id
  PILLOW_HOME       Override ~/.pillow

Config:
  ~/.pillow/config.json   Model catalog (aliases, thinking, context)
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
