import type { OpKind, OpState, OpStore } from "./store.ts";

/**
 * intent commit → effect → settle commit.
 * If op.state is already `done`, return the stored result and skip the effect.
 */
export async function withSandwich<TIntent, TResult>(
	store: OpStore,
	opId: string,
	kind: OpKind,
	intent: TIntent,
	effect: () => Promise<TResult>,
): Promise<TResult> {
	const existing = await store.load<TIntent, TResult>(opId);
	if (existing?.phase === "done" && existing.result !== undefined) {
		return existing.result;
	}

	const intentState: OpState<TIntent, TResult> = {
		opId,
		kind,
		phase: "intent",
		intent,
		updatedAt: Date.now(),
	};
	await store.commit(intentState);

	const effectState: OpState<TIntent, TResult> = { ...intentState, phase: "effect" };
	await store.commit(effectState);
	const result = await effect();

	const settleState: OpState<TIntent, TResult> = {
		...effectState,
		phase: "done",
		result,
	};
	await store.commit(settleState);
	return result;
}
