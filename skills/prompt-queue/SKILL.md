---
name: prompt-queue
description: Queue follow-up prompts for later instead of acting on them now, and reuse saved snippets. Use when the user says "later", "after this", "next up", "queue this", "remind me to ask", or wants a reusable prompt saved.
---

# Prompt queue & snippets

The Prompts plugin keeps two stores the user manages from the composer:

- **Queue** — one-shot prompts scoped to a thread or global. Queued prompts
  can be armed to auto-send when the thread goes idle, or scheduled with
  `--at`.
- **Snippets** — reusable titled prompts; `{{tokens}}` in a body are
  fill-in placeholders.

## When to use

- The user mentions work to do *after* the current task ("later", "after
  this", "when you're done", "next up"): queue it for this thread instead of
  starting it now — `bb prompts add <text>`. Add `--arm` only when the user
  clearly wants it to run automatically.
- The user asks to save something as a reusable prompt: use
  `bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] <body…>`.
- You need a saved prompt's text: `bb prompts snips [query]` to find it,
  `bb prompts snip-show <id>` to print the body.

## Commands

```
bb prompts list                     # queued prompts (thread + global)
bb prompts add [-g] [--arm] [--at +5m|ISO] <text…>
bb prompts send <id>                # send a queued prompt to this thread now
bb prompts push <id>                # move it into bb's native queue (auto-delivers next turn)
bb prompts stash                    # pull ALL of bb's queued messages into the stash (halts auto-delivery)
bb prompts arm|disarm <id>          # toggle auto-send-on-idle
bb prompts run                      # arm the whole thread queue (drains in order)
bb prompts pause | resume           # gate auto-send for this thread
bb prompts rm <id>
bb prompts snips [query]            # search snippets
bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] <body…>
bb prompts snip-show <id>
bb prompts snip-rm <id>
```

## Notes

- If your session instructions mention queued follow-up prompts for this
  thread, finish the current task cleanly rather than starting open-ended new
  work — the queue runs next.
- Queuing is non-destructive: nothing sends until the user injects it, arms
  it, or schedules it (except `--arm`/`--at`, which you should only use when
  explicitly asked).
