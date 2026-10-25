import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type TouchEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import Pocket, { type PocketHandlers, type PocketVariant } from "./Pocket";
import { sameSlot, type PageModel, type SlotRef } from "./model";
import NeonButton from "@/components/modules/NeonButton";

/**
 * The open binder (p2's BinderDesk, copied to use this folder's Pocket):
 * two nine-pocket pages either side of the rings on a wide screen (the
 * inside front cover faces page 1), one page at a time on a phone. Pages turn with the buttons, PageUp / PageDown (wired by the page),
 * or a swipe on a phone; the turn animates unless reduced motion is on.
 */

export const SPREAD_DROP_ID = "spread";

interface BinderDeskProps extends PocketHandlers {
  pages: PageModel[];
  wide: boolean;
  /** Spread index on a wide screen, page index on a phone. */
  at: number;
  onTurn: (to: number) => void;
  vinyl: string;
  cover: ReactNode;
  variant: PocketVariant;
  /** Tag a box copy's pocket "For sale" (the Up for Trade pile only). */
  saleTags?: boolean;
  aimed: SlotRef | null;
  /** The pocket a hunt found, ringed until the binder closes. */
  found?: SlotRef | null;
  /** Accept a drop anywhere on the binder (no real pockets to aim at). */
  wholeBinderDrop: boolean;
  reducedMotion: boolean;
  /** Label for the binder region, e.g. the binder's name. */
  name: string;
  /** Its cards can be dragged or Alt+arrowed to other pockets. */
  rearrange?: boolean;
}

export function stepCount(pageCount: number, wide: boolean): number {
  if (!wide) return Math.max(1, pageCount);
  return 1 + Math.ceil(Math.max(0, pageCount - 1) / 2);
}

/** Which step shows page `p` (0-based). */
export function stepOfPage(p: number, wide: boolean): number {
  return wide ? Math.ceil(p / 2) : p;
}

const BLANK: PageModel = {
  section: null,
  pockets: Array.from({ length: 9 }, () => ({ content: { kind: "empty" as const } })),
};

export default function BinderDesk(props: BinderDeskProps) {
  const { pages, wide, at, onTurn, vinyl, cover, wholeBinderDrop, reducedMotion, name } = props;
  const steps = stepCount(pages.length, wide);
  const step = Math.min(at, steps - 1);

  const { setNodeRef, isOver } = useDroppable({ id: SPREAD_DROP_ID, disabled: !wholeBinderDrop });

  // The page turn. WAAPI on stable nodes, so a pocket that held focus keeps it.
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const lastStep = useRef(step);
  useLayoutEffect(() => {
    const prev = lastStep.current;
    lastStep.current = step;
    if (prev === step || reducedMotion) return;
    const fwd = step > prev;
    const opts: KeyframeAnimationOptions = { duration: 420, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" };
    if (!wide) {
      rightRef.current?.animate(
        [
          { transform: `translateX(${fwd ? 28 : -28}px) rotateY(${fwd ? -14 : 14}deg)`, opacity: 0.2 },
          { transform: "none", opacity: 1 },
        ],
        opts,
      );
      return;
    }
    // Forward: the leaf lands on the left, about the rings. Back: on the right.
    const leaf = fwd ? leftRef.current : rightRef.current;
    const other = fwd ? rightRef.current : leftRef.current;
    leaf?.animate(
      [
        { transform: `rotateY(${fwd ? 100 : -100}deg)`, transformOrigin: fwd ? "right center" : "left center", filter: "brightness(1.8)" },
        { transform: "rotateY(0deg)", transformOrigin: fwd ? "right center" : "left center", filter: "none" },
      ],
      opts,
    );
    other?.animate([{ filter: "brightness(0.45)" }, { filter: "none" }], opts);
  }, [step, wide, reducedMotion]);

  // A swipe turns the page only when it is mostly sideways: a diagonal
  // scroll down the page used to turn it too.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchCancel = () => {
    touchStart.current = null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    const end = e.changedTouches[0];
    if (start === null || end === undefined) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && step < steps - 1) onTurn(step + 1);
    if (dx > 0 && step > 0) onTurn(step - 1);
  };

  let leftPage: { page: PageModel; number: number } | "cover" | null;
  let rightPage: { page: PageModel; number: number } | null;
  if (wide) {
    if (step === 0) {
      leftPage = "cover";
      rightPage = { page: pages[0] ?? BLANK, number: 1 };
    } else {
      const l = step * 2 - 1;
      leftPage = { page: pages[l] ?? BLANK, number: l + 1 };
      rightPage = pages[l + 1] ? { page: pages[l + 1], number: l + 2 } : null;
    }
  } else {
    leftPage = null;
    rightPage = { page: pages[step] ?? BLANK, number: step + 1 };
  }

  const back = () => onTurn(step - 1);
  const next = () => onTurn(step + 1);

  const binderEl = (
    <div
      ref={setNodeRef}
      role="region"
      aria-label={`${name}, open`}
      onTouchStart={wide ? undefined : onTouchStart}
      onTouchEnd={wide ? undefined : onTouchEnd}
      onTouchCancel={wide ? undefined : onTouchCancel}
      className={`p2-binder ${wide ? "" : "p2-binder--single"}`}
      style={
        {
          "--vinyl": vinyl,
          boxShadow: isOver
            ? "0 0 0 3px #00D558, 0 0 28px rgba(0,213,88,0.5), 0 24px 50px rgba(0,0,0,0.6)"
            : undefined,
        } as CSSProperties
      }
    >
      {leftPage === "cover" && (
        <div ref={leftRef} className="p2-cover">
          {cover}
        </div>
      )}
      {leftPage && leftPage !== "cover" && (
        <div ref={leftRef}>
          <Page {...props} page={leftPage.page} number={leftPage.number} />
        </div>
      )}
      {wide && (
        <div className="p2-rings" aria-hidden="true">
          <span className="p2-ring" />
          <span className="p2-ring" />
          <span className="p2-ring" />
        </div>
      )}
      {rightPage ? (
        <div ref={rightRef}>
          <Page {...props} page={rightPage.page} number={rightPage.number} />
        </div>
      ) : (
        <div ref={rightRef} className="p2-cover flex items-center justify-center text-center text-sm text-ink-3">
          <p>The back cover. That&apos;s the whole binder.</p>
        </div>
      )}
    </div>
  );

  if (wide) {
    // Turn buttons flank the binder, so the whole spread fits the fold.
    return (
      <div className="p2-desk flex items-stretch justify-center gap-2">
        <TurnButton dir="back" wide disabled={step === 0} onClick={back} />
        {binderEl}
        <TurnButton dir="next" wide disabled={step >= steps - 1} onClick={next} />
      </div>
    );
  }
  return (
    <div className="p2-desk">
      {binderEl}
      <div className="mt-3 flex items-center justify-between gap-3">
        <TurnButton dir="back" wide={false} disabled={step === 0} onClick={back} />
        <TurnButton dir="next" wide={false} disabled={step >= steps - 1} onClick={next} />
      </div>
    </div>
  );
}

