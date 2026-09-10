import type { BeforeToolCallContext, BeforeToolCallResult } from "@z-agent/agent";
import type { ConfirmChoice } from "@z-agent/tui";

export const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

export interface ConfirmGateOptions {
	/** Skip prompts (print mode / --yes). */
	autoYes: boolean;
	ask: (toolName: string, args: unknown) => Promise<ConfirmChoice>;
	/** Extra tool names that always require confirmation (extension tools). */
	alsoConfirm?: ReadonlySet<string>;
}

/**
 * Built-in confirm: read/grep/ls/find auto-allow; bash/write/edit ask unless autoYes.
 * Confirm UI runs before any extension hook the caller composes after this gate.
 */
export function createConfirmGate(
	options: ConfirmGateOptions,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
	const always = new Set<string>();
	return async (context) => {
		const name = context.toolCall.name;
		const gated = MUTATING_TOOLS.has(name) || Boolean(options.alsoConfirm?.has(name));
		if (!gated || options.autoYes || always.has(name)) {
			return undefined;
		}
		const choice = await options.ask(name, context.args);
		if (choice === "always") {
			always.add(name);
			return undefined;
		}
		if (choice === "deny") {
			return { block: true, reason: `User denied ${name}` };
		}
		return undefined;
	};
}
