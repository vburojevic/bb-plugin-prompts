// The four dialogs: fill in a template, schedule a send, edit a prompt, edit a
// snippet. Every surface shares these — they used to exist twice.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { fillTokens, parseTokens } from "../lib/template";
import {
  formatRelative,
  formatWhen,
  previewText,
  type PromptDto,
  type Rpc,
} from "./shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Fill-in dialog for {{token}} templates
// ---------------------------------------------------------------------------

export interface FillInRequest {
  text: string;
  title: string;
  /** Receives the filled text; the dialog closes either way. */
  complete: (filled: string) => void;
}

export function FillInDialog({
  request,
  rpc,
  onDone,
  onCancel,
}: {
  request: FillInRequest | null;
  rpc: Rpc;
  onDone: (filled: string) => void;
  onCancel: () => void;
}) {
  const tokens = useMemo(
    () => (request ? parseTokens(request.text) : []),
    [request],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [showPreview, setShowPreview] = useState(false);
  const firstField = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();

  // Seed from the template's own defaults, then from what the user typed for
  // the same token last time — a branch name is rarely different twice.
  useEffect(() => {
    if (request === null) return;
    const seeded: Record<string, string> = {};
    for (const token of tokens) seeded[token.name] = token.defaultValue;
    setValues(seeded);
    setShowPreview(false);
    const names = tokens.map((token) => token.name);
    if (names.length === 0) return;
    void rpc
      .call("fillValues", { tokens: names })
      .then(({ values: remembered }) => {
        setValues((current) => {
          const next = { ...current };
          for (const [name, value] of Object.entries(remembered))
            if (!next[name]) next[name] = value;
          return next;
        });
      })
      .catch(() => {
        // Remembered values are a convenience, never a blocker.
      });
  }, [request, tokens, rpc]);

  useEffect(() => {
    if (request === null) return;
    const timer = setTimeout(() => {
      firstField.current?.focus();
      firstField.current?.select();
    }, 40);
    return () => clearTimeout(timer);
  }, [request]);

  if (request === null) return null;

  const filled = fillTokens(request.text, values);

  function submit(): void {
    const remembered = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim().length > 0),
    );
    if (Object.keys(remembered).length > 0)
      void rpc.call("rememberFillValues", { values: remembered }).catch(() => {});
    onDone(filled);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="truncate">
            Fill in “{request.title}”
          </DialogTitle>
        </DialogHeader>
        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        >
          {tokens.map((token, index) => (
            <div key={token.name} className="space-y-1">
              <label
                htmlFor={`${fieldId}-${index}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {token.name}
              </label>
              <Input
                id={`${fieldId}-${index}`}
                ref={index === 0 ? firstField : undefined}
                value={values[token.name] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [token.name]: event.target.value,
                  }))
                }
                placeholder={token.defaultValue || token.name}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowPreview((current) => !current)}
          aria-expanded={showPreview}
        >
          <Icon
            name={showPreview ? "ChevronDown" : "ChevronRight"}
            className="size-3"
            aria-hidden
          />
          {showPreview ? "Hide" : "Preview"} the filled prompt
        </button>
        {showPreview ? (
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs animate-in fade-in-0">
            {filled}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={submit}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Schedule dialog
// ---------------------------------------------------------------------------

export function toLocalInputValue(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

const QUICK_PICKS: { label: string; at: (now: number) => number }[] = [
  { label: "in 15m", at: (now) => now + 15 * 60_000 },
  { label: "in 1h", at: (now) => now + 3_600_000 },
  { label: "in 3h", at: (now) => now + 3 * 3_600_000 },
  {
    label: "tomorrow 9am",
    at: (now) => {
      const date = new Date(now);
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date.getTime();
    },
  },
];

interface ScheduleState {
  parsed: number;
  valid: boolean;
  inPast: boolean;
}

function readSchedule(value: string): ScheduleState {
  const parsed = new Date(value).getTime();
  const valid = !Number.isNaN(parsed);
  return { parsed, valid, inPast: valid && parsed <= Date.now() };
}

/**
 * Quick picks, an exact time, and a plain-language consequence. Shared by
 * scheduling a queued prompt and by choosing a time while queueing one.
 */
function ScheduleFields({
  value,
  onChange,
  state,
}: {
  value: string;
  onChange: (next: string) => void;
  state: ScheduleState;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_PICKS.map((pick) => (
          <Button
            key={pick.label}
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => onChange(toLocalInputValue(pick.at(Date.now())))}
          >
            {pick.label}
          </Button>
        ))}
      </div>
      <Input
        type="datetime-local"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={state.inPast || !state.valid}
      />
      <p
        className={cn(
          "text-xs",
          state.inPast || !state.valid
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {!state.valid
          ? "Pick a date and time."
          : state.inPast
            ? "That time has passed — pick a later one."
            : `Sends ${formatRelative(state.parsed)}, even if the agent is busy (the message queues on the thread). Pausing auto-send does not block a scheduled send.`}
      </p>
    </>
  );
}

/** Set or clear the send time of a prompt already in the queue. */
export function ScheduleDialog({
  prompt,
  rpc,
  refresh,
  onClose,
}: {
  prompt: PromptDto | null;
  rpc: Rpc;
  refresh: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (prompt)
      setValue(toLocalInputValue(prompt.sendAt ?? Date.now() + 3_600_000));
  }, [prompt]);
  if (prompt === null) return null;

  const state = readSchedule(value);

  async function save(clear: boolean): Promise<void> {
    const sendAt = clear ? null : state.parsed;
    if (!clear && (!state.valid || state.inPast)) return;
    await rpc.call("updatePrompt", { id: prompt!.id, sendAt });
    refresh();
    onClose();
    toast.success(clear ? "Schedule cleared" : `Will send ${formatWhen(sendAt!)}`);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule prompt</DialogTitle>
        </DialogHeader>
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {previewText(prompt.text)}
        </p>
        <ScheduleFields value={value} onChange={setValue} state={state} />
        <DialogFooter>
          {prompt.sendAt !== null ? (
            <Button variant="outline" onClick={() => void save(true)}>
              Clear schedule
            </Button>
          ) : null}
          <Button
            disabled={!state.valid || state.inPast}
            onClick={() => void save(false)}
          >
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pick a time for something not queued yet — the "send later" half of
 * queueing. Resolves to a timestamp; the caller does the queueing.
 */
export function ScheduleAtDialog({
  request,
  onPick,
  onCancel,
}: {
  request: { title: string; detail?: string; initial?: number | null } | null;
  onPick: (sendAt: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (request)
      setValue(toLocalInputValue(request.initial ?? Date.now() + 3_600_000));
  }, [request]);
  if (request === null) return null;

  const state = readSchedule(value);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="truncate">{request.title}</DialogTitle>
        </DialogHeader>
        {request.detail ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {request.detail}
          </p>
        ) : null}
        <ScheduleFields value={value} onChange={setValue} state={state} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!state.valid || state.inPast}
            onClick={() => onPick(state.parsed)}
          >
            Queue for then
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Prompt editor
// ---------------------------------------------------------------------------

export function PromptEditor({
  prompt,
  rpc,
  refresh,
  onClose,
}: {
  prompt: PromptDto | null;
  rpc: Rpc;
  refresh: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => setText(prompt?.text ?? ""), [prompt]);

  async function save(): Promise<void> {
    if (prompt === null || !text.trim()) return;
    await rpc.call("updatePrompt", { id: prompt.id, text: text.trim() });
    refresh();
    onClose();
  }

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit prompt</DialogTitle>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
          className="min-h-32"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!text.trim()} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Snippet editor
// ---------------------------------------------------------------------------

export interface SnippetDraft {
  id: string | null;
  title: string;
  body: string;
  keywords: string;
  groupName: string;
  /** null = shared library; a project id = only that project's threads. */
  projectId: string | null;
}

export function SnippetEditor({
  draft,
  rpc,
  projectId,
  onSaved,
  onClose,
}: {
  draft: SnippetDraft | null;
  rpc: Rpc;
  /** The project this surface belongs to, offered as the scope choice. */
  projectId: string | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SnippetDraft | null>(draft);
  useEffect(() => setForm(draft), [draft]);
  if (form === null) return null;

  const tokens = parseTokens(form.body);

  async function save(): Promise<void> {
    const current = form!;
    if (!current.title.trim() || !current.body.trim()) return;
    const payload = {
      title: current.title.trim(),
      body: current.body,
      keywords: current.keywords.trim(),
      groupName: current.groupName.trim() || null,
      projectId: current.projectId,
    };
    if (current.id === null) await rpc.call("addSnippet", payload);
    else await rpc.call("updateSnippet", { id: current.id, ...payload });
    onSaved();
    onClose();
    toast.success(current.id === null ? "Snippet saved" : "Snippet updated");
  }

  const update = (patch: Partial<SnippetDraft>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {form.id === null ? "New snippet" : "Edit snippet"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={form.title}
            onChange={(event) => update({ title: event.target.value })}
            placeholder="Title"
          />
          <Textarea
            value={form.body}
            onChange={(event) => update({ body: event.target.value })}
            placeholder="Body — {{placeholder}} asks for a value, {{env=staging}} pre-fills one"
            className="min-h-32"
          />
          {tokens.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Fill-ins:
              {tokens.map((token) => (
                <span
                  key={token.name}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono"
                >
                  {token.name}
                  {token.defaultValue ? `=${token.defaultValue}` : ""}
                </span>
              ))}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Input
              value={form.keywords}
              onChange={(event) => update({ keywords: event.target.value })}
              placeholder="Keywords"
            />
            <Input
              value={form.groupName}
              onChange={(event) => update({ groupName: event.target.value })}
              placeholder="Group (queue a group as a checklist)"
            />
          </div>
          {projectId !== null ? (
            <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={form.projectId !== null}
                onCheckedChange={(checked) =>
                  update({ projectId: checked === true ? projectId : null })
                }
                aria-label="Limit this snippet to the current project"
              />
              Only show this snippet in the current project
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!form.title.trim() || !form.body.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
