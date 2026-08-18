// bb-plugin-prompts — frontend entry.
//
// Surfaces:
// - Composer actions: a queue pill (badge = pending count) and a snippets
//   pill, each opening a focused popover.
// - Composer plus-menu: "Queue current draft" and "Save draft as snippet".
// - Composer banner: armed/paused state while relevant.
// - Thread panel action: the same view in a side panel tab.
// - Nav panel: the manager, with every queue and the snippet library.
//
// Queue prompts consume on inject (undo restores); snippets never consume.
import { definePluginApp, useBbContext } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { ArmedBanner, QueueButton, SnippetsButton } from "./app/composer";
import { ManagerPanel } from "./app/manager";
import { QueueView } from "./app/queue-view";
import {
  callRpcDirect,
  composerProjectIdFromScope,
  composerThreadIdFromScope,
  previewText,
} from "./app/shared";

/** The side-panel tab: the same view, minus the composer it would insert into. */
function QueuePanel({ threadId }: { threadId: string }) {
  const { projectId } = useBbContext();
  return (
    <QueueView
      threadId={threadId}
      projectId={projectId}
      onInsertText={null}
      listClassName="max-h-none"
    />
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompts",
    actions: [
      { id: "queue", component: QueueButton },
      { id: "snippets", component: SnippetsButton },
    ],
    banners: [{ id: "armed", component: ArmedBanner }],
    plusMenu: [
      {
        id: "queue-draft",
        label: "Queue current draft",
        description: "Save the draft for later and clear the composer",
        icon: "Layers",
        run: ({ composer, view }) => {
          const text = composer.text.trim();
          if (!text) {
            toast("Nothing to queue — the draft is empty");
            return;
          }
          const threadId = composerThreadIdFromScope(view.scope);
          const projectId = composerProjectIdFromScope(view.scope);
          const scope =
            threadId !== null ? "thread" : projectId !== null ? "project" : "global";
          void callRpcDirect("addPrompt", {
            text,
            scope,
            threadId,
            projectId,
            autoSend: false,
          })
            .then(() => {
              composer.clear();
              toast.success(
                scope === "thread"
                  ? "Draft queued for this thread"
                  : scope === "project"
                    ? "Draft queued for this project"
                    : "Draft queued globally",
              );
            })
            .catch((error: unknown) => {
              toast.error(
                error instanceof Error ? error.message : "Failed to queue the draft",
              );
            });
        },
      },
      {
        id: "save-snippet",
        label: "Save draft as snippet",
        description: "Keep the draft as a reusable prompt (does not clear it)",
        icon: "Explore",
        run: ({ composer }) => {
          const text = composer.text.trim();
          if (!text) {
            toast("Nothing to save — the draft is empty");
            return;
          }
          const title = previewText(text).slice(0, 60);
          void callRpcDirect("addSnippet", { title, body: text })
            .then(() => {
              toast.success(
                `Snippet saved: “${title}” — edit it in the Prompts popover`,
              );
            })
            .catch((error: unknown) => {
              toast.error(
                error instanceof Error ? error.message : "Failed to save the snippet",
              );
            });
        },
      },
    ],
  });

  app.slots.threadPanelAction({
    id: "queue",
    title: "Prompts",
    icon: "Layers",
    component: QueuePanel,
  });

  app.slots.navPanel({
    id: "manager",
    title: "Prompts",
    icon: "Layers",
    path: "manager",
    component: ManagerPanel,
  });
});