/** "Inside cover and page 1 of 6", "Pages 2 and 3 of 6", "Page 4 of 9". */
export function whereLabel(pageCount: number, wide: boolean, at: number): string {
  const steps = stepCount(pageCount, wide);
  const step = Math.min(at, steps - 1);
  const n = Math.max(pageCount, 1);
  if (!wide) return `Page ${step + 1} of ${n}`;
  if (step === 0) return `Inside cover and page 1 of ${n}`;
  return step * 2 + 1 <= pageCount ? `Pages ${step * 2} and ${step * 2 + 1} of ${n}` : `Page ${step * 2} of ${n}`;
}

function Page({
  page,
  number,
  variant,
  saleTags,
  aimed,
  found,
  onOpen,
  onAdd,
  onAim,
  onShift,
  rearrange,
}: BinderDeskProps & { page: PageModel; number: number }) {
  const head = [page.section, page.note].filter(Boolean).join(", ");
  return (
    <div role="group" aria-label={`Page ${number}${head ? `, ${head}` : ""}`} className="p2-page">
      {head && (
        <p aria-hidden="true" className="p2-page-head">
          {head}
        </p>
      )}
      {page.pockets.map((pocket, i) => (
        <Pocket
          key={i}
          pocket={pocket}
          variant={variant}
          saleTag={saleTags}
          index={i}
          pageNumber={number}
          aimed={sameSlot(aimed, pocket.slot)}
          found={sameSlot(found, pocket.slot)}
          onOpen={onOpen}
          onAdd={onAdd}
          onAim={onAim}
          onShift={onShift}
          rearrange={rearrange}
        />
      ))}
      <p aria-hidden="true" className="p2-page-foot">
        {number}
      </p>
    </div>
  );
}

function TurnButton({
  dir,
  wide,
  disabled,
  onClick,
}: {
  dir: "back" | "next";
  wide: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const back = dir === "back";
  const label = back ? (wide ? "Previous pages" : "Previous page") : wide ? "Next pages" : "Next page";
  const Icon = back ? ChevronLeftIcon : ChevronRightIcon;
  if (wide) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={`${label} (${back ? "PageUp" : "PageDown"})`}
        aria-keyshortcuts={back ? "PageUp" : "PageDown"}
        className="flex w-11 flex-none items-center justify-center rounded-xl border border-rule-strong bg-sheet text-ink-2 hover:border-neon-blue hover:text-ink focus-outline disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Icon aria-hidden="true" className="h-6 w-6" />
      </button>
    );
  }
  return (
    <NeonButton
      type="button"
      variant="secondary"
      outline
      onClick={onClick}
      disabled={disabled}
      aria-keyshortcuts={back ? "PageUp" : "PageDown"}
      className="min-h-11 flex-1"
    >
      {back && <Icon aria-hidden="true" className="h-5 w-5" />}
      {label}
      {!back && <Icon aria-hidden="true" className="h-5 w-5" />}
    </NeonButton>
  );
}
