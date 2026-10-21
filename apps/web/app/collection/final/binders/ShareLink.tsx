import { useId, useRef, useState } from "react";
import { LinkIcon } from "@heroicons/react/24/outline";
import { useCollectionMode } from "../mode";
import type { CollectionBinder } from "../store";
import { shareLink } from "./model";

/**
 * "Share": a binder's public link, readable by a human
 * (`neonbinder.io/@jason/binders/ohtani-rainbow`, `.../@jason/want-list`).
 * Pressing it shows the link and copies it. Mock: no such page exists yet,
 * and the handle is a stand-in for the collector's own.
 */
export default function ShareLink({ binder }: { binder: CollectionBinder }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const { mode, shareHandle } = useCollectionMode();
  const link = shareLink(binder, shareHandle);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const what = binder.system === "want" ? "your Want List" : binder.name;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`https://${link}`);
      setCopied("yes");
    } catch {
      // No clipboard (blocked, insecure origin, old browser): show it to copy by hand.
      setCopied("no");
    }
  };

  return (
    <div
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Share ${what}`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          setCopied(null);
          if (next) void copy();
        }}
        className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
          open
            ? "border-neon-pink bg-neon-pink text-black"
            : "border-slate-600 text-slate-100 hover:border-neon-pink"
        }`}
      >
        <LinkIcon aria-hidden="true" className="h-4 w-4" />
        Share
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-neon-pink/60 bg-slate-950 p-3 text-sm shadow-2xl"
      >
        <p className="font-semibold text-white">Share {what}</p>
        <p className="mt-2 break-all rounded-md bg-slate-900 px-2 py-1.5 font-medium text-neon-blue">
          {link}
        </p>
        <p role="status" className="mt-2 text-slate-200">
          {copied === "yes"
            ? "Copied! Paste it anywhere."
            : copied === "no"
              ? "Couldn't reach your clipboard. Copy the link above by hand."
              : ""}
        </p>
        <p className="mt-1 text-slate-300">
          {mode === "public"
            ? "Just an example: demo binders don't get a real page."
            : "Anyone with the link can see it. Only you can change it."}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="min-h-9 rounded-md bg-neon-pink px-3 text-sm font-bold text-black hover:bg-[#ff5cb0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Copy link
          </button>
          <button
            type="button"
            onClick={close}
            className="min-h-9 rounded-md px-3 text-sm text-slate-300 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
