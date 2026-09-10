import { basename } from "node:path";
import type { Agent, AgentEvent, AgentEventType, AgentTool } from "@z-agent/agent";
import type { TuiToolDetail, TuiToolRenderer, TuiToolSnapshot } from "@z-agent/tui";
import type { CommandRegistry } from "./command-registry.ts";
import type { InteractiveCommand } from "./command-types.ts";
import type { ExtensionApi, ExtensionEventHandler } from "./extension-api.ts";
import { type Extension, loadExtensionInto } from "./extensions.ts";
import type { StatusSegment } from "./status-segments.ts";

export type { ExtensionApi, ExtensionEventHandler } from "./extension-api.ts";

export interface ExtensionHost {
	readonly warnings: string[];
	readonly tools: AgentTool[];
	readonly extensionToolNames: ReadonlySet<string>;
	readonly segments: StatusSegment[];
	readonly hooks: Extension[];
	toolRenderer: TuiToolRenderer;
	load(modulePath: string): Promise<void>;
	bindAgent(agent: Agent): () => void;
}

export function createExtensionHost(options: {
	cwd: string;
	registry: CommandRegistry;
	onWarning?: (message: string) => void;
}): ExtensionHost {
	const warnings: string[] = [];
	const tools: AgentTool[] = [];
	const extensionToolNames = new Set<string>();
	const segments: StatusSegment[] = [];
	const hooks: Extension[] = [];
	const renderers = new Map<string, TuiToolRenderer>();
	const listeners: Array<{ type: AgentEventType | "*"; handler: ExtensionEventHandler }> = [];
	let currentName = "extension";

	const warn = (message: string): void => {
		warnings.push(message);
		options.onWarning?.(message);
	};

	const api: ExtensionApi = {
		registerCommand(command) {
			if (!command.name.startsWith("/")) {
				warn(`${currentName}: command ${command.name} must start with /`);
				return;
			}
			if (typeof command.run !== "function") {
				warn(`${currentName}: command ${command.name} is missing run()`);
				return;
			}
			const registered: InteractiveCommand = {
				...command,
				source: { extension: currentName },
			};
			const result = options.registry.register(registered);
			if (!result.ok) {
				warn(`${currentName}: command ${command.name} rejected (${result.reason} ${result.detail})`);
			}
		},
		registerTool(tool) {
			if (!tool.name || typeof tool.execute !== "function") {
				warn(`${currentName}: invalid tool`);
				return;
			}
			if (tools.some((existing) => existing.name === tool.name)) {
				warn(`${currentName}: tool ${tool.name} already registered`);
				return;
			}
			tools.push(tool);
			extensionToolNames.add(tool.name);
		},
		registerStatusSegment(segment) {
			if (!segment.id || typeof segment.render !== "function") {
				warn(`${currentName}: invalid status segment`);
				return;
			}
			if (segments.some((existing) => existing.id === segment.id)) {
				warn(`${currentName}: status segment ${segment.id} already registered`);
				return;
			}
			segments.push(segment);
		},
		registerToolRenderer(toolName, render) {
			if (!toolName || typeof render !== "function") {
				warn(`${currentName}: invalid tool renderer`);
				return;
			}
			if (renderers.has(toolName)) {
				warn(`${currentName}: renderer for ${toolName} already registered`);
				return;
			}
			renderers.set(toolName, render);
		},
		on(type, handler) {
			if (typeof handler !== "function") {
				warn(`${currentName}: invalid event handler`);
				return;
			}
			listeners.push({ type, handler });
		},
	};

	/**
	 * Runs inside a TUI repaint. A failing renderer is removed first and the
	 * warning is deferred so the notice cannot re-enter the same paint.
	 */
	const toolRenderer: TuiToolRenderer = (tool: TuiToolSnapshot): TuiToolDetail | undefined => {
		const render = renderers.get(tool.toolName);
		if (!render) {
			return undefined;
		}
		try {
			return render(tool);
		} catch (error) {
			renderers.delete(tool.toolName);
			const message = `renderer ${tool.toolName} disabled: ${error instanceof Error ? error.message : String(error)}`;
			warnings.push(message);
			queueMicrotask(() => options.onWarning?.(message));
			return undefined;
		}
	};

	return {
		warnings,
		tools,
		extensionToolNames,
		segments,
		hooks,
		toolRenderer,
		async load(modulePath: string) {
			currentName = basename(modulePath);
			try {
				const extension = await loadExtensionInto(modulePath, options.cwd, api);
				hooks.push(wrapHooks(currentName, extension, warn));
			} catch (error) {
				warn(`${currentName}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				currentName = "extension";
			}
		},
		bindAgent(agent: Agent) {
			return agent.subscribe(async (event: AgentEvent) => {
				for (const listener of listeners) {
					if (listener.type !== "*" && listener.type !== event.type) {
						continue;
					}
					try {
						await listener.handler(event);
					} catch (error) {
						warn(`on(${listener.type}): ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			});
		},
	};
}

function wrapHooks(name: string, extension: Extension, warn: (message: string) => void): Extension {
	return {
		beforeToolCall: extension.beforeToolCall
			? async (context, signal) => {
					try {
						return await extension.beforeToolCall?.(context, signal);
					} catch (error) {
						warn(`${name} beforeToolCall: ${error instanceof Error ? error.message : String(error)}`);
						return undefined;
					}
				}
			: undefined,
		afterToolCall: extension.afterToolCall
			? async (context, signal) => {
					try {
						return await extension.afterToolCall?.(context, signal);
					} catch (error) {
						warn(`${name} afterToolCall: ${error instanceof Error ? error.message : String(error)}`);
						return undefined;
					}
				}
			: undefined,
	};
}
