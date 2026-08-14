import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyEdits,
	assertInsideJail,
	createAllTools,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	detectImageMimeType,
	win32TaskkillArgs,
	withFileMutationQueue,
} from "../src/tools/index.ts";
import { resolveToCwd } from "../src/tools/path.ts";
import { truncateHead, truncateTail } from "../src/tools/truncate.ts";

async function makeCwd(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "z-agent-agent-tools-"));
}

describe("resolveToCwd + jail", () => {
	it("resolves relative and absolute paths", () => {
		expect(resolveToCwd("a/b.txt", "/tmp/proj")).toBe(join("/tmp/proj", "a/b.txt"));
		expect(resolveToCwd("/etc/hosts", "/tmp/proj")).toBe("/etc/hosts");
		expect(() => resolveToCwd("  ", "/tmp")).toThrow(/empty/);
	});

	it("rejects paths that escape the jail", async () => {
		const dir = await makeCwd();
		await expect(assertInsideJail("/etc/passwd", dir)).rejects.toThrow(/jail/);
		await writeFile(join(dir, "ok.txt"), "x", "utf-8");
		await expect(assertInsideJail(join(dir, "ok.txt"), dir)).resolves.toBeUndefined();
	});
});

describe("truncate + queue", () => {
	it("truncateHead / truncateTail", () => {
		expect(truncateHead("a\nb\nc\nd", { maxLines: 2, maxBytes: 10_000 }).content).toBe("a\nb");
		expect(truncateTail("a\nb\nc\nd", { maxLines: 2, maxBytes: 10_000 }).content).toBe("c\nd");
	});

	it("serializes mutations on the same path", async () => {
		const dir = await makeCwd();
		const path = join(dir, "same.txt");
		let value = 0;
		await Promise.all([
			withFileMutationQueue(path, async () => {
				const snapshot = value;
				await new Promise((resolve) => setTimeout(resolve, 40));
				value = snapshot + 1;
			}),
			withFileMutationQueue(path, async () => {
				const snapshot = value;
				await new Promise((resolve) => setTimeout(resolve, 10));
				value = snapshot + 1;
			}),
		]);
		expect(value).toBe(2);
	});
});

describe("applyEdits", () => {
	it("unique exact, disjoint, overlap, normalize, crlf", () => {
		expect(applyEdits("alpha\nbeta\ngamma\n", [{ oldText: "beta", newText: "BETA" }], "f.txt")).toBe(
			"alpha\nBETA\ngamma\n",
		);
		expect(
			applyEdits(
				"one two three",
				[
					{ oldText: "one", newText: "1" },
					{ oldText: "three", newText: "3" },
				],
				"f.txt",
			),
		).toBe("1 two 3");
		expect(() => applyEdits("aa aa", [{ oldText: "aa", newText: "b" }], "f.txt")).toThrow(/unique/);
		expect(() =>
			applyEdits(
				"abcdef",
				[
					{ oldText: "abcd", newText: "X" },
					{ oldText: "cdef", newText: "Y" },
				],
				"f.txt",
			),
		).toThrow(/overlap/);
		expect(
			applyEdits("say \u201Chello\u201D \n", [{ oldText: 'say "hello"', newText: "say hi" }], "f.txt"),
		).toContain("say hi");
		expect(applyEdits("a\r\nb\r\n", [{ oldText: "b", newText: "B" }], "f.txt")).toBe("a\r\nB\r\n");
	});

	it("fuzzy match does not rewrite unmatched lines", () => {
		const original = "keep \u201Cthis\u201D  \nsay \u201Chello\u201D\n";
		expect(applyEdits(original, [{ oldText: 'say "hello"', newText: "say hi" }], "f.txt")).toBe(
			"keep \u201Cthis\u201D  \nsay hi\n",
		);
	});
});

describe("mime + win32 kill args", () => {
	it("detects png and jpeg magic", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
		expect(detectImageMimeType(png)).toBe("image/png");
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
		expect(detectImageMimeType(jpeg)).toBe("image/jpeg");
		expect(detectImageMimeType(Buffer.from("hello"))).toBeUndefined();
	});

	it("win32 taskkill args include /T", () => {
		expect(win32TaskkillArgs(42)).toEqual(["/F", "/T", "/PID", "42"]);
	});
});

