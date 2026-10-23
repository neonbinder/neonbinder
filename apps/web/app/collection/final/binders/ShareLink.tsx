import { useId, useRef, useState } from "react";
import { LinkIcon } from "@heroicons/react/24/outline";
import { useCollectionMode } from "../mode";
import { shareUrl, type ShareTarget } from "./model";

/**
 * "Share": the open view's public link, readable by a human
 * (`neonbinder.io/@you/binders/ohtani-rainbow`, `.../@you/want-list`,
 * `.../@you/sets/2000-topps`). What it shares comes in as data (see
 * `openView.ts`). Pressing it shows the link and copies it. Demo: no such
 * page exists yet, so the handle is anyone's (`DEMO_HANDLE`) and the panel
 * says the link is an example, signed in or not.
 */
export default function ShareLink({ target }: { target: ShareTarget }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const { mode } = useCollectionMode();
  const link = shareUrl(target);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const { what } = target;

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
        className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium focus-outline ${
          open
            ? "border-neon-pink bg-neon-pink text-on-neon-pink"
            : "border-control text-ink hover:border-neon-pink"
        }`}
      >
        <LinkIcon aria-hidden="true" className="h-4 w-4" />
        Share
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-neon-pink/60 bg-sheet p-3 text-sm shadow-2xl shadow-offset"
      >
        <p className="font-semibold text-ink">Share {what}</p>
        <p className="mt-2 break-all rounded-md bg-field px-2 py-1.5 font-medium text-neon-blue-text">
          {link}
        </p>
        <p role="status" className="mt-2 text-ink-2">
          {copied === "yes"
            ? "Copied! Paste it anywhere."
            : copied === "no"
              ? "Couldn't reach your clipboard. Copy the link above by hand."
              : ""}
        </p>
        <p className="mt-1 text-ink-2">
          {mode === "public"
            ? "Just an example: demo binders don't get a real page."
            : "Just an example: share links arrive when your real collection does."}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="min-h-9 rounded-md bg-neon-pink px-3 text-sm font-bold text-on-neon-pink hover:bg-neon-pink-hover focus-outline"
          >
            Copy link
          </button>
          <button
            type="button"
            onClick={close}
            className="min-h-9 rounded-md px-3 text-sm text-ink-2 underline underline-offset-4 hover:text-ink focus-outline"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
