/**
 * z-agent product CLI: TUI + print, coding tools, sessions, skills, optional L5.
 */

import { join } from "node:path";
import { stdin } from "node:process";
import { Agent, type AgentMessage, createAllTools } from "@z-agent/agent";
import { createOpenAIResponsesModel, createOpenAIResponsesStream, type StreamFn } from "@z-agent/ai";
import { JsonlOpStore, wrapStreamFn, wrapTools } from "@z-agent/harness";
import { InteractiveTui, type TuiCompletionCandidate } from "@z-agent/tui";
import { SigintAbort } from "./abort.ts";
import { looksLikeReasoningModel, parseArgs, printHelp } from "./args.ts";
import { applyCompactionToSession, needsCompaction } from "./compaction.ts";
import {
	ensureStarterConfig,
	loadCatalog,
	modelRefFromArgs,
	NO_MODEL_WARNING,
	persistAliasSettings,
	resolveModel,
} from "./config.ts";
import { createConfirmGate } from "./confirm.ts";
import { composeBefore, discoverExtensionPaths, type Extension, loadExtension } from "./extensions.ts";
import { runInteractive, submitTuiInputDuringRun } from "./interactive.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import {
	formatCompactContext,
	formatListModelsLine,
	formatRuntimeStatus,
	modelSettingsView,
	reduceModelSettings,
} from "./model-settings.ts";
import { prepareProjectPillow, prepareUserPillow } from "./pillow-home.ts";
import { runPrint } from "./print.ts";
import {
	appendMessage,
	createSession,
	latestSessionId,
	listSessionIds,
	loadSession,
	messagesOnLeaf,
	resetSessionBranch,
	type SessionRecord,
	saveSession,
} from "./sessions.ts";
import { type SkillCommandLevel, SkillInputCoordinator } from "./skill-commands.ts";
import { createSkillManager, extractSkillPathHints, isPersistableAgentMessage } from "./skill-manager.ts";
import { buildCodingSystemPrompt } from "./system-prompt.ts";
import { askYesNo, ensureProjectTrust } from "./trust.ts";

async function readStdinText(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}

function syncSession(session: SessionRecord, messages: AgentMessage[]): void {
	const persistable = messages.filter(isPersistableAgentMessage);
	const have = messagesOnLeaf(session).length;
	for (const message of persistable.slice(have)) {
		appendMessage(session, message);
	}
}

function completionCandidates(skillManager: Awaited<ReturnType<typeof createSkillManager>>): TuiCompletionCandidate[] {
	return [
		...INTERACTIVE_COMMANDS.map((command) => ({
			token: command.name,
			description: command.description,
			kind: "command" as const,
		})),
		...skillManager.getIndex().skills.map((skill) => ({
			token: `/${skill.metadata.name}`,
			description: skill.metadata.description,
			kind: "skill" as const,
		})),
	];
}

