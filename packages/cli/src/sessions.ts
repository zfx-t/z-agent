/**
 * JSONL session tree (product persistence, not L5 op.state).
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@z-agent/agent";
import {
	reduceSkillState,
	type SkillActivationNode,
	type SkillDeactivationNode,
	type SkillMode,
	type SkillModeNode,
	type SkillState,
	type SkillStateNode,
} from "@z-agent/skills";
import { pillowUserDir } from "./pillow-home.ts";

export type SessionEntryType =
	| "message"
	| "compaction"
	| "label"
	| "skill_activation"
	| "skill_deactivation"
	| "skill_mode";

interface SessionNodeBase {
	id: string;
	parentId: string | null;
	createdAt: number;
}

export interface SessionMessageNode extends SessionNodeBase {
	type: "message";
	message: AgentMessage;
}

export interface SessionCompactionNode extends SessionNodeBase {
	type: "compaction";
	summary: string;
}

export interface SessionLabelNode extends SessionNodeBase {
	type: "label";
	label?: string;
}

export type SessionNode =
	| SessionMessageNode
	| SessionCompactionNode
	| SessionLabelNode
	| SkillActivationNode
	| SkillDeactivationNode
	| SkillModeNode;

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
	return join(pillowUserDir(), "sessions");
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

/** Start a new reachable branch while retaining old nodes for append-only history. */
export function resetSessionBranch(session: SessionRecord): void {
	session.leafId = null;
}

export function appendMessage(session: SessionRecord, message: AgentMessage): SessionMessageNode {
	const node: SessionMessageNode = {
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

export function appendCompaction(session: SessionRecord, summary: string): SessionCompactionNode {
	const node: SessionCompactionNode = {
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

export function appendSkillActivation(
	session: SessionRecord,
	input: Omit<SkillActivationNode, "id" | "parentId" | "createdAt">,
): SkillActivationNode {
	const node: SkillActivationNode = {
		...input,
		id: newId(),
		parentId: session.leafId,
		createdAt: Date.now(),
	};
	session.nodes.push(node);
	session.leafId = node.id;
	return node;
}

export function appendSkillDeactivation(
	session: SessionRecord,
	input: Omit<SkillDeactivationNode, "id" | "parentId" | "createdAt">,
): SkillDeactivationNode {
	const node: SkillDeactivationNode = {
		...input,
		id: newId(),
		parentId: session.leafId,
		createdAt: Date.now(),
	};
	session.nodes.push(node);
	session.leafId = node.id;
	return node;
}

export function appendSkillMode(session: SessionRecord, mode: SkillMode): SkillModeNode {
	const node: SkillModeNode = {
		type: "skill_mode",
		schemaVersion: 1,
		id: newId(),
		parentId: session.leafId,
		createdAt: Date.now(),
		mode,
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
	const path = rootToLeaf(session);
	let lastCompaction = -1;
	for (let index = path.length - 1; index >= 0; index--) {
		if (path[index]?.type === "compaction") {
			lastCompaction = index;
			break;
		}
	}
	const messages: AgentMessage[] = [];
	const start = lastCompaction >= 0 ? lastCompaction + 1 : 0;
	if (lastCompaction >= 0) {
		const node = path[lastCompaction];
		if (node?.type === "compaction") {
			messages.push({
				role: "user",
				content: [{ type: "text", text: node.summary }],
				timestamp: node.createdAt,
			});
		}
	}
	for (const node of path.slice(start)) {
		if (node.type === "message") {
			messages.push(node.message);
		}
	}
	return messages;
}

function isSkillStateNode(node: SessionNode): node is SkillStateNode {
	return node.type === "skill_activation" || node.type === "skill_deactivation" || node.type === "skill_mode";
}

export function skillStateOnLeaf(session: SessionRecord): SkillState {
	return reduceSkillState(rootToLeaf(session).filter(isSkillStateNode));
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
		.filter((node): node is SessionMessageNode => node.type === "message")
		.map((node) => ({
			id: node.id,
			label: "role" in node.message ? String(node.message.role) : node.id,
		}));
}
