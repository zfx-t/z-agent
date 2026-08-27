/**
 * z-agent product CLI: TUI + print, coding tools, sessions, skills, optional L5.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { stdin } from "node:process";
import { Agent, type AgentMessage, createAllTools } from "@z-agent/agent";
import { createOpenAIResponsesModel, createOpenAIResponsesStream, type StreamFn } from "@z-agent/ai";
import { JsonlOpStore, wrapStreamFn, wrapTools } from "@z-agent/harness";
import { InteractiveTui } from "@z-agent/tui";
import { SigintAbort } from "./abort.ts";
import { looksLikeReasoningModel, parseArgs, printHelp } from "./args.ts";
import { applyCompactionToSession, needsCompaction } from "./compaction.ts";
import { ensureStarterConfig, loadCatalog, modelRefFromArgs, NO_MODEL_WARNING, resolveModel } from "./config.ts";
import { createConfirmGate } from "./confirm.ts";
import { composeBefore, discoverExtensionPaths, type Extension, loadExtension } from "./extensions.ts";
import { runInteractive, submitTuiInputDuringRun } from "./interactive.ts";
import { prepareProjectPillow, prepareUserPillow } from "./pillow-home.ts";
import { runPrint } from "./print.ts";
import {
	appendMessage,
	createSession,
	latestSessionId,
	listSessionIds,
	loadSession,
	messagesOnLeaf,
	type SessionRecord,
	saveSession,
} from "./sessions.ts";
import { formatSkillsPrompt, loadSkills } from "./skills.ts";
import { buildCodingSystemPrompt } from "./system-prompt.ts";
import { askYesNo, ensureProjectTrust } from "./trust.ts";

async function readStdinText(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function syncSession(session: SessionRecord, messages: AgentMessage[]): void {
	const have = messagesOnLeaf(session).length;
	for (const message of messages.slice(have)) {
		appendMessage(session, message);
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.error) {
		console.error(args.error);
		printHelp(console.error);
		process.exit(2);
	}
	if (args.help) {
		printHelp();
		process.exit(0);
	}

	const cwd = args.cwd ?? process.cwd();
	const userPillow = await prepareUserPillow();
	await prepareProjectPillow(cwd);
	await ensureStarterConfig(userPillow);
	const loaded = await loadCatalog(userPillow);
	if (loaded.warning) {
		console.error(`warning: ${loaded.warning}`);
	}
	if (args.listModels) {
		if (!loaded.catalog) {
			console.error(loaded.warning ?? "error: no model catalog");
			process.exit(1);
		}
		for (const [alias, model] of Object.entries(loaded.catalog.models)) {
			const marker = alias === loaded.catalog.defaultModel ? " *" : "";
			console.log(`${alias}\t${model.id}${marker}`);
		}
		return;
	}
	if (args.listSessions) {
		for (const id of await listSessionIds(cwd, args.sessionDir)) {
			console.log(id);
		}
		return;
	}
	const resolved = resolveModel(modelRefFromArgs(args.model), loaded.catalog);
	if (!resolved.hasModel) {
		console.error(resolved.warning);
	}

	const apiKey = resolved.hasModel ? resolved.apiKey : undefined;
	if (resolved.hasModel && !apiKey) {
		console.error("error: OPENAI_API_KEY is required (or set apiKey in ~/.pillow/config.json)");
		process.exit(1);
	}

	const modelId = resolved.hasModel ? resolved.id : "unknown";
	const jail = !args.noJail;
	const isTty = Boolean(stdin.isTTY);
	const usePrint = args.print || !isTty || args.promptParts.length > 0;
	const autoYes = usePrint || args.yes;

	if (resolved.hasModel && looksLikeReasoningModel(modelId) && args.verbose) {
		console.error(`[model] ${modelId} reasoning replay enabled`);
	}

	let prompt = args.promptParts.join(" ").trim();
	if (usePrint && !prompt && !isTty) {
		prompt = await readStdinText();
		if (!prompt && !args.resume && !args.continueSession && !args.session) {
			console.error("error: prompt required (pass arguments, or pipe stdin)");
			process.exit(2);
		}
	}

	const sessionRoot = args.sessionDir;
	let session: SessionRecord;
	if (args.session) {
		session = await loadSession(cwd, args.session, sessionRoot);
	} else if (args.resume || args.continueSession) {
		const id = await latestSessionId(cwd, sessionRoot);
		session = id ? await loadSession(cwd, id, sessionRoot) : createSession(cwd);
	} else {
		session = createSession(cwd);
	}

	const projectPillow = join(cwd, ".pillow");
	const trusted = (await pathExists(projectPillow))
		? await ensureProjectTrust(cwd, async () => {
				if (autoYes) {
					return true;
				}
				return await askYesNo(`Trust project resources in ${cwd}?`);
			})
		: true;

	const skills = trusted ? await loadSkills(cwd) : [];
	const extensions: Extension[] = [];
	if (trusted) {
		for (const extPath of await discoverExtensionPaths(cwd)) {
			extensions.push(await loadExtension(extPath, cwd));
		}
		for (const extPath of args.extensionPaths) {
			extensions.push(await loadExtension(extPath, cwd));
		}
	}

	let streamFn: StreamFn = createOpenAIResponsesStream({
		apiKey,
		baseUrl: resolved.hasModel ? resolved.baseUrl : process.env.OPENAI_BASE_URL,
	});
	let tools = createAllTools(cwd, { jailRoot: jail ? cwd : false });
	if (args.durable) {
		const store = new JsonlOpStore(join(projectPillow, "harness"));
		streamFn = wrapStreamFn(streamFn, store);
		tools = wrapTools(tools, store);
	}

	let agent!: Agent;
	const abort = new SigintAbort(() => agent);
	const statusModel = resolved.hasModel ? (resolved.alias ? `${resolved.alias}(${modelId})` : modelId) : "none";
	const tui = !usePrint
		? new InteractiveTui({
				status: () => `model=${statusModel}  cwd=${cwd}`,
				header: () => ({
					cwd,
					model: statusModel,
					session: session.header.id.slice(0, 12),
				}),
				onSubmitDuringRun: (line) => {
					submitTuiInputDuringRun(agent, line);
				},
				onInterrupt: () => {
					abort.handleSigint();
				},
			})
		: undefined;

	if (tui && !args.session && !args.resume && !args.continueSession) {
		const ids = await listSessionIds(cwd, sessionRoot);
		if (ids.length > 0) {
			tui.start();
			const index = await tui.pickFromList("Sessions", ["(new session)", ...ids], { cancelValue: 0 });
			if (index > 0) {
				session = await loadSession(cwd, ids[index - 1], sessionRoot);
			}
		}
	}

	const confirmGate = createConfirmGate({
		autoYes,
		ask: async (toolName, toolArgs) => {
			if (!tui) {
				return "once";
			}
			return await tui.confirmTool(toolName, toolArgs);
		},
	});

	const model = createOpenAIResponsesModel({
		id: modelId,
		baseUrl: resolved.hasModel ? resolved.baseUrl : undefined,
		contextWindow: resolved.hasModel ? resolved.contextWindow : undefined,
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
	});
	agent = new Agent({
		streamFn,
		apiKey,
		beforeToolCall: composeBefore(confirmGate, extensions),
		afterToolCall: async (context, signal) => {
			for (const ext of extensions) {
				const result = await ext.afterToolCall?.(context, signal);
				if (result) {
					return result;
				}
			}
			return undefined;
		},
		initialState: {
			model,
			thinkingLevel: resolved.hasModel ? resolved.thinking : "off",
			systemPrompt: `${buildCodingSystemPrompt(cwd, jail)}${formatSkillsPrompt(skills)}`,
			tools,
			messages: messagesOnLeaf(session),
		},
	});

	abort.attach();

	const compactNow = async () => {
		const { kept, summary } = await applyCompactionToSession(session, agent.state.messages, {
			contextWindow: agent.state.model.contextWindow,
			streamFn,
			model: agent.state.model,
		});
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: summary }], timestamp: Date.now() },
			...kept,
		];
	};

	const persist = async () => {
		syncSession(session, agent.state.messages);
		if (needsCompaction(agent.state.messages, { contextWindow: agent.state.model.contextWindow })) {
			await compactNow();
		}
		await saveSession(session, sessionRoot);
	};

	if (usePrint) {
		if (!prompt) {
			console.error("error: prompt required");
			process.exit(2);
		}
		if (!resolved.hasModel) {
			console.error(NO_MODEL_WARNING);
			abort.detach();
			process.exit(1);
		}
		console.error(`[mode] print model=${statusModel} cwd=${cwd}`);
		await runPrint(agent, prompt, args.verbose);
		await persist();
		abort.detach();
		if (agent.state.errorMessage) {
			console.error(`[error] ${agent.state.errorMessage}`);
			process.exit(1);
		}
		return;
	}

	if (!tui) {
		process.exit(1);
	}
	await runInteractive({
		agent,
		tui,
		hasModel: resolved.hasModel,
		onNew: async () => {
			await persist();
			session = createSession(cwd);
			agent.reset();
		},
		onCompact: async () => {
			await compactNow();
			await saveSession(session, sessionRoot);
		},
		listSessions: async () => await listSessionIds(cwd, sessionRoot),
		onLoadSession: async (id) => {
			session = await loadSession(cwd, id, sessionRoot);
			return messagesOnLeaf(session);
		},
	});
	await persist();
	abort.detach();
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
