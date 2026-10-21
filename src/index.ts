/**
 * pi extension: the `prose_watch` tool arms an AI-tone check on the files the agent is drafting.
 * After `prose_watch on` with a file's path, every successful `write` or `edit` of that file sends
 * the text the call added to Jev (TypeSafe System One), which judges whether it reads AI-written
 * and which pattern shows most. A likely-AI verdict is appended to the tool result, so the agent
 * rereads those sentences before going on. Files not armed are never sent, so ordinary coding is
 * not scanned. Jev returns probabilities, not locations: the warning is a reminder, and finding
 * the sentences stays with the agent's own polishing rules.
 */

import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const TOOL_NAME = "prose_watch";
// Calibrated on 2026-10-21 against jev-1.13.0: 17 paragraphs of the author's published essays scored
// 0.25–0.55, four stock AI paragraphs 0.80–0.92; one AI paragraph in a translated register scored 0.56.
export const AI_THRESHOLD = 0.7;
export const MIN_CHARS = 40;
const MAX_CHARS = 6000;
const TIMEOUT_MS = 10_000;

export const QUESTIONS = {
	ai: {
		type: "bool" as const,
		instructions:
			"`text` is a passage of prose. Would an experienced editor who reads a lot of chatbot output flag it as written by a language model? Ordinary argument, formal or translated vocabulary, quotations, and summaries of other authors are human too; flag only the habits a model shows when it writes on its own.",
		criteria: {
			true: "several model habits together: empty significance, filler transitions (此外、值得注意的是、總的來說), staged 不是…而是 contrasts with nobody holding the denied view, slogan or triplet lines, generic claims with no specific case",
			false: "a specific person reasoning about a specific case, even if formal, translated-sounding, or plain",
		},
	},
	tell: {
		type: "choice" as const,
		instructions: "Which AI-writing pattern is most prominent in `text`?",
		criteria: {
			none: "no clear AI-writing pattern",
			contrast: "contrasts that deny a claim nobody made (不是 X，而是 Y; not X but Y)",
			filler: "stock transitions and filler (此外、值得注意的是、總的來說; moreover, it is worth noting)",
			slogans: "forced triplets, parallel slogans, one-line punch paragraphs, quotable closers",
			figurative: "figurative verbs standing in for a relation or conclusion (接上、撐、扛、卡在)",
			inflation: "inflated significance, empty intensifiers, or stacked hedges (似乎、彷彿)",
			translated: "translated-sounding or westernised phrasing (chains of 的, 被 passives, 作為, 對於…來說)",
			framing: "previews, recaps, uplifting endings, or talk about the text instead of its subject",
		},
	},
};

export type Tell = keyof typeof QUESTIONS.tell.criteria;
export interface Judgement {
	ai: number;
	tell: Tell;
}
export type Judge = (text: string, signal: AbortSignal) => Promise<Judgement>;

type Answers = { ai?: { noul?: number }; tell?: { choice?: string } };

// The wire protocol calls a bool question `noul` and returns its probability under that key;
// pi's classifier API maps the same way (pi-ai system-one-shared.js).
const WIRE_QUESTIONS = { ai: { ...QUESTIONS.ai, type: "noul" }, tell: QUESTIONS.tell };

