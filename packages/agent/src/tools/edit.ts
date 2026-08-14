/**
 * Exact-text file edits against the original file. Unique, non-overlapping.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";

const replaceEditSchema = z.object({
	oldText: z.string().describe("Exact text to replace. Must be unique in the file and not overlap other edits."),
	newText: z.string().describe("Replacement text for this edit."),
});

const editSchema = z.object({
	path: z.string().describe("Path to the file to edit (relative or absolute)"),
	edits: z.array(replaceEditSchema).min(1).describe("One or more targeted replacements against the original file."),
});

export interface FileEdit {
	oldText: string;
	newText: string;
}

export interface EditToolDetails {
	path: string;
	replacements: number;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) {
		return "\n";
	}
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export function normalizeForMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) {
		return 0;
	}
	let count = 0;
	let from = 0;
	while (from <= haystack.length) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) {
			break;
		}
		count += 1;
		from = index + needle.length;
	}
	return count;
}

interface LocatedEdit {
	editIndex: number;
	start: number;
	end: number;
	newText: string;
}

function locateEdits(base: string, edits: FileEdit[], path: string): LocatedEdit[] {
	const located: LocatedEdit[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.oldText.length === 0) {
			throw new Error(`edits[${i}].oldText must not be empty in ${path}.`);
		}
		const start = base.indexOf(edit.oldText);
		if (start === -1) {
			throw new Error(
				`Could not find edits[${i}] in ${path}. oldText must match uniquely, including whitespace and newlines.`,
			);
		}
		const occurrences = countOccurrences(base, edit.oldText);
		if (occurrences > 1) {
			throw new Error(
				`Found ${occurrences} occurrences of edits[${i}] in ${path}. oldText must be unique; add more surrounding context.`,
			);
		}
		located.push({
			editIndex: i,
			start,
			end: start + edit.oldText.length,
			newText: edit.newText,
		});
	}

	located.sort((a, b) => a.start - b.start);
	for (let i = 1; i < located.length; i++) {
		if (located[i - 1].end > located[i].start) {
			throw new Error(
				`edits overlap in ${path} (edits[${located[i - 1].editIndex}] and edits[${located[i].editIndex}]).`,
			);
		}
	}
	return located;
}

export function applyEdits(original: string, edits: FileEdit[], path: string): string {
	const ending = detectLineEnding(original);
	const { bom, text } = stripBom(original);
	const lf = normalizeToLF(text);
	const lfEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	let base = lf;
	let working = lfEdits;
	const exactMissing = lfEdits.some((edit) => base.indexOf(edit.oldText) === -1);
	if (exactMissing) {
		base = normalizeForMatch(lf);
		working = lfEdits.map((edit) => ({
			oldText: normalizeForMatch(edit.oldText),
			newText: edit.newText,
		}));
	}

	const located = locateEdits(base, working, path);
	let next = base;
	for (let i = located.length - 1; i >= 0; i--) {
		const item = located[i];
		next = `${next.slice(0, item.start)}${item.newText}${next.slice(item.end)}`;
	}

	if (next === base) {
		throw new Error(`No changes made to ${path}.`);
	}

	return `${bom}${restoreLineEndings(next, ending)}`;
}

export function createEditTool(
	cwd: string,
	options: CodingToolsOptions = {},
): AgentTool<typeof editSchema, EditToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	return {
		name: "edit",
		label: "Edit",
		description:
			"Make precise file edits with exact text replacement. Each oldText is matched against the original file and must be unique.",
		parameters: editSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<EditToolDetails>> {
			throwIfAborted(signal);
			const absolutePath = await resolveToolPath(params.path, cwd, jailRoot);
			return await withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				await access(absolutePath, constants.R_OK | constants.W_OK);
				const original = await readFile(absolutePath, "utf-8");
				throwIfAborted(signal);
				const next = applyEdits(original, params.edits, params.path);
				await writeFile(absolutePath, next, "utf-8");
				const plural = params.edits.length === 1 ? "" : "s";
				return {
					content: [{ type: "text", text: `Edited ${params.path} (${params.edits.length} replacement${plural})` }],
					details: { path: absolutePath, replacements: params.edits.length },
				};
			});
		},
	};
}
