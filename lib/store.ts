// Data layer for the Prompts plugin: queue + snippets over one SQLite db.
// Pure db-in/db-out functions so the unit tests can drive them against a
// plain better-sqlite3 handle without a bb host.
//
// A prompt lives in exactly one of three scopes:
// - thread  — belongs to one thread; the only scope that can arm or schedule.
// - project — belongs to one project; injectable from any thread in it, and
//             where a thread's leftovers land when the thread ends.
// - global  — belongs to nothing; injectable anywhere.
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

// APPEND-ONLY. Statement index is the migration id; never reorder or edit a
// shipped statement, only push new ones.
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
  // Suggestions the user said no to. Keyed by the suggestion's content hash so
  // a dismissal survives history growing and the proposal being recomputed.
  `CREATE TABLE IF NOT EXISTS dismissed_suggestions (
    key TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // --- project scope -------------------------------------------------------
  `ALTER TABLE prompts ADD COLUMN project_id TEXT`,
  // Thread-scoped prompts carry their project too, so a thread ending knows
  // where its leftovers belong without a lookup.
  `CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts (scope, project_id, status, position)`,
  // Where a promoted prompt came from — "3 prompts, from: Fix the flaky test".
  `ALTER TABLE prompts ADD COLUMN origin_thread_title TEXT`,
  `ALTER TABLE snippets ADD COLUMN project_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_snippets_project ON snippets (project_id)`,
  // Repair: a shipped bug let "move to this thread" write scope='thread' with
  // a NULL thread_id, which matched no list query — the prompt survived in the
  // table but vanished from every surface. Put those back in the global queue.
  `UPDATE prompts SET scope = 'global' WHERE scope = 'thread' AND thread_id IS NULL`,
  // Per-thread pause state. Was kv, which cost one async read per thread on
  // every overview; it belongs next to the prompts it gates.
  `CREATE TABLE IF NOT EXISTS thread_state (
    thread_id TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // Last value the user typed for a given {{token}}, so the fill-in dialog can
  // offer it again instead of asking for the same branch name six times.
  `CREATE TABLE IF NOT EXISTS fill_values (
    token TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

export type Scope = "thread" | "project" | "global";
export type UsedVia =
  | "inject"
  | "auto-send"
  | "cli"
  | "scheduled"
  | "cross-thread"
  | "bb-queue"
  | "tool";

export interface Prompt {
  id: string;
  scope: Scope;
  threadId: string | null;
  projectId: string | null;
  originThreadTitle: string | null;
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
  projectId: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PromptRow {
  id: string;
  scope: string;
  thread_id: string | null;
  project_id: string | null;
  origin_thread_title: string | null;
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
  project_id: string | null;
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
    projectId: row.project_id,
    originThreadTitle: row.origin_thread_title,
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
    projectId: row.project_id,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/**
 * Which owner column a scope keys on. Every queue query goes through this, so
 * a scope can never be matched by the wrong column — the shape of bug that
 * made "move to this thread" lose prompts.
 */
export interface ScopeRef {
  scope: Scope;
  threadId?: string | null;
  projectId?: string | null;
}

function ownerOf(ref: ScopeRef): { column: "thread_id" | "project_id" | null; value: string | null } {
  if (ref.scope === "thread") return { column: "thread_id", value: ref.threadId ?? null };
  if (ref.scope === "project") return { column: "project_id", value: ref.projectId ?? null };
  return { column: null, value: null };
}

/** SQL fragment + params selecting exactly one scope group. */
function scopeWhere(ref: ScopeRef): { sql: string; params: unknown[] } {
  const owner = ownerOf(ref);
  if (owner.column === null)
    return { sql: `scope = 'global'`, params: [] };
  return { sql: `scope = ? AND ${owner.column} IS ?`, params: [ref.scope, owner.value] };
}

/** A scope group that can actually hold prompts. Global always can. */
export function isAddressable(ref: ScopeRef): boolean {
  const owner = ownerOf(ref);
  return owner.column === null || owner.value !== null;
}

const SNIPPET_SELECT = `SELECT s.*, g.name AS group_name FROM snippets s
  LEFT JOIN snippet_groups g ON g.id = s.group_id`;

export const SNIPPET_LIST_LIMIT = 200;

export function createStore(db: Db, now: () => number = Date.now) {
  function nextPosition(ref: ScopeRef): number {
    const where = scopeWhere(ref);
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(position), 0) AS max_pos FROM prompts
         WHERE ${where.sql} AND status = 'queued'`,
      )
      .get(...where.params) as { max_pos: number };
    return row.max_pos + 1;
  }

  function getPrompt(id: string): Prompt | null {
    const row = db.prepare(`SELECT * FROM prompts WHERE id = ?`).get(id) as
      | PromptRow
      | undefined;
    return row ? rowToPrompt(row) : null;
  }

  function listQueued(ref: ScopeRef): Prompt[] {
    if (!isAddressable(ref)) return [];
    const where = scopeWhere(ref);
    const rows = db
      .prepare(
        `SELECT * FROM prompts
         WHERE ${where.sql} AND status = 'queued'
         ORDER BY position ASC, created_at ASC`,
      )
      .all(...where.params) as PromptRow[];
    return rows.map(rowToPrompt);
  }

  /** Every used prompt regardless of scope — the manager's history view. */
  function listAllUsed(limit: number): Prompt[] {
    const rows = db
      .prepare(
        `SELECT * FROM prompts WHERE status = 'used' ORDER BY used_at DESC LIMIT ?`,
      )
      .all(limit) as PromptRow[];
    return rows.map(rowToPrompt);
  }

  /** Distinct threads that still have queued prompts, newest activity first. */
  function listQueuedThreadIds(): string[] {
    const rows = db
      .prepare(
        `SELECT thread_id, MAX(updated_at) AS last FROM prompts
         WHERE scope = 'thread' AND status = 'queued' AND thread_id IS NOT NULL
         GROUP BY thread_id ORDER BY last DESC`,
      )
      .all() as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  /** Distinct projects that still have project-scoped prompts. */
  function listQueuedProjectIds(): string[] {
    const rows = db
      .prepare(
        `SELECT project_id, MAX(updated_at) AS last FROM prompts
         WHERE scope = 'project' AND status = 'queued' AND project_id IS NOT NULL
         GROUP BY project_id ORDER BY last DESC`,
      )
      .all() as { project_id: string }[];
    return rows.map((row) => row.project_id);
  }

  function listRecentlyUsed(
    threadId: string | null,
    projectId: string | null,
    limit: number,
  ): Prompt[] {
    const rows = db
      .prepare(
        `SELECT * FROM prompts
         WHERE status = 'used'
           AND (thread_id IS ? OR (project_id IS NOT NULL AND project_id IS ?) OR scope = 'global')
         ORDER BY used_at DESC LIMIT ?`,
      )
      .all(threadId, projectId, limit) as PromptRow[];
    return rows.map(rowToPrompt);
  }

  function addPrompt(input: {
    text: string;
    scope: Scope;
    threadId?: string | null;
    projectId?: string | null;
    autoSend?: boolean;
    sendAt?: number | null;
    originThreadTitle?: string | null;
  }): Prompt {
    const ref: ScopeRef = {
      scope: input.scope,
      threadId: input.threadId ?? null,
      projectId: input.projectId ?? null,
    };
    if (!isAddressable(ref)) {
      throw new Error(
        input.scope === "thread"
          ? "A thread-scoped prompt needs a threadId."
          : "A project-scoped prompt needs a projectId.",
      );
    }
    if (input.sendAt != null && input.scope !== "thread") {
      throw new Error("Only thread-scoped prompts can be scheduled.");
    }
    const timestamp = now();
    const id = newId("pq");
    db.prepare(
      `INSERT INTO prompts (id, scope, thread_id, project_id, origin_thread_title, text, status, auto_send, send_at, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.scope,
      input.scope === "thread" ? (input.threadId ?? null) : null,
      // A thread-scoped prompt keeps its project so it can be promoted later.
      input.projectId ?? null,
      input.originThreadTitle ?? null,
      input.text,
      input.autoSend && input.scope === "thread" ? 1 : 0,
      input.sendAt ?? null,
      nextPosition(ref),
      timestamp,
      timestamp,
    );
    return getPrompt(id)!;
  }

  /**
   * Move a prompt between scopes. The caller must supply the new owner — the
   * old code inferred it from the row, which silently produced unaddressable
   * `scope='thread', thread_id=NULL` prompts that no list query could see.
   */
  function movePrompt(
    id: string,
    ref: ScopeRef,
    options: { originThreadTitle?: string | null } = {},
  ): Prompt | null {
    const existing = getPrompt(id);
    if (!existing) return null;
    if (!isAddressable(ref)) {
      throw new Error(
        ref.scope === "thread"
          ? "Moving a prompt to a thread needs a threadId."
          : "Moving a prompt to a project needs a projectId.",
      );
    }
    const threadId = ref.scope === "thread" ? (ref.threadId ?? null) : null;
    // Keep the project association when we know it: a thread prompt that later
    // gets promoted, and a project prompt, both point at the same project.
    const projectId =
      ref.scope === "project"
        ? (ref.projectId ?? null)
        : ref.scope === "thread"
          ? (ref.projectId ?? existing.projectId)
          : null;
    db.prepare(
      `UPDATE prompts SET scope = ?, thread_id = ?, project_id = ?, origin_thread_title = ?,
        auto_send = CASE WHEN ? = 'thread' THEN auto_send ELSE 0 END,
        send_at = CASE WHEN ? = 'thread' THEN send_at ELSE NULL END,
        position = ?, updated_at = ? WHERE id = ?`,
    ).run(
      ref.scope,
      threadId,
      projectId,
      options.originThreadTitle === undefined
        ? existing.originThreadTitle
        : options.originThreadTitle,
      ref.scope,
      ref.scope,
      nextPosition(ref),
      now(),
      id,
    );
    return getPrompt(id);
  }

  /**
   * Everything a thread still owns, re-homed on its project (or global when
   * the project is unknown). This is what keeps a queue alive past the thread
   * that produced it. Returns the prompts as they now stand.
   */
  function promoteThreadPrompts(
    threadId: string,
    options: { projectId?: string | null; threadTitle?: string | null } = {},
  ): Prompt[] {
    const owned = listQueued({ scope: "thread", threadId });
    if (owned.length === 0) return [];
    const projectId = options.projectId ?? owned[0]!.projectId ?? null;
    const target: ScopeRef =
      projectId === null ? { scope: "global" } : { scope: "project", projectId };
    const promoted: Prompt[] = [];
    const apply = db.transaction(() => {
      for (const prompt of owned) {
        const moved = movePrompt(prompt.id, target, {
          originThreadTitle: options.threadTitle ?? prompt.originThreadTitle ?? null,
        });
        if (moved) promoted.push(moved);
      }
    });
    apply();
    return promoted;
  }

  function deleteThreadPrompts(threadId: string): number {
    return db
      .prepare(`DELETE FROM prompts WHERE thread_id = ? AND status = 'queued'`)
      .run(threadId).changes;
  }

  function deletePrompt(id: string): boolean {
    return db.prepare(`DELETE FROM prompts WHERE id = ?`).run(id).changes === 1;
  }

  function updatePromptFields(
    id: string,
    fields: { text?: string; autoSend?: boolean; sendAt?: number | null },
  ): Prompt | null {
    const existing = getPrompt(id);
    if (!existing) return null;
    // Arming and scheduling are thread-only capabilities; a project or global
    // prompt has no idle event to hang them off.
    const autoSend =
      existing.scope === "thread" ? (fields.autoSend ?? existing.autoSend) : false;
    const sendAt =
      existing.scope === "thread"
        ? fields.sendAt === undefined
          ? existing.sendAt
          : fields.sendAt
        : null;
    db.prepare(
      `UPDATE prompts SET text = ?, auto_send = ?, send_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(fields.text ?? existing.text, autoSend ? 1 : 0, sendAt, now(), id);
    return getPrompt(id);
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
    const ref: ScopeRef = {
      scope: existing.scope,
      threadId: existing.threadId,
      projectId: existing.projectId,
    };
    db.prepare(
      `UPDATE prompts SET status = 'queued', used_at = NULL, used_via = NULL,
       send_at = NULL, last_error = ?, position = ?, updated_at = ? WHERE id = ?`,
    ).run(error ?? null, nextPosition(ref), now(), id);
    return getPrompt(id);
  }

  function reorderPrompts(ref: ScopeRef, ids: string[]): boolean {
    const current = listQueued(ref);
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
         WHERE thread_id = ? AND scope = 'thread' AND status = 'queued' AND auto_send = 1
         ORDER BY position ASC, created_at ASC LIMIT 1`,
      )
      .get(threadId) as PromptRow | undefined;
    return row ? rowToPrompt(row) : null;
  }

  function countQueued(threadId: string): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM prompts
         WHERE thread_id = ? AND scope = 'thread' AND status = 'queued'`,
      )
      .get(threadId) as { n: number };
    return row.n;
  }

  function setArmedForThread(threadId: string, armed: boolean): number {
    return db
      .prepare(
        `UPDATE prompts SET auto_send = ?, updated_at = ?
         WHERE thread_id = ? AND scope = 'thread' AND status = 'queued' AND auto_send = ?`,
      )
      .run(armed ? 1 : 0, now(), threadId, armed ? 0 : 1).changes;
  }

  // ---- Thread state (pause) ----

  function isPaused(threadId: string): boolean {
    const row = db
      .prepare(`SELECT paused FROM thread_state WHERE thread_id = ?`)
      .get(threadId) as { paused: number } | undefined;
    return row?.paused === 1;
  }

  function setPaused(threadId: string, paused: boolean): void {
    if (!paused) {
      db.prepare(`DELETE FROM thread_state WHERE thread_id = ?`).run(threadId);
      return;
    }
    db.prepare(
      `INSERT INTO thread_state (thread_id, paused, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(thread_id) DO UPDATE SET paused = 1, updated_at = excluded.updated_at`,
    ).run(threadId, now());
  }

  function pausedThreadIds(): string[] {
    return (
      db.prepare(`SELECT thread_id FROM thread_state WHERE paused = 1`).all() as {
        thread_id: string;
      }[]
    ).map((row) => row.thread_id);
  }

  function forgetThread(threadId: string): void {
    db.prepare(`DELETE FROM thread_state WHERE thread_id = ?`).run(threadId);
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

  /**
   * Snippets matching `query`, project-visible first. A project's library is
   * its own plus everything unscoped; passing no project shows everything.
   */
  function listSnippets(
    query: string,
    options: { projectId?: string | null; limit?: number } = {},
  ): { snippets: Snippet[]; total: number } {
    const limit = options.limit ?? SNIPPET_LIST_LIMIT;
    const scoped = options.projectId != null;
    const scopeSql = scoped
      ? `(s.project_id IS NULL OR s.project_id = ?)`
      : `1 = 1`;
    const scopeParams = scoped ? [options.projectId] : [];
    const trimmed = query.trim();
    const searchSql = trimmed
      ? `AND (s.title LIKE ? OR s.keywords LIKE ? OR s.body LIKE ? OR g.name LIKE ?)`
      : "";
    const like = `%${trimmed.replace(/[%_]/g, "")}%`;
    const searchParams = trimmed ? [like, like, like, like] : [];
    const params = [...scopeParams, ...searchParams];
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM snippets s
           LEFT JOIN snippet_groups g ON g.id = s.group_id
           WHERE ${scopeSql} ${searchSql}`,
        )
        .get(...params) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `${SNIPPET_SELECT}
         WHERE ${scopeSql} ${searchSql}
         ORDER BY s.use_count DESC, s.updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as SnippetRow[];
    return { snippets: rows.map(rowToSnippet), total };
  }

  /** A named group's snippets in the order they were written — playbook order. */
  function listGroupSnippets(groupName: string): Snippet[] {
    const rows = db
      .prepare(
        `${SNIPPET_SELECT} WHERE g.name = ? ORDER BY s.created_at ASC`,
      )
      .all(groupName) as SnippetRow[];
    return rows.map(rowToSnippet);
  }

  function addSnippet(input: {
    title: string;
    body: string;
    description?: string;
    keywords?: string;
    groupName?: string | null;
    projectId?: string | null;
  }): Snippet {
    const id = newId("snip");
    const timestamp = now();
    db.prepare(
      `INSERT INTO snippets (id, title, body, description, keywords, group_id, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.body,
      input.description ?? "",
      input.keywords ?? "",
      ensureGroup(input.groupName ?? null),
      input.projectId ?? null,
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
    projectId?: string | null;
  }): Snippet | null {
    const existing = getSnippet(input.id);
    if (!existing) return null;
    const groupId =
      input.groupName === undefined
        ? existing.groupId
        : ensureGroup(input.groupName);
    db.prepare(
      `UPDATE snippets SET title = ?, body = ?, description = ?, keywords = ?, group_id = ?, project_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title ?? existing.title,
      input.body ?? existing.body,
      input.description ?? existing.description,
      input.keywords ?? existing.keywords,
      groupId,
      input.projectId === undefined ? existing.projectId : input.projectId,
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

  function listDismissedSuggestions(): string[] {
    return (
      db.prepare(`SELECT key FROM dismissed_suggestions`).all() as { key: string }[]
    ).map((row) => row.key);
  }

  function dismissSuggestion(key: string, body: string): void {
    db.prepare(
      `INSERT INTO dismissed_suggestions (key, body, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(key, body, now());
  }

  function countDismissedSuggestions(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS total FROM dismissed_suggestions`)
      .get() as { total: number };
    return row.total;
  }

  function clearDismissedSuggestions(): number {
    return db.prepare(`DELETE FROM dismissed_suggestions`).run().changes;
  }

  // ---- Remembered fill-in values ----

  function rememberFillValues(values: Record<string, string>): void {
    const timestamp = now();
    const apply = db.transaction(() => {
      for (const [token, value] of Object.entries(values)) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        db.prepare(
          `INSERT INTO fill_values (token, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(token.toLowerCase(), trimmed.slice(0, 500), timestamp);
      }
    });
    apply();
  }

  function fillValuesFor(tokens: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const token of tokens) {
      const row = db
        .prepare(`SELECT value FROM fill_values WHERE token = ?`)
        .get(token.toLowerCase()) as { value: string } | undefined;
      if (row) out[token] = row.value;
    }
    return out;
  }

  return {
    nextPosition,
    getPrompt,
    listQueued,
    listRecentlyUsed,
    listAllUsed,
    listQueuedThreadIds,
    listQueuedProjectIds,
    addPrompt,
    movePrompt,
    promoteThreadPrompts,
    deleteThreadPrompts,
    deletePrompt,
    updatePromptFields,
    claimPrompt,
    requeuePrompt,
    reorderPrompts,
    pruneUsed,
    listDue,
    nextArmed,
    countQueued,
    setArmedForThread,
    isPaused,
    setPaused,
    pausedThreadIds,
    forgetThread,
    getSnippet,
    listSnippets,
    listGroupSnippets,
    addSnippet,
    updateSnippet,
    deleteSnippet,
    touchSnippet,
    listDismissedSuggestions,
    dismissSuggestion,
    countDismissedSuggestions,
    clearDismissedSuggestions,
    rememberFillValues,
    fillValuesFor,
  };
}

export type Store = ReturnType<typeof createStore>;
