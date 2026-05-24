---
name: propose-snippets
description: Dispatch N parallel subagents to propose snippets for pending worklist entries. Each subagent fetches the cited source, finds a verbatim supporting substring, and writes its proposal back into .snippet-worklist.json. Use after running `bun run snippet-worklist`.
---

Read `.snippet-worklist.json` from the current working directory (`~/git/pterror/software-taxonomy`).

Parse `$ARGUMENTS` as an integer N (default 8 if blank or unparseable). Take the first N entries with `status === "pending"`.

If fewer than N pending entries exist, use all of them. If zero, report that and stop.

Dispatch all N as **parallel Agent calls in a single message** (subagent_type=general-purpose, model=claude-sonnet-4-6). Do not send them sequentially. Each subagent receives the following self-contained prompt with `<stmt_id>`, `<source_id>`, `<source_url>`, `<source_revid>`, `<source_kind>`, `<subject>`, `<predicate>`, and `<value>` substituted from the worklist entry:

---

Working dir: ~/git/pterror/software-taxonomy. Worklist file: `.snippet-worklist.json`. Your task id: `<stmt_id>`.

1. Read the worklist file (parse JSON, find the entry with `stmt_id === "<stmt_id>"`).

2. Fetch the source text:
   - wikipedia: `GET https://en.wikipedia.org/w/index.php?oldid=<source_revid>&action=raw` (raw wikitext)
   - official: `GET <source_url>`, strip HTML tags (replace `<...>` with space, collapse whitespace).
   Do not use any external npm packages; use Bun's built-in `fetch`.

3. Find the shortest verbatim substring in the fetched text that supports the claim:
   `<subject> <predicate> <value>`
   - Prefer one sentence; never more than three sentences.
   - The substring MUST appear verbatim in the fetched text (case-sensitive exact match).
   - If multiple candidates, prefer the one closest to the article lead.
   - Do not paraphrase or invent — copy exactly from the fetched text.

4. If you find a supporting substring: set `status: "proposed"`, `proposed_snippet: "<the substring>"`, `confidence: "high"|"medium"|"low"`, and optionally `notes`.

   If no supporting substring exists (the claim is not supported by this source), set `status: "unsupported"` and `notes: "<what the source actually says about the subject>"`.

5. Use the Edit tool to write back ONLY this entry's fields in the worklist JSON. Preserve all other entries untouched. The exact-string `"stmt_id": "<stmt_id>"` in the JSON file is your anchor for the Edit tool's old_string parameter — match the full entry object.

6. Report under 40 words: stmt_id, status, confidence (or "unsupported").

---

After all subagents return, report per-task status to the user (stmt_id + status + confidence, one line each). Remind the user to run `bun run snippet-status` to see the updated breakdown, and `bun run review-snippets` to promote accepted proposals.
