// The shared behaviour behind a prompt row's menu, so the popover and the
// manager cannot disagree about what "delete" or "keep for this project" does.
import { toast } from "sonner";
import { SCOPE_LABEL, type PromptDto, type Rpc, type Scope } from "./shared";

export interface PromptActionDeps {
  rpc: Rpc;
  refresh: () => void;
  /** The surface's own scope, for scope moves and target filtering. */
  threadId: string | null;
  projectId: string | null;
  onEdit: (prompt: PromptDto) => void;
  onSchedule: (prompt: PromptDto) => void;
  onSaveAsSnippet: (prompt: PromptDto) => void;
}

export function createPromptActions(deps: PromptActionDeps) {
  const { rpc, refresh, threadId, projectId } = deps;

  async function remove(prompt: PromptDto): Promise<void> {
    const { deleted } = await rpc.call("deletePrompt", { id: prompt.id });
    if (!deleted) return;
    refresh();
    toast("Prompt deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          void rpc
            .call("addPrompt", {
              text: prompt.text,
              scope: prompt.scope,
              threadId: prompt.threadId,
              projectId: prompt.projectId,
              autoSend: prompt.autoSend,
            })
            .then(refresh),
      },
    });
  }

  async function toggleArm(prompt: PromptDto): Promise<void> {
    await rpc.call("updatePrompt", {
      id: prompt.id,
      autoSend: !prompt.autoSend,
    });
    refresh();
  }

  /**
   * Scope moves name their destination explicitly. Inferring it from the row
   * is what once produced thread-scoped prompts with no thread — invisible
   * everywhere, still in the database.
   */
  async function changeScope(prompt: PromptDto, scope: Scope): Promise<void> {
    const target = {
      scope,
      threadId: scope === "thread" ? threadId : null,
      projectId:
        scope === "project" ? (projectId ?? prompt.projectId) : prompt.projectId,
    };
    if (scope === "thread" && target.threadId === null) {
      toast.error("Open a thread to move a prompt into it");
      return;
    }
    if (scope === "project" && target.projectId === null) {
      toast.error("No project here to keep this prompt for");
      return;
    }
    const { error } = await rpc.call("movePrompt", { id: prompt.id, ...target });
    refresh();
    if (error) toast.error(error);
    else
      toast.success(
        scope === "project"
          ? "Kept for this project — it survives the thread"
          : `Moved to ${SCOPE_LABEL[scope]}`,
      );
  }

  async function sendToThread(
    prompt: PromptDto,
    targetThreadId: string,
  ): Promise<void> {
    const { sent, error } = await rpc.call("sendPromptToThread", {
      id: prompt.id,
      threadId: targetThreadId,
    });
    refresh();
    if (sent) toast.success("Prompt sent");
    else toast.error(error ?? "Send failed");
  }

  async function loadTargets(): Promise<{
    threads: { id: string; title: string }[];
    total: number;
  }> {
    try {
      const { threads, total } = await rpc.call("listTargets", {
        excludeThreadId: threadId,
      });
      return { threads, total };
    } catch {
      return { threads: [], total: 0 };
    }
  }

  async function restore(prompt: PromptDto): Promise<void> {
    await rpc.call("restorePrompt", { id: prompt.id });
    refresh();
    toast.success("Restored to queue");
  }

  return {
    remove,
    toggleArm,
    changeScope,
    sendToThread,
    loadTargets,
    restore,
    onEdit: deps.onEdit,
    onSchedule: deps.onSchedule,
    onSaveAsSnippet: deps.onSaveAsSnippet,
  };
}

/**
 * Reordering rejects cleanly when the list moved under the user (another
 * surface added a prompt, an armed one drained). The old code dropped that on
 * the floor and left the rows where the drag put them.
 */
export function createReorder(rpc: Rpc, refresh: () => void) {
  return async function reorder(
    ref: { scope: Scope; threadId: string | null; projectId: string | null },
    ids: string[],
  ): Promise<void> {
    const { reordered } = await rpc.call("reorderPrompts", { ...ref, ids });
    refresh();
    if (!reordered)
      toast("The queue changed while you were reordering — refreshed");
  };
}
