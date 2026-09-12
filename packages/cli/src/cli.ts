/**
 * z-agent product CLI: TUI + print, coding tools, sessions, skills, optional L5.
 */

import { join } from "node:path";
import { stdin } from "node:process";
import { Agent, type AgentMessage, createAllTools, DEFAULT_BASH_TIMEOUT } from "@z-agent/agent";
import { createProviderStream, emptyUsage, type Model, providerForApi, type StreamFn } from "@z-agent/ai";
import { JsonlOpStore, type OpStore, SqliteOpStore, wrapStreamFn, wrapTools } from "@z-agent/harness";
import { InteractiveTui, type TuiCompletionCandidate, type TuiHeaderSegment } from "@z-agent/tui";
import { SigintAbort } from "./abort.ts";
import { looksLikeReasoningModel, parseArgs, printHelp } from "./args.ts";
import { createRegistry } from "./command-registry.ts";
import { applyCompactionToSession, needsCompaction } from "./compaction.ts";
import {
	ensureStarterConfig,
	loadCatalog,
	modelRefFromArgs,
	NO_MODEL_WARNING,
	persistAliasSettings,
	resolveModel,
	resolveThinking,
} from "./config.ts";
import { createConfirmGate } from "./confirm.ts";
import { createExtensionHost } from "./extension-host.ts";
import { composeBefore, discoverExtensionPaths } from "./extensions.ts";
import { runInteractive, submitTuiInputDuringRun } from "./interactive.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import { loadKeymap } from "./keys-config.ts";
import {
	formatListModelsLine,
	formatModelPickerRow,
	formatModelSettings,
	formatRuntimeStatus,
	MODEL_THINKING_LEVELS,
	modelSettingsView,
	reduceModelSettings,
} from "./model-settings.ts";
import { prepareProjectPillow, prepareUserPillow } from "./pillow-home.ts";
import { runPrint } from "./print.ts";
import {
	appendMessage,
	branch,
	createSession,
	formatSessionHealth,
	inspectSession,
	inspectSessionCheckpoints,
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
import {
	accumulateAssistantUsage,
	composeStatusLine,
	formatUsageOccupancy,
	safeSegmentText,
} from "./status-segments.ts";
import { buildCodingSystemPrompt } from "./system-prompt.ts";
import { replayTranscript } from "./transcript.ts";
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

async function openHealthySession(cwd: string, id: string, root: string | undefined): Promise<SessionRecord> {
	const loaded = await loadSession(cwd, id, root);
	const health = inspectSession(loaded);
	if (health.ok) {
		return loaded;
	}
	console.error(`[sessions] ${formatSessionHealth(health)}`);
	return createSession(cwd);
}

function completionCandidates(
	skillManager: Awaited<ReturnType<typeof createSkillManager>>,
	commands: typeof INTERACTIVE_COMMANDS,
): TuiCompletionCandidate[] {
	return [
		...commands.map((command) => ({
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
		api: args.api,
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
		session = await openHealthySession(cwd, args.session, sessionRoot);
	} else if (args.resume || args.continueSession) {
		const id = await latestSessionId(cwd, sessionRoot);
		session = id ? await openHealthySession(cwd, id, sessionRoot) : createSession(cwd);
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
		api: resolved.hasModel ? resolved.api : undefined,
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

	const keymap = await loadKeymap(userPillow);
	const registry = createRegistry(INTERACTIVE_COMMANDS);
	let writeWarning: ((message: string) => void) | undefined;
	const host = createExtensionHost({
		cwd,
		registry,
		onWarning: (message) => writeWarning?.(message),
	});
	if (trusted) {
		for (const extPath of extensionPaths) {
			await host.load(extPath);
		}
	}

	const bashDefaultSeconds = args.bashTimeout ?? DEFAULT_BASH_TIMEOUT.defaultSeconds;
	let streamFn: StreamFn = createProviderStream();
	let tools = [
		...createAllTools(cwd, {
			jailRoot: jail ? cwd : false,
			bash: {
				timeout: { defaultSeconds: bashDefaultSeconds },
				env: args.bashEnv === "inherit" ? { mode: "inherit" } : undefined,
			},
		}),
		...host.tools,
		skillManager.createReadTool(),
	];
	if (args.durable) {
		const store: OpStore =
			args.durableBackend === "sqlite"
				? new SqliteOpStore(join(projectPillow, "harness"))
				: new JsonlOpStore(join(projectPillow, "harness"));
		streamFn = wrapStreamFn(streamFn, store);
		tools = wrapTools(tools, store);
	}

	let agent!: Agent;
	let input!: SkillInputCoordinator;
	/** Usage of the latest assistant message: its input+output is the current context size. */
	let contextUsage = emptyUsage();
	/** Cumulative usage across the process for the status line. */
	let totalUsage = emptyUsage();
	const abort = new SigintAbort(() => agent);
	const headerSegments = (): TuiHeaderSegment[] => {
		const model = settings.hasModel ? (settings.alias ? `${settings.alias}(${settings.id})` : settings.id) : "none";
		return [
			{ id: "cwd", text: `cwd: ${cwd}`, priority: 40 },
			{ id: "model", text: `model: ${model}`, priority: 80 },
			{ id: "ctx", text: `ctx: ${formatUsageOccupancy(contextUsage, settings.contextWindow)}`, priority: 90 },
			{ id: "session", text: `session: ${session.header.id.slice(0, 12)}`, priority: 30 },
			...host.segments.flatMap((segment) => {
				const text = safeSegmentText(segment);
				return text ? [{ id: segment.id, text, priority: segment.priority, required: segment.required }] : [];
			}),
		];
	};
	const tui = !usePrint
		? new InteractiveTui({
				status: () =>
					composeStatusLine(
						[
							{
								id: "model",
								order: 10,
								priority: 80,
								render: () =>
									settings.hasModel
										? settings.alias
											? `${settings.alias}(${settings.id})`
											: settings.id
										: "none",
							},
							{
								id: "thinking",
								order: 20,
								priority: 60,
								render: () => `think ${settings.thinking}`,
							},
							{
								id: "ctx",
								order: 30,
								priority: 90,
								render: () => formatUsageOccupancy(contextUsage, settings.contextWindow),
							},
							{
								id: "total",
								order: 35,
								priority: 45,
								render: () =>
									totalUsage.totalTokens > 0 ? `total ${formatUsageOccupancy(totalUsage)}` : undefined,
							},
							{
								id: "skills",
								order: 40,
								priority: 50,
								render: () => `skills ${skillManager.getState().mode}:${skillManager.getState().active.length}`,
							},
							{ id: "cwd", order: 50, priority: 40, render: () => cwd },
							...host.segments,
						],
						80,
					),
				header: () => ({
					cwd,
					model: settings.hasModel ? (settings.alias ? `${settings.alias}(${settings.id})` : settings.id) : "none",
					context: formatUsageOccupancy(contextUsage, settings.contextWindow),
					session: session.header.id.slice(0, 12),
					segments: headerSegments(),
				}),
				onSubmitDuringRun: (line) => {
					submitTuiInputDuringRun(input, line);
				},
				completionCandidates: () => completionCandidates(skillManager, registry.list()),
				keymap,
				toolRenderer: host.toolRenderer,
				onInterrupt: () => {
					abort.handleSigint();
				},
			})
		: undefined;

	// Fresh session by default; earlier sessions are reachable via /sessions.
	if (tui && !args.session && !args.resume && !args.continueSession) {
		const ids = await listSessionIds(cwd, sessionRoot);
		if (ids.length > 0) {
			tui.start();
			tui.appendLine(`[sessions] ${ids.length} saved; /sessions to resume`);
		}
	} else if (tui) {
		const restored = messagesOnLeaf(session);
		if (restored.length > 0) {
			tui.start();
			replayTranscript(tui, restored);
			tui.appendLine(`[sessions] resumed ${session.header.id.slice(0, 12)}`);
		}
	}

	const confirmGate = createConfirmGate({
		autoYes,
		alsoConfirm: host.extensionToolNames,
		ask: async (toolName, toolArgs) => {
			if (!tui) {
				return "once";
			}
			return await tui.confirmTool(toolName, toolArgs);
		},
	});

	const resolvedApi = resolved.hasModel ? resolved.api : "openai-responses";
	const model: Model = {
		id: modelId,
		name: modelId,
		api: resolvedApi,
		provider: providerForApi(resolvedApi),
		baseUrl: resolved.hasModel ? (resolved.baseUrl ?? "") : "",
		input: ["text", "image"],
		contextWindow: resolved.hasModel ? resolved.contextWindow : undefined,
		maxTokens: resolved.hasModel ? resolved.maxTokens : undefined,
	};
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
		beforeToolCall: composeBefore(confirmGate, host.hooks),
		afterToolCall: async (context, signal) => {
			for (const ext of host.hooks) {
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
	/** `/model` with no args: pick an alias, then its thinking level, apply both. */
	const pickModelSettings = async (): Promise<void> => {
		const catalog = loaded.catalog;
		const aliases = catalog ? Object.keys(catalog.models) : [];
		if (!tui || !catalog || aliases.length === 0) {
			writeSkillStatus("info", formatModelSettings(settings));
			return;
		}
		const aliasWidth = Math.max(...aliases.map((alias) => alias.length));
		const modelIndex = await tui.pickFromList(
			"Model",
			aliases.map((alias) => {
				const entry = catalog.models[alias];
				return formatModelPickerRow({
					alias,
					id: entry?.id ?? "unknown",
					api: entry?.api,
					contextWindow: entry?.contextWindow,
					maxTokens: entry?.maxTokens,
					thinking: entry ? resolveThinking(entry.id, entry.thinking) : undefined,
					isCurrent: alias === settings.alias,
					isDefault: alias === catalog.defaultModel,
					aliasWidth,
				});
			}),
			{ cancelValue: -1, initialIndex: Math.max(0, aliases.indexOf(settings.alias ?? "")) },
		);
		if (modelIndex < 0) {
			writeSkillStatus("info", formatModelSettings(settings));
			return;
		}
		const pickedAlias = aliases[modelIndex] ?? "";
		const next = resolveModel(pickedAlias, catalog);
		if (!next.hasModel) {
			writeSkillStatus("error", next.warning);
			return;
		}
		const thinkingIndex = await tui.pickFromList(
			`Thinking (${pickedAlias})`,
			MODEL_THINKING_LEVELS.map((level) => (level === next.thinking ? `${level} (current)` : level)),
			{ cancelValue: -1, initialIndex: Math.max(0, MODEL_THINKING_LEVELS.indexOf(next.thinking)) },
		);
		if (thinkingIndex < 0) {
			writeSkillStatus("info", formatModelSettings(settings));
			return;
		}
		const thinking = MODEL_THINKING_LEVELS[thinkingIndex] ?? next.thinking;
		settings = modelSettingsView({
			hasModel: true,
			alias: pickedAlias,
			id: next.id,
			api: next.api,
			thinking,
			contextWindow: next.contextWindow,
			maxTokens: next.maxTokens,
		});
		agent.state.model = {
			id: next.id,
			name: next.id,
			api: next.api,
			provider: providerForApi(next.api),
			baseUrl: next.baseUrl ?? "",
			input: ["text", "image"],
			contextWindow: next.contextWindow,
			maxTokens: next.maxTokens,
		};
		agent.apiKey = next.apiKey;
		agent.state.thinkingLevel = thinking;
		agent.maxTokens = next.maxTokens;
		skillManager.setBudget({ contextWindow: next.contextWindow ?? 0, maxTokens: next.maxTokens });
		interactiveOptions.hasModel = Boolean(agent.apiKey);
		if (!agent.apiKey) {
			const keyEnv = next.api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
			writeSkillStatus("warning", `[model] ${pickedAlias} has no api key (set ${keyEnv} or config.json apiKey)`);
		}
		let text = formatModelSettings(settings);
		if (thinking !== next.thinking) {
			try {
				await persistAliasSettings(userPillow, pickedAlias, { thinking });
			} catch (error) {
				text = `${text} persist=failed (${error instanceof Error ? error.message : String(error)})`;
			}
		}
		writeSkillStatus("info", text);
	};
	input = new SkillInputCoordinator({
		agent,
		manager: skillManager,
		commands: registry.list(),
		write: writeSkillStatus,
		onReload: () => tui?.refreshCompletions(),
	});
	host.bindAgent(agent);
	agent.subscribe((event) => {
		if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
			contextUsage = event.message.usage;
			totalUsage = accumulateAssistantUsage(totalUsage, event.message.usage);
		}
	});
	const resetContextUsage = (): void => {
		contextUsage = emptyUsage();
	};
	writeWarning = (message) => writeSkillStatus("warning", `[ext] ${message}`);
	for (const warning of [...keymap.warnings, ...host.warnings]) {
		writeWarning(warning);
	}

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
		resetContextUsage();
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
				const keyEnv = resolved.api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
				console.error(`error: ${keyEnv} is required (or set apiKey in ~/.pillow/config.json)`);
				await persist();
				abort.detach();
				process.exit(1);
			}
			await runPrint(agent, printInput.message, args.verbose);
		} else if (printInput.kind !== "handled") {
			const name = printInput.kind === "builtin" ? printInput.name : `/${printInput.kind}`;
			console.error(`error: ${name} is only available in interactive mode`);
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
	const interactiveOptions: Parameters<typeof runInteractive>[0] = {
		agent,
		tui,
		hasModel: resolved.hasModel && Boolean(apiKey),
		input,
		registry,
		onNew: async () => {
			await persist();
			session = createSession(cwd);
			await skillManager.setSession(session);
			agent.reset();
			resetContextUsage();
		},
		onReset: async () => {
			resetSessionBranch(session);
			await skillManager.setSession(session);
			await skillManager.reset();
			agent.reset();
			resetContextUsage();
		},
		onCompact: async () => {
			await compactNow();
			syncSession(session, agent.state.messages.filter(isPersistableAgentMessage));
			await saveSession(session, sessionRoot);
		},
		listSessions: async () => await listSessionIds(cwd, sessionRoot),
		onInspectSession: async (id) => {
			const loaded = await loadSession(cwd, id, sessionRoot);
			return inspectSessionCheckpoints(loaded);
		},
		onRestoreCheckpoint: async (id, nodeId) => {
			await persist();
			const loaded = await loadSession(cwd, id, sessionRoot);
			const health = inspectSession(loaded);
			if (!health.ok) {
				throw new Error(formatSessionHealth(health));
			}
			session = nodeId ? branch(loaded, nodeId) : loaded;
			await skillManager.setSession(session);
			await saveSession(session, sessionRoot);
			resetContextUsage();
			return messagesOnLeaf(session);
		},
		formatStatus: () =>
			formatRuntimeStatus({
				view: settings,
				skillsMode: skillManager.getState().mode,
				skillsActive: skillManager.getState().active.length,
				cwd,
				bash: `timeout ${bashDefaultSeconds}s/${DEFAULT_BASH_TIMEOUT.maxSeconds}s, env ${args.bashEnv}`,
			}),
		onModel: async (modelArgs) => {
			if (modelArgs.trim().length === 0) {
				await pickModelSettings();
				return;
			}
			await applySettings(modelArgs);
		},
	};
	await runInteractive(interactiveOptions);
	await persist();
	abort.detach();
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
