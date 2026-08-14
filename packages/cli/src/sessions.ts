/**
 * JSONL session tree (product persistence, not L5 op.state).
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@z-agent/agent";

export type SessionEntryType = "message" | "compaction" | "label";

export interface SessionNode {
	id: string;
	parentId: string | null;
	type: SessionEntryType;
	createdAt: number;
	message?: AgentMessage;
	summary?: string;
}

export interface SessionHeader {
	id: string;
	cwd: string;
	createdAt: number;
	leafId?: string | null;
}

export interface SessionRecord {
	header: SessionHeader;
	nodes: SessionNode[];
	leafId: string | null;
}

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/[^a-zA-Z0-9._-]+/g, "_")}--`;
}

export function defaultSessionsRoot(): string {
	return join(homedir(), ".z-agent", "sessions");
}

export function sessionDirForCwd(cwd: string, root = defaultSessionsRoot()): string {
	return join(root, encodeCwd(cwd));
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSession(cwd: string): SessionRecord {
	const id = newId();
	return {
		header: { id, cwd, createdAt: Date.now() },
		nodes: [],
		leafId: null,
	};
}

export function appendMessage(session: SessionRecord, message: AgentMessage): SessionNode {
	const node: SessionNode = {
		id: newId(),
		parentId: session.leafId,
		type: "message",
		createdAt: Date.now(),
		message,
	};
	session.nodes.push(node);
	session.leafId = node.id;
	return node;
}

export function appendCompaction(session: SessionRecord, summary: string): SessionNode {
	const node: SessionNode = {
		id: newId(),
		parentId: session.leafId,
		type: "compaction",
		createdAt: Date.now(),
		summary,
	};
	session.nodes.push(node);
	session.leafId = node.id;
	return node;
}

export function branch(session: SessionRecord, nodeId: string): SessionRecord {
	if (!session.nodes.some((node) => node.id === nodeId)) {
		throw new Error(`Unknown session node: ${nodeId}`);
	}
	return { ...session, leafId: nodeId };
}

export function rootToLeaf(session: SessionRecord): SessionNode[] {
	const byId = new Map(session.nodes.map((node) => [node.id, node]));
	const path: SessionNode[] = [];
	let current = session.leafId ? byId.get(session.leafId) : undefined;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

export function messagesOnLeaf(session: SessionRecord): AgentMessage[] {
	return rootToLeaf(session)
		.filter((node) => node.type === "message" && node.message)
		.map((node) => node.message as AgentMessage);
}

export async function saveSession(session: SessionRecord, root = defaultSessionsRoot()): Promise<string> {
	const dir = sessionDirForCwd(session.header.cwd, root);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${session.header.id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "header", ...session.header, leafId: session.leafId }),
		...session.nodes.map((node) => JSON.stringify(node)),
	];
	await writeFile(path, `${lines.join("\n")}\n`, "utf-8");
	return path;
}

export async function loadSession(cwd: string, id: string, root = defaultSessionsRoot()): Promise<SessionRecord> {
	const path = join(sessionDirForCwd(cwd, root), `${id}.jsonl`);
	const text = await readFile(path, "utf-8");
	const lines = text.split("\n").filter((line) => line.length > 0);
	const headerLine = JSON.parse(lines[0]) as SessionHeader & { type: string };
	const nodes = lines.slice(1).map((line) => JSON.parse(line) as SessionNode);
	return {
		header: { id: headerLine.id, cwd: headerLine.cwd, createdAt: headerLine.createdAt },
		nodes,
		leafId: headerLine.leafId !== undefined ? headerLine.leafId : (nodes[nodes.length - 1]?.id ?? null),
	};
}

export async function listSessionIds(cwd: string, root = defaultSessionsRoot()): Promise<string[]> {
	const dir = sessionDirForCwd(cwd, root);
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	names.sort();
	return names.map((name) => name.replace(/\.jsonl$/, ""));
}

export async function latestSessionId(cwd: string, root = defaultSessionsRoot()): Promise<string | undefined> {
	const dir = sessionDirForCwd(cwd, root);
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	names.sort();
	const last = names[names.length - 1];
	return last?.replace(/\.jsonl$/, "");
}

export function listSessionSummaries(session: SessionRecord): Array<{ id: string; label: string }> {
	return session.nodes
		.filter((node) => node.type === "message")
		.map((node) => ({
			id: node.id,
			label: node.message && "role" in node.message ? String(node.message.role) : node.id,
		}));
}