/** One TypeSafe System One request, called through fetch so the package needs no SDK. */
export function jevJudge(env: NodeJS.ProcessEnv = process.env): Judge {
	return async (text, signal) => {
		const apiKey = env.TYPESAFE_API_KEY;
		if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
		const baseUrl = (env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai").replace(/\/+$/, "");
		const response = await fetch(`${baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ state: { text }, questions: WIRE_QUESTIONS, model: env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest" }),
			signal,
		});
		if (!response.ok) throw new Error(`TypeSafe ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const answers = ((await response.json()) as { answers?: Answers }).answers;
		const ai = answers?.ai?.noul;
		const tell = answers?.tell?.choice;
		if (typeof ai !== "number" || !tell || !(tell in QUESTIONS.tell.criteria)) {
			throw new Error(`unexpected TypeSafe answer: ${JSON.stringify(answers).slice(0, 200)}`);
		}
		return { ai, tell: tell as Tell };
	};
}

/** The text a successful write or edit call added, or undefined for other calls. */
export function addedText(event: Pick<ToolResultEvent, "toolName" | "input" | "isError">): string | undefined {
	if (event.isError) return undefined;
	const input = event.input as { content?: unknown; edits?: unknown };
	if (event.toolName === "write" && typeof input.content === "string") return input.content;
	if (event.toolName === "edit" && Array.isArray(input.edits)) {
		return input.edits
			.map((edit) => (edit && typeof (edit as { newText?: unknown }).newText === "string" ? (edit as { newText: string }).newText : ""))
			.filter(Boolean)
			.join("\n\n");
	}
	return undefined;
}

/** Fenced code, front matter, and markup carry no prose; the length check counts what remains. */
export function proseOf(text: string): string {
	return text
		.replace(/^---\n[\s\S]*?\n---\n?/, "")
		.replace(/```[\s\S]*?(?:```|$)/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+/g, " ")
		.trim();
}

export function warning(path: string, judgement: Judgement): string {
	const tell = judgement.tell === "none" ? "no single pattern stands out" : `most visibly ${QUESTIONS.tell.criteria[judgement.tell]}`;
	return (
		`prose_watch (Jev, advisory): the text this call added to ${path} reads AI-written ` +
		`(${judgement.ai.toFixed(2)}); ${tell}. Reread those sentences against your AI-tone rules ` +
		"(the AI-tone scan in polishing-prose, when you have it) and rewrite them before going on."
	);
}

const PARAMS = Type.Object(
	{
		action: Type.Union([Type.Literal("on"), Type.Literal("off")], { description: "`on` arms the paths; `off` disarms them, or all when paths is omitted" }),
		paths: Type.Optional(Type.Array(Type.String(), { description: "Prose files, relative to the working directory or absolute" })),
	},
	{ additionalProperties: false },
);

export function createProseWatch(judge: Judge, env: NodeJS.ProcessEnv = process.env) {
	return function (pi: ExtensionAPI) {
		const watched = new Set<string>();
		const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path.replace(/^~(?=\/)/, env.HOME ?? "~")));

		pi.on("session_start", () => {
			watched.clear();
		});

		pi.registerTool({
			name: TOOL_NAME,
			label: "Prose watch",
			description:
				"Arm or disarm an AI-tone check on prose files. With action `on`, every later write or edit of the given files " +
				"sends the added text to Jev, and a likely-AI verdict is appended to that tool's result. `off` with paths disarms them; `off` without paths disarms all.",
			promptSnippet: "Arm an AI-tone check (Jev) on the prose files you are drafting",
			promptGuidelines: [
				"When you start drafting or revising prose for a human reader in a file (an article, document, chapter, or note), call prose_watch with action `on` and that file's path before the first write, and `off` when the prose work ends. Code and configuration files are never armed.",
			],
			parameters: PARAMS,
			async execute(_toolCallId: string, params: Static<typeof PARAMS>, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
				const paths = (params.paths ?? []).map((path) => absolute(ctx.cwd, path));
				if (params.action === "on") {
					if (paths.length === 0) throw new Error("prose_watch on needs at least one path");
					if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set, so Jev cannot judge; nothing was armed");
					for (const path of paths) watched.add(path);
				} else if (paths.length === 0) {
					watched.clear();
				} else {
					for (const path of paths) watched.delete(path);
				}
				const list = [...watched];
				return {
					content: [{ type: "text" as const, text: list.length > 0 ? `Watching:\n${list.join("\n")}` : "Watching no files." }],
					details: { watched: list },
				};
			},
		});

		pi.on("tool_result", async (event, ctx) => {
			if (watched.size === 0) return;
			const path = typeof event.input.path === "string" ? absolute(ctx.cwd, event.input.path) : undefined;
			if (!path || !watched.has(path)) return;
			const added = addedText(event);
			if (added === undefined) return;
			const prose = proseOf(added);
			if (prose.length < MIN_CHARS) return;
			let judgement: Judgement;
			try {
				judgement = await judge(prose.slice(0, MAX_CHARS), AbortSignal.timeout(TIMEOUT_MS));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return { content: [...event.content, { type: "text" as const, text: `prose_watch: Jev check failed, this change was not judged: ${reason}` }] };
			}
			if (judgement.ai < AI_THRESHOLD) return;
			return { content: [...event.content, { type: "text" as const, text: warning(path, judgement) }] };
		});
	};
}

export default createProseWatch(jevJudge());
