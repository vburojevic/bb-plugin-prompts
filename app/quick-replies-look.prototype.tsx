// PROTOTYPE, throwaway (branch prototype/quick-replies-look, never main).
// Question: what should the quick-reply row look like, with no solid white
// "best" chip? Five looks of the same row, switched with ?qr-look=A..E on the
// thread URL or the bar pinned at the top of the window (arrow keys cycle).

import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type LookKey = "A" | "B" | "C" | "D" | "E";

export interface Look {
  key: LookKey;
  name: string;
  /** Around the chips and regenerate. */
  bar: string;
  chip: string;
  best: string;
  normal: string;
  primary: string;
  /** A chip whose details are open. */
  open: string;
  icon: string;
  iconBest: string;
  /** Show a dot between chips. */
  dots: boolean;
  /** Every chip leads with its number instead of its icon. */
  numbers: boolean;
  /** A leading "Suggested" label inside the bar. */
  label: boolean;
}

export const LOOKS: Look[] = [
  {
    key: "A",
    name: "Quiet outline",
    bar: "",
    chip: "rounded-full border px-2.5",
    best: "border-foreground/30 text-foreground hover:bg-state-hover",
    normal: "border-border text-foreground/75 hover:bg-state-hover hover:text-foreground",
    primary: "border-foreground/30 text-foreground hover:bg-state-hover",
    open: "bg-state-hover text-foreground",
    icon: "text-muted-foreground",
    iconBest: "text-foreground",
    dots: false,
    numbers: false,
    label: false,
  },
  {
    key: "B",
    name: "Soft fill",
    bar: "",
    chip: "rounded-full px-2.5",
    best: "bg-state-active text-foreground hover:bg-state-active",
    normal: "bg-state-hover text-foreground/80 hover:bg-state-active hover:text-foreground",
    primary: "bg-state-active text-foreground",
    open: "bg-state-active text-foreground",
    icon: "text-muted-foreground",
    iconBest: "text-foreground",
    dots: false,
    numbers: false,
    label: false,
  },
  {
    key: "C",
    name: "Ghost links",
    bar: "",
    chip: "rounded-md px-1.5",
    best: "text-foreground hover:bg-state-hover",
    normal: "text-muted-foreground hover:bg-state-hover hover:text-foreground",
    primary: "text-foreground hover:bg-state-hover",
    open: "bg-state-hover text-foreground",
    icon: "opacity-70",
    iconBest: "",
    dots: true,
    numbers: false,
    label: false,
  },
  {
    key: "D",
    name: "Tray",
    bar: "rounded-full border border-border bg-secondary/60 py-0.5 pl-3 pr-0.5",
    chip: "rounded-full px-2.5",
    best: "text-foreground hover:bg-state-hover",
    normal: "text-foreground/70 hover:bg-state-hover hover:text-foreground",
    primary: "text-foreground hover:bg-state-hover",
    open: "bg-state-hover text-foreground",
    icon: "text-muted-foreground",
    iconBest: "text-foreground",
    dots: false,
    numbers: false,
    label: true,
  },
  {
    key: "E",
    name: "Numbered keys",
    bar: "",
    chip: "rounded-lg border border-border px-1.5 pr-2.5",
    best: "text-foreground hover:bg-state-hover",
    normal: "text-foreground/75 hover:bg-state-hover hover:text-foreground",
    primary: "text-foreground hover:bg-state-hover",
    open: "bg-state-hover text-foreground",
    icon: "text-muted-foreground",
    iconBest: "text-foreground",
    dots: false,
    numbers: true,
    label: false,
  },
];

const STORE = "bb-prompts:qr-look";

function initialLook(): LookKey | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("qr-look")?.toUpperCase();
  const pick = fromUrl ?? window.localStorage.getItem(STORE);
  return LOOKS.some((look) => look.key === pick) ? (pick as LookKey) : null;
}

/** The look on screen; null outside the prototype (the shipped row). */
export function useLook(): Look | null {
  const [key, setKey] = useState<LookKey | null>(initialLook);
  useEffect(() => {
    const sync = () => setKey(initialLook());
    window.addEventListener("bb-prompts:qr-look", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("bb-prompts:qr-look", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return LOOKS.find((look) => look.key === key) ?? null;
}

function setLook(key: LookKey) {
  window.localStorage.setItem(STORE, key);
  const url = new URL(window.location.href);
  if (url.searchParams.has("qr-look")) {
    url.searchParams.set("qr-look", key);
    window.history.replaceState(window.history.state, "", url);
  }
  window.dispatchEvent(new Event("bb-prompts:qr-look"));
}

/** The prototype's switcher: pinned top center, clearly not part of the design. */
export function LookSwitcher({ look }: { look: Look }) {
  const index = LOOKS.indexOf(look);
  const step = (by: number) => setLook(LOOKS[(index + by + LOOKS.length) % LOOKS.length]!.key);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 10,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2147483647,
        background: "#ff2d55",
        color: "#fff",
        boxShadow: "0 4px 16px rgb(0 0 0 / 0.35)",
      }}
      className="flex items-center gap-1 rounded-full px-1 py-1 text-xs font-semibold"
    >
      <button type="button" onClick={() => step(-1)} className="rounded-full px-2 py-0.5 hover:bg-white/20" aria-label="Previous look">
        ←
      </button>
      <span className="px-1">
        Prototype {look.key} · {look.name}
      </span>
      <button type="button" onClick={() => step(1)} className="rounded-full px-2 py-0.5 hover:bg-white/20" aria-label="Next look">
        →
      </button>
    </div>,
    document.body,
  );
}

export { Fragment };
