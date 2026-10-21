# pi-prose-watch

An AI-tone check for [pi](https://pi.dev) that runs only while the agent writes prose.

Scanning every edit would judge code, configuration, and logs for no reason. Here the agent arms the files it drafts, and only those are checked:

1. When the agent starts drafting or revising an article, document, chapter, or note, it calls `prose_watch` with action `on` and the file's path. The tool's prompt guideline tells it to.
2. After every successful `write` or `edit` of an armed file, the text that call added (not the whole file; front matter, code fences, and tags removed) goes to [Jev](https://typesafe.ai), TypeSafe's System One classifier.
3. When Jev judges it likely AI-written, a warning is appended to that tool's result, with the pattern that shows most: staged contrasts, filler transitions, slogans, figurative verbs, inflation, translated phrasing, or framing. The agent rereads those sentences before going on.
4. `prose_watch` with action `off` disarms the given files, or every file when no path is given. A new session starts with nothing armed.

```bash
pi install npm:pi-prose-watch
```

It needs `TYPESAFE_API_KEY` in the environment (`TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` are optional). Arming without the key fails, and a failed Jev call is reported in the tool result as "not judged", so a check that did not run never looks like a pass.

## What the verdict means

Jev returns a probability and a pattern, not the sentences, so the warning is a reminder: finding and rewriting the sentences stays with the agent's own writing rules.

The threshold is 0.7. It was calibrated against `jev-1.13.0` on Traditional Chinese: 17 paragraphs of one author's published essays scored 0.25–0.55, and four paragraphs of stock AI prose scored 0.80–0.92. One AI paragraph written in a translated register scored 0.56 and is not caught; the check is tuned to stay quiet on human text rather than to catch everything. Edits shorter than 40 characters of prose are not sent.

## License

MIT
