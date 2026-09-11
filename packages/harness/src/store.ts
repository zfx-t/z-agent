/**
 * JSONL op.state store. Each opId is one file overwritten with the latest state.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OpKind = "stream" | "tool";
export type OpPhase = "intent" | "effect" | "settle" | "done";

export interface OpState<TIntent = unknown, TResult = unknown> {
	opId: string;
	kind: OpKind;
	phase: OpPhase;
	intent?: TIntent;
	result?: TResult;
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
			return JSON.parse(await readFile(this.pathFor(opId), "utf-8")) as OpState<TIntent, TResult>;
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
