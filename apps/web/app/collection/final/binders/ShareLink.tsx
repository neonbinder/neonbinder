import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { LinkIcon } from "@heroicons/react/24/outline";
import { useCollectionMode } from "../mode";
import { shareUrl, type ShareTarget } from "./model";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { useSharing, writeErrorMessage, type SharingExtension } from "../data/store";
import { SLUG_RULE, binderHref, cleanSlug, shelfHref } from "@/lib/collection/share-links";

/**
 * "Share": the open view's public link. What it shares comes in as data (see
 * `openView.ts`). Two panels behind one button:
 *
 *   - The demo (no `useSharing()`): an example link at the neutral handle
 *     (`neonbinder.io/u/you/binders/ohtani-rainbow`), copied on open, and a
 *     line saying it is an example.
 *   - The real collection (NEO-360): the collector's own link, a Private /
 *     Public choice, and for a binder its editable link name. A binder and
 *     the Want List start private; Up for Trade starts public. With no
 *     public name yet, the panel links to the profile.
 */
export default function ShareLink({ target }: { target: ShareTarget }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sharing = useSharing();
  const live = !!sharing && target.subject.kind !== "set";
  // The demo's example copies as the panel opens, as it always has.
  const [copied, setCopied] = useState<boolean | null>(null);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const { what } = target;

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
      {/* Pink outline at rest, lit pink while the panel is open. */}
      <NeonButton
        ref={buttonRef}
        type="button"
        variant="negative"
        outline={!open}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Share ${what}`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          setCopied(null);
          if (next && !live) void copyText(`https://${shareUrl(target)}`).then(setCopied);
        }}
        className="min-h-10"
      >
        <LinkIcon aria-hidden="true" className="h-4 w-4" />
        Share
      </NeonButton>
      {/* A phone pins the panel to the bottom of the screen: anchored to the
          button it could run off the left edge when the toolbar wraps. */}
      <div
        id={panelId}
        hidden={!open}
        className="fixed inset-x-4 bottom-4 z-40 max-h-[calc(100dvh-2rem)] overflow-y-auto sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-[min(22rem,calc(100vw-2rem))] sm:overflow-visible rounded-xl border border-neon-pink/60 bg-sheet p-3 text-sm shadow-2xl shadow-offset"
      >
        <p className="font-semibold text-ink">Share {what}</p>
        {open &&
          (sharing && live ? (
            <LivePanel target={target} sharing={sharing} onDone={close} />
          ) : (
            <ExamplePanel target={target} copied={copied} setCopied={setCopied} onDone={close} />
          ))}
      </div>
    </div>
  );
}

/** Copies `text`, answering whether the clipboard took it. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard (blocked, insecure origin, old browser): show it to copy by hand.
    return false;
  }
}

function copiedLine(copied: boolean | null): string {
  if (copied === true) return "Copied! Paste it anywhere.";
  if (copied === false) return "Couldn't reach your clipboard. Copy the link above by hand.";
  return "";
}

function DoneButton({ onDone }: { onDone: () => void }) {
  return (
    <button
      type="button"
      onClick={onDone}
      className="min-h-9 rounded-md px-3 text-sm text-ink-2 underline underline-offset-4 hover:text-ink focus-outline"
    >
      Done
    </button>
  );
}

function LinkBox({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 break-all rounded-md bg-field px-2 py-1.5 font-medium text-neon-blue-text">{children}</p>
  );
}

/** The demo's example: no page exists, so the handle is anyone's and the panel says so. */
function ExamplePanel({
  target,
  copied,
  setCopied,
  onDone,
}: {
  target: ShareTarget;
  copied: boolean | null;
  setCopied: (copied: boolean) => void;
  onDone: () => void;
}) {
  const { mode } = useCollectionMode();
  const link = shareUrl(target);
  const copy = async () => setCopied(await copyText(`https://${link}`));
  return (
    <>
      <LinkBox>{link}</LinkBox>
      <p role="status" className="mt-2 text-ink-2">
        {copiedLine(copied)}
      </p>
      <p className="mt-1 text-ink-2">
        {mode === "public"
          ? "Just an example: demo binders don't get a real page."
          : "Just an example: share links arrive when your real collection does."}
      </p>
      <div className="mt-2 flex gap-2">
        <NeonButton type="button" variant="negative" onClick={() => void copy()} className="min-h-9">
          Copy link
        </NeonButton>
        <DoneButton onDone={onDone} />
      </div>
    </>
  );
}

/** One of the Private / Public choices: a card with its radio. */
const CHOICE =
  "flex cursor-pointer items-start gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus has-[:disabled]:cursor-default";

/** The site's own origin, so a preview's link points at that preview. */
function origin(): string {
  return typeof window === "undefined" ? "https://neonbinder.io" : window.location.origin;
}

