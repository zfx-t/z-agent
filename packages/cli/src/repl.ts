import * as readline from "node:readline/promises";
import type { Agent } from "@z-agent/agent";
import type { SigintAbort } from "./abort.ts";

export interface ReplOptions {
	agent: Agent;
	abort: SigintAbort;
	stdin?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	prompt?: string;
}

/**
 * Multi-turn REPL on a single Agent. Empty lines are ignored.
 * /exit and /quit leave; /reset clears the transcript.
 */
export async function runRepl(options: ReplOptions): Promise<void> {
	const input = options.stdin ?? process.stdin;
	const output = options.stdout ?? process.stdout;
	const prompt = options.prompt ?? "> ";
	const rl = readline.createInterface({ input, output });

	const onRlSigint = () => {
		if (options.agent.state.isStreaming) {
			options.agent.abort();
			return;
		}
		rl.close();
	};
	rl.on("SIGINT", onRlSigint);

	try {
		while (true) {
			let line: string;
			try {
				line = await rl.question(prompt);
			} catch {
				break;
			}
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			if (trimmed === "/exit" || trimmed === "/quit") {
				break;
			}
			if (trimmed === "/reset") {
				options.agent.reset();
				output.write("[reset]\n");
				continue;
			}

			try {
				await options.agent.prompt(trimmed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				output.write(`[error] ${message}\n`);
			}
			if (options.agent.state.errorMessage) {
				output.write(`[error] ${options.agent.state.errorMessage}\n`);
			}
			options.abort.resetAfterIdle();
		}
	} finally {
		rl.off("SIGINT", onRlSigint);
		rl.close();
	}
}