function queuedMessageText(message: AgentMessage): string | undefined {
	if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") {
		return undefined;
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return undefined;
	}
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
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
		return;
	}
	if (args.listSessions) {
		for (const id of await listSessionIds(cwd, args.sessionDir)) {
			console.log(id);
		}
		return;
	}
	const resolved = resolveModel(modelRefFromArgs(args.model), loaded.catalog, process.env, {
		contextWindow: args.contextWindow,
		maxTokens: args.maxTokens,
	});
	if (!resolved.hasModel) {
		console.error(resolved.warning);
	}

	const apiKey = resolved.hasModel ? resolved.apiKey : undefined;

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

	const skillManager = await createSkillManager({
		cwd,
		userPillow,
		session,
		contextWindow: resolved.hasModel ? resolved.contextWindow : undefined,
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
	});
	let settings = modelSettingsView({
		hasModel: resolved.hasModel,
		alias: resolved.hasModel ? resolved.alias : undefined,
		id: resolved.hasModel ? resolved.id : undefined,
		thinking: resolved.hasModel ? resolved.thinking : "off",
		contextWindow: resolved.hasModel ? resolved.contextWindow : undefined,
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
	});
	const projectPillow = join(cwd, ".pillow");
	const extensionPaths = [...(await discoverExtensionPaths(cwd)), ...args.extensionPaths];
	const trusted =
		extensionPaths.length === 0
			? true
			: await ensureProjectTrust(cwd, async () => {
					if (autoYes) {
						return true;
					}
					return await askYesNo(`Trust project resources in ${cwd}?`);
				});

	const extensions: Extension[] = [];
	if (trusted) {
		for (const extPath of extensionPaths) {
			extensions.push(await loadExtension(extPath, cwd));
		}
	}

	let streamFn: StreamFn = createOpenAIResponsesStream({
		apiKey,
		baseUrl: resolved.hasModel ? resolved.baseUrl : process.env.OPENAI_BASE_URL,
	});
	let tools = [...createAllTools(cwd, { jailRoot: jail ? cwd : false }), skillManager.createReadTool()];
	if (args.durable) {
		const store = new JsonlOpStore(join(projectPillow, "harness"));
		streamFn = wrapStreamFn(streamFn, store);
		tools = wrapTools(tools, store);
	}

	let agent!: Agent;
	let input!: SkillInputCoordinator;
	const abort = new SigintAbort(() => agent);
	const tui = !usePrint
		? new InteractiveTui({
				status: () =>
					formatRuntimeStatus({
						view: settings,
						skillsMode: skillManager.getState().mode,
						skillsActive: skillManager.getState().active.length,
						cwd,
					}).replace(/^\[status\] /, ""),
				header: () => ({
					cwd,
					model: settings.hasModel ? (settings.alias ? `${settings.alias}(${settings.id})` : settings.id) : "none",
					context: formatCompactContext(settings.contextWindow),
					session: session.header.id.slice(0, 12),
				}),
				onSubmitDuringRun: (line) => {
					submitTuiInputDuringRun(input, line);
				},
				completionCandidates: () => completionCandidates(skillManager),
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
				await skillManager.setSession(session);
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
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
		prepareQueuedMessages: async (messages) => {
			for (const message of messages) {
				const text = queuedMessageText(message);
				if (text !== undefined && text.trim().length > 0) {
					await skillManager.prepareSnapshot({ text, pathHints: extractSkillPathHints(text) });
				}
			}
			return messages;
		},
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
		prepareContext: (context) => skillManager.prepareContext(context),
		initialState: {
			model,
			thinkingLevel: resolved.hasModel ? resolved.thinking : "off",
			systemPrompt: buildCodingSystemPrompt(cwd, jail),
			tools,
			messages: messagesOnLeaf(session),
		},
	});
	const writeSkillStatus = (level: SkillCommandLevel, text: string): void => {
		if (tui) {
			if (level === "info") {
				tui.appendLine(text);
			} else {
				tui.appendNotice(level, text);
			}
			return;
		}
		if (level === "info") {
			console.log(text);
		} else {
			console.error(text);
		}
	};
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
	input = new SkillInputCoordinator({
		agent,
		manager: skillManager,
		write: writeSkillStatus,
		onReload: () => tui?.refreshCompletions(),
	});

	abort.attach();

	const compactNow = async () => {
		const transcript = agent.state.messages.filter(isPersistableAgentMessage);
		const { kept, summary } = await applyCompactionToSession(session, transcript, {
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
		const transcript = agent.state.messages.filter(isPersistableAgentMessage);
		syncSession(session, transcript);
		if (needsCompaction(transcript, { contextWindow: agent.state.model.contextWindow })) {
			await compactNow();
			syncSession(session, agent.state.messages.filter(isPersistableAgentMessage));
		}
		await saveSession(session, sessionRoot);
	};

	if (usePrint) {
		if (!prompt) {
			console.error("error: prompt required");
			process.exit(2);
		}
		console.error(
			`[mode] print model=${settings.hasModel ? (settings.alias ? `${settings.alias}(${settings.id})` : settings.id) : "none"} contextWindow=${settings.contextWindow ?? "unknown"} maxTokens=${settings.maxTokens ?? "unknown"} thinking=${settings.thinking} cwd=${cwd}`,
		);
		const printInput = await input.submit(prompt);
		if (printInput.kind === "request") {
			if (!resolved.hasModel) {
				console.error(NO_MODEL_WARNING);
				await persist();
				abort.detach();
				process.exit(1);
			}
			if (!apiKey) {
				console.error("error: OPENAI_API_KEY is required (or set apiKey in ~/.pillow/config.json)");
				await persist();
				abort.detach();
				process.exit(1);
			}
			await runPrint(agent, printInput.message, args.verbose);
		} else if (printInput.kind === "builtin") {
			console.error(`error: ${printInput.name} is only available in interactive mode`);
			await persist();
			abort.detach();
			process.exit(2);
		} else if (printInput.error) {
			await persist();
			abort.detach();
			process.exit(2);
		}
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
		hasModel: resolved.hasModel && Boolean(apiKey),
		input,
		onNew: async () => {
			await persist();
			session = createSession(cwd);
			await skillManager.setSession(session);
			agent.reset();
		},
		onReset: async () => {
			resetSessionBranch(session);
			await skillManager.setSession(session);
			await skillManager.reset();
			agent.reset();
		},
		onCompact: async () => {
			await compactNow();
			syncSession(session, agent.state.messages.filter(isPersistableAgentMessage));
			await saveSession(session, sessionRoot);
		},
		listSessions: async () => await listSessionIds(cwd, sessionRoot),
		onLoadSession: async (id) => {
			await persist();
			session = await loadSession(cwd, id, sessionRoot);
			await skillManager.setSession(session);
			const messages = messagesOnLeaf(session);
			return messages;
		},
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
	});
	await persist();
	abort.detach();
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
