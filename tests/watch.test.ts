import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_THRESHOLD, addedText, canonical, chunksOf, createProseWatch, ENTRY_TYPE, type Judge, type Judgement, proseOf } from "../src/index.ts";

const PROSE = "小安約小華看電影，自己遲到半小時，小華很生氣。小安為什麼遲到？硬要說原因有好幾個，但這些原因都不是道歉的重點。";

// Registers the extension against a minimal pi; `judge` stands in for Jev and records what it was sent.
function harness(verdict: Judgement | Error, env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "k", HOME: "/home/u" }, cwd = "/repo") {
	const sent: string[] = [];
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let tool: ToolDefinition | undefined;
	const judge: Judge = async (text) => {
		sent.push(text);
		if (verdict instanceof Error) throw verdict;
		return verdict;
	};
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	createProseWatch(judge, env)(pi);
	const ctx: { cwd: string; signal?: AbortSignal; sessionManager: { getBranch: () => unknown[] } } = { cwd, sessionManager: { getBranch: () => entries } };
	const watch = (params: Record<string, unknown>) =>
		(tool as unknown as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute("t1", params, undefined, undefined, ctx);
	const result = (toolName: string, input: Record<string, unknown>, isError = false, extra: Record<string, unknown> = {}) =>
		handlers.get("tool_result")?.({ type: "tool_result", toolName, input, isError, content: [{ type: "text", text: "ok" }], ...extra }, ctx) as Promise<
			{ content: { text: string }[] } | undefined
		>;
	const restart = () => handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
	return { sent, watch, result, handlers, entries, ctx, restart };
}

const likely: Judgement = { ai: AI_THRESHOLD + 0.1, tell: "filler" };

test("an armed file's write is judged, and a likely-AI verdict is appended to the tool result", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["drafts/post.md"] });
	const out = await h.result("write", { path: "/repo/drafts/post.md", content: PROSE });
	assert.deepEqual(h.sent, [PROSE]);
	assert.equal(out?.content[0]?.text, "ok");
	assert.match(out?.content[1]?.text ?? "", /passage starting 「小安約小華看電影，自己遲到半小時，小華很」, reads AI-written \(0\.80\); most visibly stock transitions/);
});

test("an edit sends only the replacement text, never the whole file", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["/repo/post.md"] });
	await h.result("edit", { path: "post.md", edits: [{ oldText: "a", newText: PROSE }, { oldText: "b", newText: "第二段補上的句子，長度也要夠，才會被送去判斷。" }] });
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0] ?? "", /^小安約小華[\s\S]*\n\n第二段補上的句子/);
});

test("files never armed, failed calls, and short additions are not sent", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["post.md"] });
	assert.equal(await h.result("write", { path: "/repo/src/index.ts", content: PROSE }), undefined);
	assert.equal(await h.result("write", { path: "/repo/post.md", content: PROSE }, true), undefined);
	assert.equal(await h.result("edit", { path: "/repo/post.md", edits: [{ oldText: "a", newText: "改一個字。" }] }), undefined);
	assert.equal(await h.result("bash", { path: "/repo/post.md", command: "cat" }), undefined);
	assert.deepEqual(h.sent, []);
});

test("a verdict below the threshold adds nothing", async () => {
	const h = harness({ ai: AI_THRESHOLD - 0.01, tell: "none" });
	await h.watch({ action: "on", paths: ["post.md"] });
	assert.equal(await h.result("write", { path: "/repo/post.md", content: PROSE }), undefined);
	assert.equal(h.sent.length, 1);
});

test("off disarms the given paths, or every path without any", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["a.md", "b.md"] });
	const afterOne = await h.watch({ action: "off", paths: ["a.md"] });
	assert.equal(afterOne.content[0]?.text, "Watching:\n/repo/b.md");
	assert.equal(await h.result("write", { path: "/repo/a.md", content: PROSE }), undefined);
	const afterAll = await h.watch({ action: "off" });
	assert.equal(afterAll.content[0]?.text, "Watching no files.");
	assert.equal(await h.result("write", { path: "/repo/b.md", content: PROSE }), undefined);
	assert.equal(h.sent.length, 0);
});