describe("coding tools", () => {
	it("read numbers lines and returns images", async () => {
		const dir = await makeCwd();
		await writeFile(join(dir, "n.txt"), "alpha\nbeta\ngamma\n", "utf-8");
		const tool = createReadTool(dir);
		const result = await tool.execute("t1", { path: "n.txt", offset: 2, limit: 1 });
		expect(result.content[0]).toEqual({ type: "text", text: "2|beta" });

		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
		await writeFile(join(dir, "pic.png"), png);
		const img = await tool.execute("t2", { path: "pic.png" });
		expect(img.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
	});

	it("jail blocks write/read outside cwd", async () => {
		const dir = await makeCwd();
		const write = createWriteTool(dir);
		await expect(write.execute("t1", { path: "/tmp/z-agent-jail-escape.txt", content: "no" })).rejects.toThrow(
			/jail/,
		);
		const read = createReadTool(dir);
		await expect(read.execute("t2", { path: "/etc/passwd" })).rejects.toThrow(/jail/);
	});

	it("write, edit, ls, find, grep", async () => {
		const dir = await makeCwd();
		await mkdir(join(dir, "sub"), { recursive: true });
		const write = createWriteTool(dir);
		await write.execute("t1", { path: "sub/a.ts", content: "export const n = 1;\n" });
		const edit = createEditTool(dir);
		await edit.execute("t2", { path: "sub/a.ts", edits: [{ oldText: "n = 1", newText: "n = 2" }] });
		expect(await readFile(join(dir, "sub/a.ts"), "utf-8")).toContain("n = 2");

		const ls = createLsTool(dir);
		const listed = await ls.execute("t3", { path: "." });
		const lsText = listed.content[0] && listed.content[0].type === "text" ? listed.content[0].text : "";
		expect(lsText).toContain("sub/");

		const find = createFindTool(dir);
		const found = await find.execute("t4", { pattern: "*.ts" });
		const findText = found.content[0] && found.content[0].type === "text" ? found.content[0].text : "";
		expect(findText).toContain("a.ts");

		await writeFile(join(dir, "sub/a.ts.bak"), "export const n = 3;\n", "utf-8");
		const globbed = await find.execute("t4b", { pattern: "*.ts" });
		const globText = globbed.content[0] && globbed.content[0].type === "text" ? globbed.content[0].text : "";
		expect(globText).toContain("a.ts");
		expect(globText).not.toContain("a.ts.bak");

		const fileHit = await find.execute("t4c", { path: "sub/a.ts", pattern: "a.ts" });
		const fileHitText = fileHit.content[0] && fileHit.content[0].type === "text" ? fileHit.content[0].text : "";
		expect(fileHitText).toContain("a.ts");

		const grep = createGrepTool(dir, { jailRoot: dir });
		const grepped = await grep.execute("t5", { pattern: "n = 2" });
		const grepText = grepped.content[0] && grepped.content[0].type === "text" ? grepped.content[0].text : "";
		expect(grepText).toContain("n = 2");
		expect(grepText).not.toMatch(/^\//m);
	});

	it("ls rejects a file path", async () => {
		const dir = await makeCwd();
		await writeFile(join(dir, "only.txt"), "x", "utf-8");
		const ls = createLsTool(dir);
		await expect(ls.execute("t1", { path: "only.txt" })).rejects.toThrow(/not a directory/i);
	});

	it("grep abort does not fall back to a full JS scan", async () => {
		const dir = await makeCwd();
		await writeFile(join(dir, "hit.txt"), "needle\n", "utf-8");
		const controller = new AbortController();
		let enteredRipgrep = () => {};
		const inRipgrep = new Promise<void>((resolve) => {
			enteredRipgrep = resolve;
		});
		const tool = createGrepTool(dir, {
			ripgrep: async (_pattern, _root, signal) => {
				enteredRipgrep();
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("Operation aborted"));
						},
						{ once: true },
					);
				});
				return undefined;
			},
		});
		const pending = tool.execute("t1", { pattern: "needle" }, controller.signal);
		await inRipgrep;
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/i);
	});

	it("bash abort and factories", async () => {
		const dir = await makeCwd();
		const tool = createBashTool(dir);
		const ok = await tool.execute("t1", { command: "pwd" });
		const okText = ok.content[0] && ok.content[0].type === "text" ? ok.content[0].text : "";
		expect(okText).toContain("exit 0");

		const controller = new AbortController();
		const pending = tool.execute("t2", { command: "sleep 30" }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 80));
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted|Timed out/i);

		expect(createCodingTools(dir).map((item) => item.name)).toEqual(["read", "bash", "edit", "write"]);
		expect(createAllTools(dir).map((item) => item.name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
	}, 10_000);
});
