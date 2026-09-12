/**
 * SQLite op.state store backed by node:sqlite (ADR-0026, amended by ADR-0030).
 * Single op_state table, one row per opId, upserted each step.
 * Missing ADR-0030 columns are added with ALTER TABLE on open.
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
	intent_hash: string | null;
	result: string | null;
	attempt: number | null;
	created_at: number | null;
	updated_at: number;
}

const NEW_COLUMNS: [string, string][] = [
	["intent_hash", "TEXT"],
	["attempt", "INTEGER NOT NULL DEFAULT 1"],
	["created_at", "INTEGER"],
];

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
		const existing = new Set(
			(this.db.prepare("PRAGMA table_info(op_state)").all() as { name: string }[]).map((c) => c.name),
		);
		for (const [name, ddl] of NEW_COLUMNS) {
			if (!existing.has(name)) {
				this.db.exec(`ALTER TABLE op_state ADD COLUMN ${name} ${ddl}`);
			}
		}
	}

	async load<TIntent, TResult>(opId: string): Promise<OpState<TIntent, TResult> | undefined> {
		const row = this.db
			.prepare(
				"SELECT op_id, kind, phase, intent, intent_hash, result, attempt, created_at, updated_at FROM op_state WHERE op_id = ?",
			)
			.get(opId) as OpStateRow | undefined;
		if (!row) {
			return undefined;
		}
		return {
			opId: row.op_id,
			kind: row.kind as OpKind,
			phase: row.phase as OpPhase,
			intent: row.intent === null ? undefined : (JSON.parse(row.intent) as TIntent),
			intentHash: row.intent_hash === null ? undefined : row.intent_hash,
			result: row.result === null ? undefined : (JSON.parse(row.result) as TResult),
			attempt: row.attempt ?? 1,
			createdAt: row.created_at ?? row.updated_at,
			updatedAt: row.updated_at,
		};
	}

	async commit<TIntent, TResult>(state: OpState<TIntent, TResult>): Promise<void> {
		this.db
			.prepare(
				`INSERT INTO op_state (op_id, kind, phase, intent, intent_hash, result, attempt, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(op_id) DO UPDATE SET
					kind = excluded.kind,
					phase = excluded.phase,
					intent = excluded.intent,
					intent_hash = excluded.intent_hash,
					result = excluded.result,
					attempt = excluded.attempt,
					created_at = excluded.created_at,
					updated_at = excluded.updated_at`,
			)
			.run(
				state.opId,
				state.kind,
				state.phase,
				state.intent === undefined ? null : JSON.stringify(state.intent),
				state.intentHash === undefined ? null : state.intentHash,
				state.result === undefined ? null : JSON.stringify(state.result),
				state.attempt,
				state.createdAt,
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
