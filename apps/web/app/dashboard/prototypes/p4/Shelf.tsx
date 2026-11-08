import type { CSSProperties } from "react";
import type { ShelfBinder } from "./shelf-model";

/**
 * The hero: your binders and the smart ones standing spine out on two
 * shelves. A spine wears its card count at the foot and, when cards came in
 * since the last visit, a green "N new" sticker on top. A smart binder's
 * spine has a hatched band (it fills itself); one whose rule names a
 * checklist also wears a meter up the label's edge and its percent.
 *
 * A spine is a disclosure button: it opens the pocket page below
 * (`aria-controls`), and the open one stands half out of the shelf.
 */

interface ShelfProps {
  mine: ShelfBinder[];
  smart: ShelfBinder[];
  openId: string | null;
  /** Where the pocket page renders, for `aria-controls`. */
  pocketId: string;
  onOpen: (id: string) => void;
}

/** A thicker binder for more cards, within reason. */
function spineWidth(cards: number): number {
  return Math.round(Math.min(78, Math.max(50, 46 + cards * 0.6)));
}

export function spineLabel(b: ShelfBinder): string {
  const parts = [b.name];
  if (b.kind === "smart") parts.push("smart binder");
  parts.push(`${b.cardCount} ${b.cardCount === 1 ? "card" : "cards"}`);
  parts.push(b.newCards.length > 0 ? `${b.newCards.length} new since your last visit` : "nothing new");
  if (b.checklist) parts.push(`${b.checklist.percent}% of the checklist`);
  return parts.join(", ");
}

function Spine({
  binder,
  index,
  open,
  pocketId,
  onOpen,
}: {
  binder: ShelfBinder;
  index: number;
  open: boolean;
  pocketId: string;
  onOpen: (id: string) => void;
}) {
  const fresh = binder.newCards.length;
  const style = {
    "--vinyl": binder.vinyl,
    "--stripe": binder.stripe,
    "--i": index,
    width: `${spineWidth(binder.cardCount)}px`,
  } as CSSProperties;
  return (
    <button
      type="button"
      data-p4-spine={binder.id}
      aria-label={spineLabel(binder)}
      aria-expanded={open}
      aria-controls={pocketId}
      onClick={() => onOpen(binder.id)}
      className={`p4-spine ${binder.kind === "smart" ? "p4-spine--smart" : ""}`}
      style={style}
    >
      {fresh > 0 && (
        <span className="p4-sticker" aria-hidden="true">
          <b>{fresh}</b>
          <small>new</small>
        </span>
      )}
      {binder.kind === "smart" && <span className="p4-spine-hatch" aria-hidden="true" />}
      <span className="p4-spine-label relative" aria-hidden="true">
        <span className="p4-spine-name">{binder.name}</span>
        {binder.checklist && <span className="p4-spine-count">{binder.checklist.percent}%</span>}
        <span className="p4-spine-count">{binder.cardCount}</span>
        {binder.checklist && (
          <span className="p4-spine-meter">
            <span style={{ height: `${binder.checklist.percent}%` }} />
          </span>
        )}
      </span>
    </button>
  );
}

function ShelfRow({
  id,
  title,
  note,
  binders,
  startIndex,
  openId,
  pocketId,
  onOpen,
}: {
  id: string;
  title: string;
  note: string;
  binders: ShelfBinder[];
  startIndex: number;
  openId: string | null;
  pocketId: string;
  onOpen: (id: string) => void;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={id} className="text-lg font-bold text-ink">
          {title}
        </h2>
        <p className="text-sm text-ink-3">{note}</p>
      </div>
      <ul className="p4-shelf" aria-label={title}>
        {binders.map((b, i) => (
          <li key={b.id} className="flex-none">
            <Spine binder={b} index={startIndex + i} open={openId === b.id} pocketId={pocketId} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      <div className="p4-ledge shelf-ledge" aria-hidden="true" />
    </section>
  );
}

export default function Shelf({ mine, smart, openId, pocketId, onOpen }: ShelfProps) {
  return (
    <div className="grid gap-x-10 gap-y-8 md:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
      <ShelfRow
        id="p4-mine"
        title="Your binders"
        note="Filed by hand."
        binders={mine}
        startIndex={0}
        openId={openId}
        pocketId={pocketId}
        onOpen={onOpen}
      />
      <ShelfRow
        id="p4-smart"
        title="Smart binders"
        note="They fill themselves."
        binders={smart}
        startIndex={mine.length}
        openId={openId}
        pocketId={pocketId}
        onOpen={onOpen}
      />
    </div>
  );
}
