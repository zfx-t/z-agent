/**
 * JSONL op.state store. Each opId is one file overwritten with the latest state.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OpKind = "stream" | "tool";

/**
 * Op lifecycle (ADR-0030):
 * - `intent` — op identified and inputs recorded; effect not started.
 * - `effect` — effect in flight (provider request open / tool body running).
 * - `settle` — effect finished and its result is durably stored; not yet
 *   returned to the caller.
 * - `done` — `withSandwich` returned the result to the caller.
 *
 * Replay rule: `settle`/`done` with a result replays without re-running the
 * effect; `intent` re-runs; `effect` follows the resume policy.
 */
export type OpPhase = "intent" | "effect" | "settle" | "done";

export interface OpState<TIntent = unknown, TResult = unknown> {
	opId: string;
	kind: OpKind;
	phase: OpPhase;
	intent?: TIntent;
	/** sha256 of the canonical intent; guards against id reuse with different inputs. */
	intentHash?: string;
	result?: TResult;
	/** 1-based attempt counter; increments when intent is committed again. */
	attempt: number;
	createdAt: number;
	updatedAt: number;
}

export interface OpStore {
	load<TIntent, TResult>(opId: string): Promise<OpState<TIntent, TResult> | undefined>;
	commit<TIntent, TResult>(state: OpState<TIntent, TResult>): Promise<void>;
	delete(opId: string): Promise<void>;
}

export class JsonlOpStore implements OpStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private pathFor(opId: string): string {
		const safe = opId.replace(/[^a-zA-Z0-9._:-]+/g, "_");
		return join(this.dir, "op.state", `${safe}.json`);
	}

	async load<TIntent, TResult>(opId: string): Promise<OpState<TIntent, TResult> | undefined> {
		try {
			const row = JSON.parse(await readFile(this.pathFor(opId), "utf-8")) as OpState<TIntent, TResult>;
			return { ...row, attempt: row.attempt ?? 1, createdAt: row.createdAt ?? row.updatedAt };
		} catch {
			return undefined;
		}
	}

	async commit<TIntent, TResult>(state: OpState<TIntent, TResult>): Promise<void> {
		const path = this.pathFor(state.opId);
		await mkdir(join(this.dir, "op.state"), { recursive: true });
		await writeFile(path, `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`, "utf-8");
	}

	async delete(opId: string): Promise<void> {
		await rm(this.pathFor(opId), { force: true });
	}
}
