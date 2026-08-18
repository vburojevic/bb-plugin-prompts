---
name: prompt-queue
description: Queue follow-up prompts for later instead of acting on them now, and reuse saved snippets. Use when the user says "later", "after this", "next up", "queue this", "remind me to ask", or wants a reusable prompt saved.
---

# Prompt queue & snippets

The Prompts plugin keeps two stores the user manages from the composer:

- **Queue** — one-shot prompts, scoped to a **thread**, a **project**, or
  **globally**. Thread-scoped prompts can be armed to auto-send when the thread
  goes idle, or scheduled with `--at`. Project-scoped prompts outlive the thread
  they were written in — when a thread is archived or deleted, whatever it still
  has queued moves to its project.
- **Snippets** — reusable titled prompts; `{{tokens}}` are fill-in
  placeholders and `{{token=default}}` carries a default. Snippets in one
  **group** can be queued together as a checklist.

The Prompts panel (left sidebar) also proposes snippets on its own: it mines
bb's prompt history for prompts the user keeps retyping and offers them, one
click to save. Proposals the user dismisses stay dismissed.

## When to use

- The user mentions work to do *after* the current task ("later", "after this",
  "when you're done", "next up"): queue it instead of starting it now — the
  `prompts_queue` tool, or `bb prompts add <text>`. Arm or schedule it **only**
  when they clearly asked for it to run on its own.
- Work that outlives this thread ("next time we work on this", "for the next
  session"): queue it with `scope: "project"`.
- The user names a time ("in an hour", "tomorrow morning", "after standup"):
  queue it with `at` (`+1h`, `+30m`, or an ISO timestamp) rather than promising
  to remember. A scheduled prompt sends at its time even if the agent is busy,
  and needs a thread scope.
- The user asks to save something reusable: `prompts_snippet_save`, or
  `bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] <body…>`.
- You need a saved prompt's text: `prompts_snippets` to find it,
  `prompts_snippet_get` to read it (pass `fill` to resolve its tokens).
- The user asks what is worth turning into a snippet, or which prompts they
  repeat: `bb prompts suggest` — do not re-derive this by reading history
  yourself. Suggest, then let them choose; only save if they say so.

## Tools

- `prompts_queue` — stash a follow-up (`scope`: thread | project | global;
  `arm`, `at` only on request).
- `prompts_list` — what is already waiting here.
- `prompts_snippets` / `prompts_snippet_get` / `prompts_snippet_save`.

## Commands

```
bb prompts list [--json]                 # thread + project + global
bb prompts add [-p|-g] [--arm] [--at +5m|ISO] <text…>
bb prompts send <id>                     # send a queued prompt to this thread now
bb prompts push <id>                     # move it into bb's native queue (auto-delivers next turn)
bb prompts stash                         # pull ALL of bb's queued messages into the stash
bb prompts arm|disarm <id>               # toggle auto-send-on-idle
bb prompts run                           # arm the whole thread queue (drains in order)
bb prompts pause | resume                # gate auto-send for this thread
bb prompts promote [<id>]                # keep for the project, past this thread
bb prompts rm <id>
bb prompts snips [query] [--json]
bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] [--project] <body…>
bb prompts snip-show <id> [--set key=value …]
bb prompts snip-rm <id>
bb prompts group <name> [-p|-g]          # queue a whole group as a checklist
bb prompts suggest [--refresh] [--json]  # snippets worth saving, mined from retyped prompts
```

`--` ends option parsing: `bb prompts add -- -g is part of the text`.

## Notes

- If your session instructions mention queued follow-up prompts for this
  thread, finish the current task cleanly rather than starting open-ended new
  work — the queue runs next.
- Queuing is non-destructive: nothing sends until the user injects it, arms it,
  or schedules it (except `--arm`/`--at`, which you should only use when
  explicitly asked).
- Queued prompts are never lost when a thread ends; they move to the project.
  Say so rather than warning the user that their queue is about to disappear.
