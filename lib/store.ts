// Data layer for the Prompts plugin: queue + snippets over one SQLite db.
// Pure db-in/db-out functions so the unit tests can drive them against a
// plain better-sqlite3 handle without a bb host.
import { randomBytes } from "node:crypto";

// Minimal structural type so we depend on neither better-sqlite3's types nor
// the SDK's database wrapper — both satisfy it.
export interface Db {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
  // Loose on purpose: both better-sqlite3's Transaction<T> wrapper and the
  // SDK's database handle satisfy this shape.
  transaction(fn: (...params: never[]) => unknown): (...params: never[]) => unknown;
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    thread_id TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    auto_send INTEGER NOT NULL DEFAULT 0,
    send_at INTEGER,
    position INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    used_at INTEGER,
    used_via TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prompts_scope ON prompts (scope, thread_id, status, position)`,
  `CREATE INDEX IF NOT EXISTS idx_prompts_send_at ON prompts (send_at) WHERE send_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS snippet_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    group_id TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_snippets_group ON snippets (group_id)`,
];

export type Scope = "thread" | "global";
export type UsedVia = "inject" | "auto-send" | "cli" | "scheduled" | "cross-thread";

export interface Prompt {
  id: string;
  scope: Scope;
  threadId: string | null;
  text: string;
  status: "queued" | "used";
  autoSend: boolean;
  sendAt: number | null;
  position: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  usedAt: number | null;
  usedVia: UsedVia | null;
}

export interface Snippet {
  id: string;
  title: string;
  body: string;
  description: string;
  keywords: string;
  groupId: string | null;
  groupName: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PromptRow {
  id: string;
  scope: string;
  thread_id: string | null;
  text: string;
  status: string;
  auto_send: number;
  send_at: number | null;
  position: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  used_at: number | null;
  used_via: string | null;
}

interface SnippetRow {
  id: string;
  title: string;
  body: string;
  description: string;
  keywords: string;
  group_id: string | null;
  group_name: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToPrompt(row: PromptRow): Prompt {
  return {
    id: row.id,
    scope: row.scope as Scope,
    threadId: row.thread_id,
    text: row.text,
    status: row.status as Prompt["status"],
    autoSend: row.auto_send === 1,
    sendAt: row.send_at,
    position: row.position,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usedAt: row.used_at,
    usedVia: row.used_via as UsedVia | null,
  };
}

function rowToSnippet(row: SnippetRow): Snippet {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    description: row.description,
    keywords: row.keywords,
    groupId: row.group_id,
    groupName: row.group_name,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

const SNIPPET_SELECT = `SELECT s.*, g.name AS group_name FROM snippets s
  LEFT JOIN snippet_groups g ON g.id = s.group_id`;

export function createStore(db: Db, now: () => number = Date.now) {
  function nextPosition(scope: Scope, threadId: string | null): number {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(position), 0) AS max_pos FROM prompts
         WHERE scope = ? AND thread_id IS ? AND status = 'queued'`,
      )
      .get(scope, threadId) as { max_pos: number };
    return row.max_pos + 1;
  }

  function getPrompt(id: string): Prompt | null {
    const row = db.prepare(`SELECT * FROM prompts WHERE id = ?`).get(id) as
      | PromptRow
      | undefined;
    return row ? rowToPrompt(row) : null;
  }

  function listQueued(scope: Scope, threadId: string | null): Prompt[] {
    const rows = db
      .prepare(
        `SELECT * FROM prompts
         WHERE scope = ? AND thread_id IS ? AND status = 'queued'
         ORDER BY position ASC, created_at ASC`,
      )
      .all(scope, threadId) as PromptRow[];
    return rows.map(rowToPrompt);
  }

  function listRecentlyUsed(threadId: string | null, limit: number): Prompt[] {
    const rows = db
      .prepare(
        `SELECT * FROM prompts
         WHERE status = 'used' AND (thread_id IS ? OR scope = 'global')
         ORDER BY used_at DESC LIMIT ?`,
      )
      .all(threadId, limit) as PromptRow[];
    return rows.map(rowToPrompt);
  }

  function addPrompt(input: {
    text: string;
    scope: Scope;
    threadId: string | null;
    autoSend: boolean;
    sendAt?: number | null;
  }): Prompt {
    const threadId = input.scope === "thread" ? input.threadId : null;
    if (input.scope === "thread" && threadId === null) {
      throw new Error("A thread-scoped prompt needs a threadId.");
    }
    if (input.sendAt != null && input.scope !== "thread") {
      throw new Error("Only thread-scoped prompts can be scheduled.");
    }
    const timestamp = now();
    const id = newId("pq");
    db.prepare(
      `INSERT INTO prompts (id, scope, thread_id, text, status, auto_send, send_at, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.scope,
      threadId,
      input.text,
      input.autoSend && input.scope === "thread" ? 1 : 0,
      input.sendAt ?? null,
      nextPosition(input.scope, threadId),
      timestamp,
      timestamp,
    );
    return getPrompt(id)!;
  }

  /** Atomically flip queued → used; null when another caller won the claim. */
  function claimPrompt(id: string, via: UsedVia): Prompt | null {
    const timestamp = now();
    const result = db
      .prepare(
        `UPDATE prompts SET status = 'used', used_at = ?, used_via = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(timestamp, via, timestamp, id);
    return result.changes === 1 ? getPrompt(id) : null;
  }

  /** Undo a claim (failed send / user restore); re-queues at the tail. */
  function requeuePrompt(id: string, error?: string): Prompt | null {
    const existing = getPrompt(id);
    if (!existing) return null;
    db.prepare(
      `UPDATE prompts SET status = 'queued', used_at = NULL, used_via = NULL,
       send_at = NULL, last_error = ?, position = ?, updated_at = ? WHERE id = ?`,
    ).run(
      error ?? null,
      nextPosition(existing.scope, existing.threadId),
      now(),
      id,
    );
    return getPrompt(id);
  }

  function reorderPrompts(
    scope: Scope,
    threadId: string | null,
    ids: string[],
  ): boolean {
    const current = listQueued(scope, threadId);
    const currentIds = new Set(current.map((prompt) => prompt.id));
    if (ids.length !== current.length || !ids.every((id) => currentIds.has(id)))
      return false;
    const timestamp = now();
    const apply = db.transaction(() => {
      ids.forEach((id, index) => {
        db.prepare(
          `UPDATE prompts SET position = ?, updated_at = ? WHERE id = ?`,
        ).run(index + 1, timestamp, id);
      });
    });
    apply();
    return true;
  }

  function pruneUsed(keep: number): void {
    db.prepare(
      `DELETE FROM prompts WHERE status = 'used' AND id NOT IN (
         SELECT id FROM prompts WHERE status = 'used'
         ORDER BY used_at DESC LIMIT ?
       )`,
    ).run(keep);
  }

  /** Queued, scheduled, and due — for the cron sweep. */
  function listDue(nowMs: number): Prompt[] {
    const rows = db
      .prepare(
        `SELECT * FROM prompts
         WHERE status = 'queued' AND send_at IS NOT NULL AND send_at <= ?
         ORDER BY send_at ASC`,
      )
      .all(nowMs) as PromptRow[];
    return rows.map(rowToPrompt);
  }

  function nextArmed(threadId: string): Prompt | null {
    const row = db
      .prepare(
        `SELECT * FROM prompts
         WHERE thread_id = ? AND status = 'queued' AND auto_send = 1
         ORDER BY position ASC, created_at ASC LIMIT 1`,
      )
      .get(threadId) as PromptRow | undefined;
    return row ? rowToPrompt(row) : null;
  }

  // ---- Snippets ----

  function ensureGroup(name: string | null): string | null {
    const trimmed = name?.trim() ?? "";
    if (!trimmed) return null;
    const existing = db
      .prepare(`SELECT id FROM snippet_groups WHERE name = ?`)
      .get(trimmed) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId("grp");
    const timestamp = now();
    db.prepare(
      `INSERT INTO snippet_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(id, trimmed, timestamp, timestamp);
    return id;
  }

  function getSnippet(id: string): Snippet | null {
    const row = db.prepare(`${SNIPPET_SELECT} WHERE s.id = ?`).get(id) as
      | SnippetRow
      | undefined;
    return row ? rowToSnippet(row) : null;
  }

  function listSnippets(query: string): Snippet[] {
    if (!query.trim()) {
      const rows = db
        .prepare(
          `${SNIPPET_SELECT} ORDER BY s.use_count DESC, s.updated_at DESC LIMIT 200`,
        )
        .all() as SnippetRow[];
      return rows.map(rowToSnippet);
    }
    const like = `%${query.trim().replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare(
        `${SNIPPET_SELECT}
         WHERE s.title LIKE ? OR s.keywords LIKE ? OR s.body LIKE ? OR g.name LIKE ?
         ORDER BY s.use_count DESC, s.updated_at DESC LIMIT 200`,
      )
      .all(like, like, like, like) as SnippetRow[];
    return rows.map(rowToSnippet);
  }

  function addSnippet(input: {
    title: string;
    body: string;
    description?: string;
    keywords?: string;
    groupName?: string | null;
  }): Snippet {
    const id = newId("snip");
    const timestamp = now();
    db.prepare(
      `INSERT INTO snippets (id, title, body, description, keywords, group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.body,
      input.description ?? "",
      input.keywords ?? "",
      ensureGroup(input.groupName ?? null),
      timestamp,
      timestamp,
    );
    return getSnippet(id)!;
  }

  function updateSnippet(input: {
    id: string;
    title?: string;
    body?: string;
    description?: string;
    keywords?: string;
    groupName?: string | null;
  }): Snippet | null {
    const existing = getSnippet(input.id);
    if (!existing) return null;
    const groupId =
      input.groupName === undefined
        ? existing.groupId
        : ensureGroup(input.groupName);
    db.prepare(
      `UPDATE snippets SET title = ?, body = ?, description = ?, keywords = ?, group_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title ?? existing.title,
      input.body ?? existing.body,
      input.description ?? existing.description,
      input.keywords ?? existing.keywords,
      groupId,
      now(),
      input.id,
    );
    pruneEmptyGroups();
    return getSnippet(input.id);
  }

  function deleteSnippet(id: string): boolean {
    const result = db.prepare(`DELETE FROM snippets WHERE id = ?`).run(id);
    pruneEmptyGroups();
    return result.changes === 1;
  }

  function pruneEmptyGroups(): void {
    db.prepare(
      `DELETE FROM snippet_groups WHERE id NOT IN (
         SELECT DISTINCT group_id FROM snippets WHERE group_id IS NOT NULL
       )`,
    ).run();
  }

  function touchSnippet(id: string): void {
    db.prepare(
      `UPDATE snippets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
    ).run(now(), id);
  }

  return {
    nextPosition,
    getPrompt,
    listQueued,
    listRecentlyUsed,
    addPrompt,
    claimPrompt,
    requeuePrompt,
    reorderPrompts,
    pruneUsed,
    listDue,
    nextArmed,
    getSnippet,
    listSnippets,
    addSnippet,
    updateSnippet,
    deleteSnippet,
    touchSnippet,
  };
}

export type Store = ReturnType<typeof createStore>;