test("reload, resume, and fork keep what the session saved; a new session's empty branch arms nothing", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["post.md"] });
	assert.deepEqual(h.entries.at(-1), { type: "custom", customType: ENTRY_TYPE, data: { watched: ["/repo/post.md"] } });
	h.restart();
	assert.ok(await h.result("write", { path: "/repo/post.md", content: PROSE }));
	h.entries.length = 0;
	h.restart();
	assert.equal(await h.result("write", { path: "/repo/post.md", content: PROSE }), undefined);
});

test("the armed path matches however pi's write spells it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pw-"));
	const h = harness(likely, { TYPESAFE_API_KEY: "k", HOME: dir }, dir);
	await h.watch({ action: "on", paths: ["post.md"] });
	for (const spelling of ["@post.md", "./post.md", `${dir}//post.md`, "~/post.md", join(dir, "sub", "..", "post.md")]) {
		assert.ok(await h.result("write", { path: spelling, content: PROSE }), spelling);
	}
	assert.equal(canonical("/tmp", "a.md"), canonical("/private/tmp", "a.md"));
	assert.equal(canonical("/x", "~", "/no-such-root/u"), "/no-such-root/u");
});

test("long text is judged in chunks, and a cut is stated", async () => {
	const paragraph = "甲".repeat(5000);
	assert.deepEqual(chunksOf(`${paragraph}\n\n${paragraph}`).map((c) => c.length), [5000, 5000]);
	assert.deepEqual(chunksOf("乙".repeat(13000)).map((c) => c.length), [6000, 6000, 1000]);
	const h = harness({ ai: 0.9, tell: "contrast" });
	await h.watch({ action: "on", paths: ["post.md"] });
	const out = await h.result("write", { path: "/repo/post.md", content: Array(6).fill(paragraph).join("\n\n") });
	assert.equal(h.sent.length, 4);
	assert.match(out?.content.at(-1)?.text ?? "", /only the first 20000 of 30010 characters were judged/);
});

test("a nested call is skipped, and an aborted turn adds nothing", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["post.md"] });
	assert.equal(await h.result("write", { path: "/repo/post.md", content: PROSE }, false, { parentToolCallId: "p1" }), undefined);
	assert.equal(h.sent.length, 0);
	const aborted = harness(new Error("aborted"));
	await aborted.watch({ action: "on", paths: ["post.md"] });
	aborted.ctx.signal = AbortSignal.abort();
	assert.equal(await aborted.result("write", { path: "/repo/post.md", content: PROSE }), undefined);
});

test("arming without a TypeSafe key fails instead of watching silently", async () => {
	const h = harness(likely, {});
	await assert.rejects(h.watch({ action: "on", paths: ["post.md"] }), /TYPESAFE_API_KEY is not set/);
	await assert.rejects(harness(likely).watch({ action: "on" }), /needs at least one path/);
});

test("a failed Jev call says the change was not judged", async () => {
	const h = harness(new Error("TypeSafe 503"));
	await h.watch({ action: "on", paths: ["~/notes/n.md"] });
	const out = await h.result("write", { path: "/home/u/notes/n.md", content: PROSE });
	assert.match(out?.content[1]?.text ?? "", /Jev check failed, this change was not judged: TypeSafe 503/);
});

test("prose excludes front matter, code fences, and tags", () => {
	assert.equal(proseOf("---\ntitle: x\n---\n正文\n```ts\nconst a = 1;\n```\n<img src=a>結尾"), "正文\n \n 結尾");
	assert.equal(addedText({ toolName: "write", input: { content: "x" }, isError: false }), "x");
	assert.equal(addedText({ toolName: "read", input: { path: "x" }, isError: false }), undefined);
});
