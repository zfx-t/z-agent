/**
 * SQLite op.state store backed by node:sqlite (ADR-0026).
 * Single op_state table, one row per opId, upserted each step.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpKind, OpPhase, OpState, OpStore } from "./store.ts";

interface OpStateRow {
	op_id: string;
	kind: string;
	phase: string;
	intent: string | null;
	result: string | null;
	updated_at: number;
}

export class SqliteOpStore implements OpStore {
	private readonly db: DatabaseSync;

	constructor(dir: string) {
		mkdirSync(dir, { recursive: true });
		this.db = new DatabaseSync(join(dir, "op.state.db"));
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS op_state (
				op_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				phase TEXT NOT NULL,
				intent TEXT,
				result TEXT,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	async load<TIntent, TResult>(opId: string): Promise<OpState<TIntent, TResult> | undefined> {
		const row = this.db
			.prepare("SELECT op_id, kind, phase, intent, result, updated_at FROM op_state WHERE op_id = ?")
			.get(opId) as OpStateRow | undefined;
		if (!row) {
			return undefined;
		}
		return {
			opId: row.op_id,
			kind: row.kind as OpKind,
			phase: row.phase as OpPhase,
			intent: row.intent === null ? undefined : (JSON.parse(row.intent) as TIntent),
			result: row.result === null ? undefined : (JSON.parse(row.result) as TResult),
			updatedAt: row.updated_at,
		};
	}

	async commit<TIntent, TResult>(state: OpState<TIntent, TResult>): Promise<void> {
		this.db
			.prepare(
				`INSERT INTO op_state (op_id, kind, phase, intent, result, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(op_id) DO UPDATE SET
					kind = excluded.kind,
					phase = excluded.phase,
					intent = excluded.intent,
					result = excluded.result,
					updated_at = excluded.updated_at`,
			)
			.run(
				state.opId,
				state.kind,
				state.phase,
				state.intent === undefined ? null : JSON.stringify(state.intent),
				state.result === undefined ? null : JSON.stringify(state.result),
				Date.now(),
			);
	}

	async delete(opId: string): Promise<void> {
		this.db.prepare("DELETE FROM op_state WHERE op_id = ?").run(opId);
	}

	close(): void {
		this.db.close();
	}
}
