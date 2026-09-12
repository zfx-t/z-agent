import { intentHash } from "./op-id.ts";
import type { OpKind, OpState, OpStore } from "./store.ts";

/**
 * intent commit → effect → settle commit → done commit.
 * If op.state is `settle` or `done` with a stored result, return it and skip
 * the effect. An op interrupted in `effect` follows the resume policy.
 */

export interface ResumePolicy {
	/** What to do with a tool op found in `effect` phase on resume. */
	interruptedTool: "fail" | "rerun";
	/** What to do with a stream op found in `effect` phase on resume. */
	interruptedStream: "rerun" | "fail";
}

export const DEFAULT_RESUME_POLICY: ResumePolicy = {
	interruptedTool: "fail",
	interruptedStream: "rerun",
};

/** Thrown by onInterrupted handlers; encodes "previous attempt left this op in effect phase". */
export class OpInterruptedError extends Error {
	readonly opId: string;

	constructor(opId: string, kind: OpKind) {
		super(`Op ${opId} (${kind}) was interrupted before completion and was not re-run (durable resume policy)`);
		this.name = "OpInterruptedError";
		this.opId = opId;
	}
}

export class OpIntentMismatchError extends Error {
	readonly opId: string;
	readonly expected: string;
	readonly actual: string;

	constructor(opId: string, expected: string, actual: string) {
		super(`Op ${opId} was recorded with different inputs (intent hash mismatch)`);
		this.name = "OpIntentMismatchError";
		this.opId = opId;
		this.expected = expected;
		this.actual = actual;
	}
}

export interface SandwichInput<TIntent, TResult> {
	store: OpStore;
	opId: string;
	kind: OpKind;
	intent: TIntent;
	effect: () => Promise<TResult>;
	/**
	 * Invoked when a previous attempt was interrupted in `effect` phase and
	 * `policy` is `"fail"`. May return a result (committed as settle/done) or
	 * throw — e.g. `OpInterruptedError` — to propagate the interruption.
	 */
	onInterrupted: () => TResult;
	policy: "fail" | "rerun";
}

export async function withSandwich<TIntent, TResult>(input: SandwichInput<TIntent, TResult>): Promise<TResult> {
	const { store, opId, kind, intent, effect, onInterrupted, policy } = input;
	const hash = intentHash(intent);
	const existing = await store.load<TIntent, TResult>(opId);

	if (existing?.intentHash !== undefined && existing.intentHash !== hash) {
		throw new OpIntentMismatchError(opId, existing.intentHash, hash);
	}

	if (existing && (existing.phase === "settle" || existing.phase === "done") && existing.result !== undefined) {
		return existing.result;
	}

	if (existing?.phase === "effect" && policy === "fail") {
		const result = onInterrupted();
		const interrupted: OpState<TIntent, TResult> = { ...existing, intentHash: hash };
		await store.commit({ ...interrupted, phase: "settle", result });
		await store.commit({ ...interrupted, phase: "done", result });
		return result;
	}

	const now = Date.now();
	const intentState: OpState<TIntent, TResult> = {
		opId,
		kind,
		phase: "intent",
		intent,
		intentHash: hash,
		attempt: existing === undefined ? 1 : existing.attempt + 1,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	await store.commit(intentState);

	const effectState: OpState<TIntent, TResult> = { ...intentState, phase: "effect" };
	await store.commit(effectState);
	const result = await effect();

	const settleState: OpState<TIntent, TResult> = { ...effectState, phase: "settle", result };
	await store.commit(settleState);
	await store.commit({ ...settleState, phase: "done" });
	return result;
}
