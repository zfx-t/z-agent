/**
 * Minimal smoke CLI for @z-agent/agent + @z-agent/ai.
 *
 * Default: offline faux stream (no API key).
 * Live: `--live` + `OPENAI_API_KEY` → OpenAI Responses stream.
 */

import { Agent, type AgentEvent, type AgentTool } from "@z-agent/agent";
import {
	createFauxStream,
	createOpenAIResponsesModel,
	createOpenAIResponsesStream,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Model,
	type StreamFn,
} from "@z-agent/ai";
import { z } from "zod";

const DEFAULT_PROMPT = "Say hello, then echo the word hi with the echo tool.";

const echoSchema = z.object({
	text: z.string().describe("Text to echo back"),
});

function createEchoTool(): AgentTool<typeof echoSchema, { text: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back to the conversation",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `echo: ${params.text}` }],
				details: { text: params.text },
			};
		},
	};
}

function printEvent(event: AgentEvent): void {
	switch (event.type) {
		case "agent_start":
			console.log("[agent_start]");
			break;
		case "turn_start":
			console.log("[turn_start]");
			break;
		case "message_start": {
			const role = "role" in event.message ? event.message.role : "?";
			console.log(`[message_start] role=${role}`);
			break;
		}
		case "message_end": {
			const msg = event.message;
			if (msg && typeof msg === "object" && "role" in msg && msg.role === "assistant" && "content" in msg) {
				const texts = Array.isArray(msg.content)
					? msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text)
					: [];
				if (texts.length > 0) {
					console.log(`[assistant] ${texts.join("")}`);
				}
			}
			if (msg && typeof msg === "object" && "role" in msg && msg.role === "toolResult" && "content" in msg) {
				const texts = Array.isArray(msg.content)
					? msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text)
					: [];
				if (texts.length > 0) {
					console.log(`[toolResult] ${texts.join("")}`);
				}
			}
			break;
		}
		case "tool_execution_start":
			console.log(`[tool_start] ${event.toolName} ${JSON.stringify(event.args)}`);
			break;
		case "tool_execution_end":
			console.log(`[tool_end] ${event.toolName} error=${event.isError}`);
			break;
		case "turn_end":
			console.log("[turn_end]");
			break;
		case "agent_end":
			console.log("[agent_end]");
			break;
		default:
			// ignore message_update / tool_execution_update noise
			break;
	}
}

function parseArgs(argv: string[]): { prompt: string; live: boolean; help: boolean } {
	let live = false;
	let help = false;
	const rest: string[] = [];
	for (const arg of argv) {
		if (arg === "--live") {
			live = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg.startsWith("-")) {
			console.error(`Unknown flag: ${arg}`);
			help = true;
		} else {
			rest.push(arg);
		}
	}
	return {
		prompt: rest.length > 0 ? rest.join(" ") : DEFAULT_PROMPT,
		live,
		help,
	};
}

function printHelp(): void {
	console.log(`z-agent — minimal agent smoke CLI

Usage:
  z-agent [prompt...]          Offline faux demo (default)
  z-agent --live [prompt...]   OpenAI Responses (needs OPENAI_API_KEY)
  z-agent --help

Env:
  OPENAI_API_KEY   Required for --live
  OPENAI_BASE_URL  Optional API base URL
`);
}

function createFauxSetup(): { streamFn: StreamFn; model: Model } {
	// Script: call echo, then finalize after tool result.
	const faux = createFauxStream({
		responses: [
			fauxAssistantMessage(
				[fauxText("Calling echo…"), fauxToolCall("echo", { text: "hi" }, { id: "demo-echo-1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done — tool path exercised."),
		],
	});
	return { streamFn: faux.streamFn, model: faux.model };
}

function createLiveSetup(apiKey: string): { streamFn: StreamFn; model: Model; apiKey: string } {
	const streamFn = createOpenAIResponsesStream({ apiKey });
	const model = createOpenAIResponsesModel({ id: "gpt-4.1-mini" });
	return { streamFn, model, apiKey };
}

async function main(): Promise<void> {
	const { prompt, live, help } = parseArgs(process.argv.slice(2));
	if (help) {
		printHelp();
		process.exit(0);
	}

	const tools = [createEchoTool()];
	let streamFn: StreamFn;
	let model: Model;
	let apiKey: string | undefined;

	if (live) {
		const envKey = process.env.OPENAI_API_KEY;
		if (!envKey) {
			console.error("error: --live requires OPENAI_API_KEY");
			process.exit(1);
		}
		const liveSetup = createLiveSetup(envKey);
		streamFn = liveSetup.streamFn;
		model = liveSetup.model;
		apiKey = liveSetup.apiKey;
		console.log(`[mode] live openai-responses model=${model.id}`);
	} else {
		const fauxSetup = createFauxSetup();
		streamFn = fauxSetup.streamFn;
		model = fauxSetup.model;
		console.log("[mode] faux (offline)");
	}

	const agent = new Agent({
		streamFn,
		apiKey,
		initialState: {
			model,
			systemPrompt: "You are a tiny demo agent. Prefer the echo tool when asked to echo.",
			tools,
		},
	});

	agent.subscribe((event) => {
		printEvent(event);
	});

	console.log(`[prompt] ${prompt}`);
	await agent.prompt(prompt);

	if (agent.state.errorMessage) {
		console.error(`[error] ${agent.state.errorMessage}`);
		process.exit(1);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