/** The real link, its switch, and for a binder the readable part and Reset link. */
function LivePanel({
  target,
  sharing,
  onDone,
}: {
  target: ShareTarget;
  sharing: SharingExtension;
  onDone: () => void;
}) {
  const profile = sharing.useShareProfile();
  const { subject } = target;
  const container = subject.kind === "binder" || subject.kind === "want" ? subject.container : null;
  const [copied, setCopied] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [flipping, setFlipping] = useState<boolean | null>(null);
  const radioName = useId();

  // A binder made before share links gets its link minted the first time Share opens.
  const needsLink = subject.kind === "binder" && !subject.container.slug;
  const minting = useRef(false);
  useEffect(() => {
    if (!needsLink || minting.current || !container) return;
    minting.current = true;
    sharing.ensureLink(container).catch((e: unknown) => setError(writeErrorMessage(e)));
  }, [needsLink, container, sharing]);

  if (profile === undefined) {
    return <p className="mt-2 text-ink-2">Loading your link…</p>;
  }
  if (profile.username === null) {
    return (
      <>
        <p className="mt-2 text-ink-2">
          Your collection needs a public name before anything can be shared. Your links use it.
        </p>
        <div className="mt-2 flex gap-2">
          <Link
            to="/profile"
            className="inline-flex min-h-9 items-center rounded-md px-3 text-sm font-semibold text-neon-blue-text underline underline-offset-4 focus-outline"
          >
            Pick a public name
          </Link>
          <DoneButton onDone={onDone} />
        </div>
      </>
    );
  }

  const username = profile.username;
  const path =
    subject.kind === "binder"
      ? subject.container.slug
        ? binderHref(username, subject.container.slug)
        : null
      : subject.kind === "want"
        ? shelfHref(username, "want-list")
        : shelfHref(username, "up-for-trade");
  const url = path ? `${origin()}${path}` : null;
  // The choice moves on the press; the server's answer settles it (a refusal puts it back).
  const isPublic = flipping ?? (subject.kind === "trade" ? profile.tradePublic : !!container?.isPublic);

  const run = async (write: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await write();
    } catch (e) {
      setError(writeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const flip = (next: boolean) => {
    setFlipping(next);
    return run(() =>
      subject.kind === "trade"
        ? sharing.setShelfVisibility("trade", next)
        : container
          ? sharing.setVisibility(container, next)
          : Promise.resolve(),
    ).finally(() => setFlipping(null));
  };

  const noun = subject.kind === "binder" ? "binder" : subject.kind === "want" ? "Want List" : "shelf";
  return (
    <>
      <fieldset className="mt-2" disabled={busy || !url}>
        <legend className="text-sm font-medium text-ink-2">Who can see this {noun}</legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(
            [
              { value: false, title: "Private", hint: "Only you" },
              { value: true, title: "Public", hint: "Anyone with the link" },
            ] as const
          ).map((option) => (
            <label key={option.title} className={CHOICE}>
              <input
                type="radio"
                name={`${radioName}-visibility`}
                className="mt-0.5 accent-selection"
                checked={isPublic === option.value}
                onChange={() => void flip(option.value)}
              />
              <span>
                <span className="block font-semibold">{option.title}</span>
                <span className="block text-xs text-ink-2">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-2 text-ink-2">
        {isPublic
          ? `Visitors see the cards, their condition and grade. Never what you paid, your notes or where a card is kept.`
          : `Nobody else can open the link below until you pick Public.`}
      </p>
      {url ? <LinkBox>{url}</LinkBox> : <p className="mt-2 text-ink-2">Making your link…</p>}
      {subject.kind === "binder" && subject.container.slug && (
        <SlugEditor
          key={subject.container.slug}
          slug={subject.container.slug}
          busy={busy}
          onSave={(slug) => run(() => sharing.setSlug(subject.container, slug))}
        />
      )}
      <p role="status" className="mt-2 text-ink-2">
        {error || copiedLine(copied)}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <NeonButton
          type="button"
          variant="negative"
          disabled={!url}
          onClick={() => url && void copyText(url).then(setCopied)}
          className="min-h-9"
        >
          Copy link
        </NeonButton>
        <DoneButton onDone={onDone} />
      </div>
    </>
  );
}

/** The readable part of a binder's link, editable. Enter saves; the old link stops working. */
function SlugEditor({ slug, busy, onSave }: { slug: string; busy: boolean; onSave: (slug: string) => Promise<void> }) {
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState(slug);
  const cleaned = cleanSlug(text);
  const changed = cleaned !== null && cleaned !== slug;
  return (
    <form
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) void onSave(text);
      }}
    >
      <label htmlFor={inputId} className="block text-sm font-medium text-ink-2">
        Link name
      </label>
      <div className="mt-1 flex gap-2">
        <Input
          bare
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby={hintId}
          aria-invalid={cleaned === null}
          autoComplete="off"
          spellCheck={false}
          className="min-h-9 w-full min-w-0 rounded-md border border-field-rule bg-field px-2 text-sm text-ink focus-outline"
        />
        <NeonButton type="submit" variant="secondary" outline disabled={!changed || busy} className="min-h-9">
          Save
        </NeonButton>
      </div>
      <p id={hintId} className="mt-1 text-xs text-ink-3">
        {cleaned === null ? SLUG_RULE : "Renaming the binder never changes its link. Saving a new link name stops the old link."}
      </p>
    </form>
  );
}
