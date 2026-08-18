// bb's own per-thread message queue, which this plugin bridges to.
//
// bb's queue auto-delivers at the next turn boundary; this plugin's queue never
// sends anything the user did not ask it to. Moving a message between them is
// the whole bridge, and every path through it lives here so the RPC handlers
// and the CLI cannot drift apart.

/** Structural shape of one queued message; matches the SDK DTO. */
export interface QueuedMessageLike {
  id: string;
  content: { type: string; text?: string }[];
  updatedAt: number;
}

export interface QueuedMessagesApi {
  list(input: { threadId: string }): Promise<QueuedMessageLike[]>;
  create(input: { threadId: string; input: unknown[] }): Promise<unknown>;
  delete(input: { threadId: string; queuedMessageId: string }): Promise<unknown>;
  send(input: {
    threadId: string;
    queuedMessageId: string;
    mode: string;
  }): Promise<unknown>;
}

/** The plain text of a queued message; "" when it carries none. */
export function queuedMessageText(message: QueuedMessageLike): string {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

export interface StashDeps {
  deleteMessage(threadId: string, queuedMessageId: string): Promise<void>;
  /** Writes the text into this plugin's queue and returns the new prompt id. */
  stash(text: string): { id: string };
  /** Undo a stash whose source message could not be deleted. */
  unstash(id: string): void;
}

export interface StashOutcome {
  stashed: number;
  skipped: number;
  error: string | null;
}

/**
 * Copy queued messages into the stash and remove them from bb's queue.
 *
 * Copy first, then delete: a failed delete would otherwise lose the message
 * outright, and the recovery here is to drop the copy so an undeletable
 * message never shows up twice.
 */
export async function stashMessages(
  threadId: string,
  messages: QueuedMessageLike[],
  deps: StashDeps,
): Promise<StashOutcome> {
  let stashed = 0;
  let skipped = 0;
  for (const message of messages) {
    const text = queuedMessageText(message);
    if (!text) {
      skipped += 1;
      continue;
    }
    const prompt = deps.stash(text);
    try {
      await deps.deleteMessage(threadId, message.id);
      stashed += 1;
    } catch {
      deps.unstash(prompt.id);
      skipped += 1;
    }
  }
  return { stashed, skipped, error: null };
}

/** Error message for a caught unknown, without the `instanceof` dance. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
