import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AI_THRESHOLD, addedText, createProseWatch, type Judge, type Judgement, proseOf } from "../src/index.ts";

const PROSE = "小安約小華看電影，自己遲到半小時，小華很生氣。小安為什麼遲到？硬要說原因有好幾個，但這些原因都不是道歉的重點。";

// Registers the extension against a minimal pi; `judge` stands in for Jev and records what it was sent.
function harness(verdict: Judgement | Error, env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "k", HOME: "/home/u" }) {
	const sent: string[] = [];
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
	} as unknown as ExtensionAPI;
	createProseWatch(judge, env)(pi);
	const ctx = { cwd: "/repo" };
	const watch = (params: Record<string, unknown>) =>
		(tool as unknown as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute("t1", params, undefined, undefined, ctx);
	const result = (toolName: string, input: Record<string, unknown>, isError = false) =>
		handlers.get("tool_result")?.({ type: "tool_result", toolName, input, isError, content: [{ type: "text", text: "ok" }] }, ctx) as Promise<
			{ content: { text: string }[] } | undefined
		>;
	return { sent, watch, result, handlers };
}

const likely: Judgement = { ai: AI_THRESHOLD + 0.1, tell: "filler" };

test("an armed file's write is judged, and a likely-AI verdict is appended to the tool result", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["drafts/post.md"] });
	const out = await h.result("write", { path: "/repo/drafts/post.md", content: PROSE });
	assert.deepEqual(h.sent, [PROSE]);
	assert.equal(out?.content[0]?.text, "ok");
	assert.match(out?.content[1]?.text ?? "", /reads AI-written \(0\.80\); most visibly stock transitions/);
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

test("a new session starts with nothing armed", async () => {
	const h = harness(likely);
	await h.watch({ action: "on", paths: ["post.md"] });
	h.handlers.get("session_start")?.({}, {});
	assert.equal(await h.result("write", { path: "/repo/post.md", content: PROSE }), undefined);
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
