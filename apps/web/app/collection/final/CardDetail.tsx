import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArchiveBoxIcon, BookOpenIcon, StarIcon as StarSolid } from "@heroicons/react/20/solid";
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import CardFace from "../prototypes/_shared/CardFace";
import CopyDetailsForm, { type FormHome } from "../prototypes/_shared/CopyDetailsForm";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT, shortDate, useLiverySurface } from "../prototypes/p1/ui";
import { FeatureBadges, TradeBadge } from "./CardRows";
import { useScopedName } from "./catalog/home";
import { LoadingNote, SkeletonBars } from "./catalog/Skeleton";
import { printRunLabel, setLabel, shortCardName, teamTextColor, variantLabel } from "./data/labels";
import {
  emptyCopyDetails,
  bindersOf,
  homesOf,
  homesOnSide,
  isWantedIn,
  systemContainer,
  useCapabilities,
  useCollectionActions,
  useContainers,
  useCopiesOf,
  useScope,
  useSide,
  useWants,
  wantOf,
  wantToggle,
} from "./data/store";
import type { Card, Container, ContainerId, Copy, CopyDetails, CopyId, MoveResult } from "./data/types";
import { binderText, lineNames, lineSummary, lineWhat, type NamedBinder } from "./lineItems";
import { useLineKeys } from "./lineKeys";
import OwnCardNote from "./OwnCardNote";
import { usePageApi } from "./pageApi";

/** What the shared copy form edits (the prototypes' copy shape). */
type FormValue = ComponentProps<typeof CopyDetailsForm>["value"];

/** A copy's details as the form holds them. The prototypes' binder ticks and sale fields stay empty. */
function toForm(d: CopyDetails): FormValue {
  return {
    quantity: d.quantity,
    ...(d.condition ? { condition: d.condition } : {}),
    ...(d.graded ? { graded: d.graded } : {}),
    ...(d.serialNumber ? { serialNumber: d.serialNumber } : {}),
    ...(d.costBasis !== undefined ? { costBasis: d.costBasis } : {}),
    acquiredAt: d.acquiredAt,
    ...(d.location ? { location: d.location } : {}),
    notes: d.notes,
    binderIds: [],
    forSale: false,
  };
}

/** The form's value as the store takes it: never a home (that is `moveCopy`), never a price. */
function fromForm(v: FormValue): CopyDetails {
  return {
    quantity: v.quantity,
    condition: v.condition,
    graded: v.graded,
    serialNumber: v.serialNumber,
    costBasis: v.costBasis,
    acquiredAt: v.acquiredAt,
    location: v.location,
    notes: v.notes,
  };
}

/**
 * The drawer's headline count, split on the hard line: "2 in binders · 3 for
 * sale", or just the part that applies ("2 in binders", "3 for sale").
 */
function ownedText(kept: number, forSale: number): string {
  const parts = [
    kept > 0 ? `${kept.toLocaleString("en-US")} in binders` : null,
    forSale > 0 ? `${forSale.toLocaleString("en-US")} for sale` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** The homes as "Where it lives" and "Move to" offer them. */
function formHomes(homes: readonly Container[]): FormHome[] {
  return homes.map((h) => ({ id: h.id, name: h.name, kind: h.kind }));
}


/**
 * Everything about one card: the card, its facts, every line item you own
 * (each editable in place, movable to another binder or box, and removable,
 * each with Undo), and an "Add a copy" form so grade, cost and where it lives
 * go in at the moment of adding. The acquired date starts at today.
 *
 * NEO-359: a copy lives in ONE home. "Where it lives" picks it on an add;
 * an existing line changes home only through its Move control (`moveCopy`,
 * which can move part of a stack), never through Edit (`updateCopy` keeps
 * the home). A copy in a box is for sale; Up for trade is a flag and the
 * card stays where it lives.
 *
 * NEO-364: the drawer is the one place the two sides meet. "Your copies"
 * lists every line, binder and box, with Sell / Take off sale to cross. The
 * add form offers the page side's homes only (`useSide`): binders on the
 * collection (the opener's binder, else the page's scope, else Main), boxes
 * on the inventory (the opener's box, the target box, else Unsorted).
 *
 * The keyboard is never dropped: Edit puts it in the copy's form, and Save
 * copy or Cancel brings it back to that copy's Edit button (Remove's and
 * Move's parking are `CopyList`'s).
 */
export default function CardDetail({
  card,
  onCancelAdd,
  mode = "view",
  focusCopyId,
  addBinderId,
}: {
  card: Card;
  /** Escape / Cancel in the add form. */
  onCancelAdd: () => void;
  /** "add" scrolls to the Add a copy form and puts the caret in it. */
  mode?: "view" | "add";
  /** Ring this line item in "Your copies". */
  focusCopyId?: CopyId;
  /** The home the add form picks instead of the page's scope (the hunt tray's open binder). */
  addBinderId?: string;
}) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const capabilities = useCapabilities();
  const containers = useContainers();
  const scope = useScope();
  const scopedName = useScopedName();
  const allWants = useWants();
  const copies = useCopiesOf(card.id);
  const lines = copies ?? [];
  const owned = lines.reduce((n, c) => n + c.quantity, 0);
  // The hard line (NEO-364): what you keep (binders) and what's for sale
  // (boxes) are counted apart, never as one pile.
  const forSale = lines.reduce((n, c) => n + (c.homeKind === "box" ? c.quantity : 0), 0);
  const kept = owned - forSale;
  const team = card.teams[0];
  const panel = useLiverySurface("raised");
  const run = printRunLabel(card);
  const name = shortCardName(card);
  const side = useSide();
  const homes = capabilities.binders ? homesOf(containers) : [];
  const names = lineNames(lines, containers);
  const wants = capabilities.wants ? allWants : undefined;
  const wanted = capabilities.wants && isWantedIn(wants, card.id, scope);
  const want = wantOf(wants, card.id);

  // "Where it lives" on an add offers the page side's homes, never a mix:
  // binders on the collection, boxes (Unsorted first) on the inventory.
  const addKinds = !capabilities.binders
    ? []
    : capabilities.inventory
      ? homesOnSide(containers, side)
      : bindersOf(containers);
  const onInventory = capabilities.inventory && side === "inventory";
  // Where an add lands unless the collector picks otherwise: the opener's
  // home (on this side), else the collection's scope, else the side's
  // catch-all (Main, or Unsorted).
  const isAddId = (id: string | undefined) => !!id && addKinds.some((h) => h.id === id);
  const defaultHome = isAddId(addBinderId)
    ? addBinderId
    : !onInventory && scope !== "all" && isAddId(scope)
      ? scope
      : systemContainer(containers, onInventory ? "unsorted" : "main")?.id;
  const [draft, setDraft] = useState<FormValue>(() => toForm(emptyCopyDetails()));
  const [draftHome, setDraftHome] = useState<ContainerId | undefined>(undefined);
  const [draftTrade, setDraftTrade] = useState(false);
  const addHome = draftHome ?? defaultHome;
  /** The line whose form is open, by its line key (`CopyList`), so it lives through the store's id swap. */
  const [editing, setEditing] = useState<{ key: string; value: FormValue; trade: boolean } | null>(null);

  const addRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * Where the keyboard goes once the copy's form closes or opens: back to its
   * Edit button, or into the form's first field. By line key, like `editing`:
   * a save that waited for the line's real id still finds it.
   */
  const [refocus, setRefocus] = useState<{ key: string; into: "edit" | "form" } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      const line = `[data-copy-line="${CSS.escape(refocus.key)}"]`;
      const target =
        refocus.into === "edit"
          ? root?.querySelector<HTMLElement>(`${line} [data-copy-edit]`)
          : root?.querySelector<HTMLElement>(`${line} input, ${line} select`);
      target?.focus();
      // Only this move: a newer one asked for meanwhile still runs.
      setRefocus((current) => (current === refocus ? null : current));
    });
    return () => cancelAnimationFrame(frame);
  }, [refocus]);
  const copyRefs = useRef(new Map<CopyId, HTMLLIElement>());
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (mode === "add") {
        addRef.current?.scrollIntoView({ block: "start" });
        addRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      } else if (focusCopyId) {
        copyRefs.current.get(focusCopyId)?.scrollIntoView({ block: "nearest" });
      }
    });
    return () => cancelAnimationFrame(frame);
    // Once per open: the drawer remounts this per card and per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const homeById = (id: string | undefined) => (id ? containers?.find((c) => c.id === id) : undefined);

  const resetDraft = () => {
    setDraft(toForm(emptyCopyDetails()));
    setDraftHome(undefined);
    setDraftTrade(false);
  };

  const add = (value: FormValue) => {
    const home = homeById(addHome);
    const details: CopyDetails = {
      ...fromForm(value),
      ...(addHome ? { homeId: addHome } : {}),
      ...(capabilities.trade && draftTrade ? { upForTrade: true } : {}),
    };
    const shown = { ...details, ...(home ? { homeName: home.name } : {}) };
    void api
      .run(
        () => writes.addLineItem(card, details),
        (r) =>
          `${r.merged ? `Stacked it: another ${name} on the pile` : `Added ${name}, ${lineSummary(shown, containers)}`}${
            home?.kind === "box" ? ". It's for sale." : ""
          }`,
      )
      .then((r) => {
        if (r) resetDraft();
      });
  };

  const save = (copy: Copy, value: FormValue, trade: boolean, key: string) => {
    const patch: Partial<CopyDetails> = {
      ...fromForm(value),
      ...(capabilities.trade ? { upForTrade: trade } : {}),
    };
    void api
      .run(
        () => writes.updateCopy(copy, patch),
        () => `Saved ${name}, ${lineSummary({ ...copy, ...patch }, containers)}`,
      )
      .then((r) => {
        if (r) {
          setEditing(null);
          setRefocus({ key, into: "edit" });
        }
      });
  };

  const remove = (copy: Copy) => {
    void api.run(
      () => writes.removeCopy(copy),
      (r) => `Removed ${name}, ${lineSummary(r.removed, containers)}`,
    );
  };

  const move = (copy: Copy, toHomeId: ContainerId, quantity: number) => {
    const to = homeById(toHomeId);
    const whole = quantity >= copy.quantity;
    const many = quantity > 1;
    return api.run(
      () => writes.moveCopy(copy, toHomeId, whole ? undefined : { quantity }),
      (r) => {
        const what = whole ? name : `${quantity} of ${name}`;
        const stacked = r.folded ? ", stacked with the ones already there" : "";
        const where = to?.name ?? "its new home";
        if (to?.kind === "box" && copy.homeKind !== "box") {
          return `${what} ${many ? "are" : "is"} up for sale in ${where}${stacked}.`;
        }
        if (to?.kind !== "box" && copy.homeKind === "box") {
          return `Took ${what} off sale. ${many ? "They're" : "It's"} back in ${where}${stacked}.`;
        }
        return `Moved ${what} to ${where}${stacked}.`;
      },
    );
  };

  const toggleWant = () => {
    if (!wants) return;
    const t = wantToggle(wants, card.id, scope);
    const forScope = t.on && t.binderId && scopedName ? ` for ${scopedName}` : "";
    void api.run(
      () => writes.setWant(t.cardId, t.binderId, t.on),
      () => (t.on ? `${name} is on your Want List${forScope}` : `${name} is off your Want List`),
    );
  };

  const wantWhere = want
    ? want.binderId
      ? `for ${homeById(want.binderId)?.name ?? "a binder"}`
      : "for the collection"
    : "";

  return (
    <div ref={rootRef} className="space-y-5">
      <div className="grid grid-cols-[6.5rem_1fr] gap-4 sm:grid-cols-[9rem_1fr]">
        <CardFace model={card} size="fill" state={owned > 0 ? "owned" : "need"} />
        <div className="min-w-0 space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-base font-semibold text-ink">
              {copies === undefined
                ? "Counting your copies…"
                : owned === 0
                  ? "Need it"
                  : capabilities.binders
                    ? ownedText(kept, forSale)
                    : `You have ${owned}`}
              <span className="sr-only">.</span>
            </p>
            {capabilities.wants && !card.own && (
              <button
                type="button"
                aria-pressed={wanted}
                aria-busy={wants === undefined || undefined}
                aria-disabled={wants === undefined || undefined}
                onClick={toggleWant}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold aria-disabled:cursor-wait aria-disabled:opacity-60 ${FOCUS} ${
                  wanted
                    ? "border-neon-yellow-text bg-neon-yellow/10 text-neon-yellow-text"
                    : "border-control text-ink-2 hover:border-ink-3 hover:text-ink"
                }`}
              >
                {wanted ? <StarSolid aria-hidden="true" className="h-4 w-4" /> : <StarOutline aria-hidden="true" className="h-4 w-4" />}
                Want
              </button>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-3">Set</dt>
            <dd className="text-ink-2">{setLabel(card.set)}</dd>
            <dt className="text-ink-3">{card.variant.kind === "parallel" ? "Parallel" : card.variant.kind === "base" ? "Type" : "Insert"}</dt>
            <dd className="text-ink-2">{variantLabel(card.variant)}</dd>
            {card.teams.length > 0 && (
              <>
                <dt className="text-ink-3">{card.teams.length > 1 ? "Teams" : "Team"}</dt>
                <dd style={{ color: teamTextColor(team, panel) }}>
                  {card.teams.map((t) => (t.location ? `${t.location} ${t.name}` : t.name)).join(" / ")}
                </dd>
              </>
            )}
            {card.players.length > 0 && (
              <>
                <dt className="text-ink-3">{card.players.length > 1 ? "Players" : "Player"}</dt>
                <dd className="text-ink-2">{card.players.map((p) => p.name).join(", ")}</dd>
              </>
            )}
            {run && (
              <>
                <dt className="text-ink-3">Print run</dt>
                <dd className="text-ink-2">{run === "1/1" ? "1 of 1" : `Numbered ${run}`}</dd>
              </>
            )}
            {card.cardVariation && (
              <>
                <dt className="text-ink-3">Variation</dt>
                <dd className="text-ink-2">{card.cardVariation}</dd>
              </>
            )}
            <CardNotesRow notes={card.notes} />
            {want && (
              <>
                <dt className="text-ink-3">Wanted</dt>
                <dd className="text-ink-2">{wantWhere}</dd>
              </>
            )}
          </dl>
          <FeatureBadges card={card} />
          {card.own && <OwnCardNote own={card.own} />}
        </div>
      </div>

      <CopyList
        name={name}
        copies={copies}
        names={names}
        binders={containers}
        focusCopyId={focusCopyId}
        copyRefs={copyRefs}
        editing={editing}
        renderEditor={(copy, i) =>
          editing && (
            <CopyDetailsForm
              card={card}
              value={editing.value}
              onChange={(value) => setEditing({ ...editing, value })}
              onSave={(value) => save(copy, value, editing.trade, editing.key)}
              onCancel={() => {
                setEditing(null);
                setRefocus({ key: editing.key, into: "edit" });
              }}
              hideSaleFields
              hideBinders
              upForTrade={capabilities.trade ? editing.trade : undefined}
              onUpForTradeChange={capabilities.trade ? (trade) => setEditing({ ...editing, trade }) : undefined}
              heading={`Edit ${names[i]}`}
              saveLabel="Save copy"
            />
          )
        }
        onEdit={(copy, key) => {
          setEditing({ key, value: toForm(copy), trade: copy.upForTrade });
          setRefocus({ key, into: "form" });
        }}
        onRemove={remove}
        showTrade={capabilities.trade}
        showSale={capabilities.binders && capabilities.inventory}
        homes={capabilities.binders ? homes : undefined}
        onMove={capabilities.binders ? move : undefined}
      />

      <div ref={addRef} className="scroll-mt-4">
        <CopyDetailsForm
          card={card}
          value={draft}
          onChange={setDraft}
          onSave={add}
          onCancel={() => {
            resetDraft();
            onCancelAdd();
          }}
          hideSaleFields
          hideBinders
          homes={addKinds.length > 0 ? formHomes(addKinds) : undefined}
          homeId={addHome}
          onHomeChange={addKinds.length > 0 ? (id) => setDraftHome(id) : undefined}
          upForTrade={capabilities.trade ? draftTrade : undefined}
          onUpForTradeChange={capabilities.trade ? setDraftTrade : undefined}
          heading={lines.length > 0 ? "Add another copy" : "Add a copy"}
          saveLabel={onInventory ? "Add to inventory" : "Add to collection"}
        />
      </div>
    </div>
  );
}

/**
 * Where a line lives, as a small tag: a binder glyph and its name, or, for a
 * line in a box, the orange "For sale · Show box" (a box is the sale table).
 */
function HomeTag({ copy, homes, sale }: { copy: Copy; homes?: readonly NamedBinder[]; sale: boolean }) {
  const where = binderText(copy, homes);
  if (sale && copy.homeKind === "box") {
    return (
      <span className="ml-2 inline-flex items-center gap-1 rounded border border-neon-orange-text px-1 text-xs font-semibold text-neon-orange-text">
        <ArchiveBoxIcon aria-hidden="true" className="h-3.5 w-3.5" />
        For sale{where ? ` · ${where}` : ""}
      </span>
    );
  }
  if (!where) return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-ink-3">
      <BookOpenIcon aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="sr-only">in </span>
      {where}
    </span>
  );
}

/**
 * What a line's panel does. "move": to another home of the same kind
 * (binder to binder, box to box), so the sale never changes in passing.
 * "sell": out of a binder into a box, up for sale. "unsell": out of a box
 * back into a binder, off sale.
 */
type Shift = "move" | "sell" | "unsell";

/** The homes a line can go to for a shift: never the one it is in. */
function shiftHomes(copy: Copy, homes: readonly Container[], shift: Shift): Container[] {
  const inBox = copy.homeKind === "box";
  return homes.filter((h) => {
    if (h.id === copy.homeId) return false;
    const box = h.kind === "box";
    return shift === "move" ? box === inBox : shift === "sell" ? box : !box;
  });
}

/**
 * Where Take off sale starts: the binder already holding the most copies of
 * this card (copies never record the binder they left), else Main, else the
 * first binder offered. `lines` is every line of the card; `to` the binders
 * the panel offers.
 */
function unsellDefault(lines: readonly Copy[], to: readonly Container[]): ContainerId | undefined {
  const held = new Map<string, number>();
  for (const c of lines) {
    if (c.homeKind === "box" || !c.homeId) continue;
    held.set(c.homeId, (held.get(c.homeId) ?? 0) + c.quantity);
  }
  let best: Container | undefined;
  for (const h of to) {
    const n = held.get(h.id) ?? 0;
    if (n > 0 && (!best || n > (held.get(best.id) ?? 0))) best = h;
  }
  return (best ?? to.find((h) => h.system === "main") ?? to[0])?.id;
}

/**
 * Whether a line's free-text location only names one of the collector's
 * binders or boxes ("Slab case"). Where it lives is the home tag's to say:
 * after a Sell or Take off sale moved it, that text names the place it left,
 * so the line stops showing it (the copy's own field keeps it, to edit).
 */
function locationNamesAHome(location: string | undefined, homes: readonly NamedBinder[] | undefined): boolean {
  const said = location?.trim().toLocaleLowerCase();
  return !!said && !!homes?.some((h) => h.name.trim().toLocaleLowerCase() === said);
}

/**
 * "Your copies": each line item with Edit, Move, Sell (or Take off sale)
 * and Remove. Shared by a card's detail and by a card the catalog no longer
 * holds, whose copies the collector can still see and take out.
 *
 * NEO-359: the collection and Inventory never mix in one list. Move goes to
 * another binder (or, for a line in a box, another box). Going up for sale
 * is its own path: Sell picks a box; a line in a box has Take off sale,
 * which picks the binder it goes back into. Both come with the inventory
 * (the `inventory` capability: the demo and, since NEO-364, the real
 * collection); without it a line has Edit, Move and Remove. Unsorted is
 * always a box to sell into, so Sell always has somewhere to go.
 *
 * Remove takes the row, and the button with it, away once the write lands:
 * the keyboard moves to the next copy's Edit (or Remove), else the one
 * before, else the "Your copies" heading. A move that folds the whole line
 * into a twin lands the keyboard on the twin's Move (or Sell) button.
 */
/**
 * NEO-367 — NB's own note about the card, as one term of the detail list.
 * Nothing at all when the card has none. The admin's line breaks are part of
 * the note; `min-w-0` + `overflow-wrap:anywhere` keep a pasted URL from
 * widening the grid past a phone.
 */
export function CardNotesRow({ notes }: { notes?: string }) {
  if (!notes) return null;
  return (
    <>
      <dt className="text-ink-3">Notes</dt>
      <dd className="min-w-0 text-ink-2 whitespace-pre-line [overflow-wrap:anywhere]">{notes}</dd>
    </>
  );
}

export function CopyList({
  name,
  copies,
  names,
  binders,
  focusCopyId,
  copyRefs,
  editing,
  renderEditor,
  onEdit,
  onRemove,
  showTrade = false,
  showSale = false,
  homes,
  onMove,
}: {
  name: string;
  copies: Copy[] | undefined;
  names: string[];
  /** The shelf, to name a line's home when the store did not. */
  binders?: readonly NamedBinder[];
  focusCopyId?: CopyId;
  copyRefs?: RefObject<Map<CopyId, HTMLLIElement>>;
  /** The line whose form is open, by the line key `onEdit` handed over. */
  editing?: { key: string } | null;
  renderEditor?: (copy: Copy, index: number) => ReactNode;
  /** Copies flagged Up for trade wear a tag (capability `trade`). */
  showTrade?: boolean;
  /** Sell / Take off sale, and a box line's "For sale · <box>" tag (capabilities `binders` and `inventory`). */
  showSale?: boolean;
  /** Every home a line can go to (capability `binders`): Move, Sell and Take off sale pick from it. */
  homes?: readonly Container[];
  /** Moves `quantity` of the line; resolves `null` when the server refused. */
  onMove?: (copy: Copy, toHomeId: ContainerId, quantity: number) => Promise<MoveResult | null>;
  /** Opens a line's form; `key` is the line's key, which `editing` names it by. */
  onEdit?: (copy: Copy, key: string) => void;
  onRemove: (copy: Copy) => void;
}) {
  const lines = copies ?? [];
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** A removal in flight from this list: the copy going, and whose button takes the keyboard. */
  const [park, setPark] = useState<{ gone: CopyId; next: CopyId | null } | null>(null);
  const goneYet = park !== null && !lines.some((c) => c.id === park.gone);
  useEffect(() => {
    if (!park || !goneYet) return;
    const frame = requestAnimationFrame(() => {
      setPark((current) => (current === park ? null : current));
      // Only when the keyboard fell with the row: never pull it from where the collector moved it.
      const active = document.activeElement;
      if (active && active !== document.body && document.contains(active)) return;
      const id = park.next ? CSS.escape(park.next) : null;
      const root = sectionRef.current;
      const target =
        (id &&
          (root?.querySelector<HTMLElement>(`[data-copy-edit="${id}"]`) ??
            root?.querySelector<HTMLElement>(`[data-copy-remove="${id}"]`))) ||
        headingRef.current;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [park, goneYet]);
  const removeAt = (copy: Copy, i: number) => {
    setPark({ gone: copy.id, next: (lines[i + 1] ?? lines[i - 1])?.id ?? null });
    onRemove(copy);
  };

  /**
   * Each line's React key: its id, carried across the swap from the id a store
   * drew it with ahead of the server to the server's own (an undo's re-split,
   * say), so neither the row nor a panel open on it closes under the pointer.
   */
  const keyOf = useLineKeys(lines);
  /** The line (by `keyOf`) whose Move, Sell or Take off sale panel is open. */
  const [moving, setMoving] = useState<{ key: string; shift: Shift } | null>(null);
  const movingOn = (copy: Copy) => (moving && moving.key === keyOf(copy) ? moving.shift : null);
  /** After a move lands: the line the cards are now (a fold's twin), for the keyboard. */
  const [landed, setLanded] = useState<CopyId | null>(null);
  const landedHere = landed !== null && lines.some((c) => c.id === landed);
  useEffect(() => {
    if (!landed) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const fell = !active || active === document.body || !document.contains(active);
      if (!fell) {
        setLanded(null);
        return;
      }
      setLanded(null);
      // The keyboard fell with the line: onto the line the cards are now, or,
      // when that line is not in this list (it moved out of what the list
      // shows), onto the list's heading, never left on the page body.
      const root = sectionRef.current;
      const id = CSS.escape(landed);
      const target = landedHere
        ? (root?.querySelector<HTMLElement>(`[data-copy-move="${id}"]`) ??
          root?.querySelector<HTMLElement>(`[data-copy-sell="${id}"]`))
        : null;
      (target ?? headingRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [landed, landedHere]);
  const canShift = !!onMove && !!homes;
  const shelf = homes ?? [];
  const opener = (id: CopyId, shift: Shift) =>
    sectionRef.current?.querySelector<HTMLElement>(
      `[data-copy-${shift === "move" ? "move" : "sell"}="${CSS.escape(id)}"]`,
    ) ?? null;
  const closeMove = (id: CopyId, shift: Shift) => {
    opener(id, shift)?.focus();
    setMoving(null);
  };
  const toggle = (copy: Copy, shift: Shift) =>
    setMoving(movingOn(copy) === shift ? null : { key: keyOf(copy), shift });
  const submitMove = (copy: Copy, shift: Shift, toHomeId: ContainerId, quantity: number) => {
    if (!onMove) return;
    closeMove(copy.id, shift);
    void onMove(copy, toHomeId, quantity).then((r) => {
      if (r) setLanded(r.copyId);
    });
  };

  return (
    <section ref={sectionRef} aria-label={`Your copies of ${name}`} className="space-y-2">
      <h3 ref={headingRef} tabIndex={-1} className="rounded-sm text-base font-semibold text-ink focus-outline">
        Your copies{lines.length > 0 ? ` (${lines.length} ${lines.length === 1 ? "line" : "lines"})` : ""}
      </h3>
      {copies === undefined ? (
        <div aria-busy="true">
          <SkeletonBars rows={2} />
          <LoadingNote>Counting your copies…</LoadingNote>
        </div>
      ) : lines.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
          None yet. Fill in what you know below and add it.
        </p>
      ) : (
        <ul className="divide-y divide-rule rounded-md border border-rule">
          {lines.map((copy, i) =>
            editing?.key === keyOf(copy) && renderEditor ? (
              <li key={keyOf(copy)} className="p-2" data-copy-editor={copy.id} data-copy-line={keyOf(copy)}>
                {renderEditor(copy, i)}
              </li>
            ) : (
              <li
                key={keyOf(copy)}
                data-copy-line={keyOf(copy)}
                ref={(el) => {
                  if (!copyRefs) return;
                  if (el) copyRefs.current.set(copy.id, el);
                  else copyRefs.current.delete(copy.id);
                }}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm ${
                  copy.id === focusCopyId ? "bg-pick-blue/20 ring-2 ring-inset ring-selection" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-ink">
                    <span>{lineWhat(copy)}</span>
                    <HomeTag copy={copy} homes={binders} sale={showSale} />
                    {showTrade && copy.upForTrade && <TradeBadge />}
                  </span>
                  <span className="block text-xs text-ink-3">
                    {[
                      copy.acquiredAt ? `Added ${shortDate(copy.acquiredAt)}` : null,
                      copy.costBasis !== undefined ? `paid $${copy.costBasis.toFixed(2)}` : null,
                      copy.location && !locationNamesAHome(copy.location, binders) ? copy.location : null,
                      copy.notes ? `“${copy.notes}”` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {onEdit && (
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    data-copy-edit={copy.id}
                    aria-label={`Edit ${name}, ${names[i]}`}
                    onClick={() => onEdit(copy, keyOf(copy))}
                  >
                    Edit
                  </button>
                )}
                {canShift && shiftHomes(copy, shelf, "move").length > 0 && (
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    data-copy-move={copy.id}
                    aria-label={`Move ${name}, ${names[i]}`}
                    aria-expanded={movingOn(copy) === "move"}
                    onClick={() => toggle(copy, "move")}
                  >
                    Move
                  </button>
                )}
                {canShift &&
                  showSale &&
                  shiftHomes(copy, shelf, copy.homeKind === "box" ? "unsell" : "sell").length > 0 && (
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    data-copy-sell={copy.id}
                    aria-label={
                      copy.homeKind === "box" ? `Take off sale, ${name}, ${names[i]}` : `Sell ${name}, ${names[i]}`
                    }
                    aria-expanded={movingOn(copy) !== null && movingOn(copy) !== "move"}
                    onClick={() => toggle(copy, copy.homeKind === "box" ? "unsell" : "sell")}
                  >
                    {copy.homeKind === "box" ? "Take off sale" : "Sell"}
                  </button>
                )}
                <button
                  type="button"
                  className={`${QUIET_BUTTON} hover:text-neon-pink-text`}
                  data-copy-remove={copy.id}
                  aria-label={`Remove ${name}, ${names[i]}`}
                  onClick={() => removeAt(copy, i)}
                >
                  Remove
                </button>
                {canShift && moving && moving.key === keyOf(copy) && (
                  <MovePanel
                    copy={copy}
                    line={names[i]}
                    shift={moving.shift}
                    homes={shiftHomes(copy, shelf, moving.shift)}
                    defaultTo={
                      moving.shift === "unsell" ? unsellDefault(lines, shiftHomes(copy, shelf, "unsell")) : undefined
                    }
                    onMove={(to, quantity) => submitMove(copy, moving.shift, to, quantity)}
                    onCancel={() => closeMove(copy.id, moving.shift)}
                  />
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** What each panel says. */
const SHIFT_WORDS: Record<
  Shift,
  { form: (line: string) => string; pick: string; quantity: string; keep: string; go: (n: number | null) => string }
> = {
  move: {
    form: (line) => `Move ${line}`,
    pick: "Move to",
    quantity: "Quantity to move",
    keep: "Keep it here",
    go: (n) => (n === null ? "Move it" : `Move ${n}`),
  },
  sell: {
    form: (line) => `Sell ${line}`,
    pick: "Into which box",
    quantity: "Quantity to sell",
    keep: "Keep it",
    go: (n) => (n === null ? "Put it up for sale" : `Put ${n} up for sale`),
  },
  unsell: {
    form: (line) => `Take ${line} off sale`,
    pick: "Back into",
    quantity: "Quantity to take back",
    keep: "Leave it for sale",
    go: (n) => (n === null ? "Take it off sale" : `Take ${n} off sale`),
  },
};

/**
 * A line's Move, Sell or Take off sale control, open under it: where to
 * (`homes`, already narrowed to the shift), and, on a stack, how many go (all
 * of them to start). Enter goes, Escape keeps it where it is; either way the
 * keyboard goes back to the button that opened it.
 */
export function MovePanel({
  copy,
  line,
  shift,
  homes,
  defaultTo,
  onMove,
  onCancel,
}: {
  copy: Copy;
  /** The line's name ("Raw, Mint ×3"), for the panel's own name. */
  line: string;
  shift: Shift;
  homes: readonly Container[];
  /** The home picked to start (Take off sale's `unsellDefault`); else the first offered. */
  defaultTo?: ContainerId;
  onMove: (toHomeId: ContainerId, quantity: number) => void;
  onCancel: () => void;
}) {
  const selectId = useId();
  const helpId = useId();
  const words = SHIFT_WORDS[shift];
  // State holds only an explicit pick. Until there is one the select shows
  // the default (or the first home), derived on every render, so homes that
  // arrive after the panel opens are picked up instead of leaving the select
  // on its first option while the submit waits on an empty "to".
  const [chosen, setChosen] = useState<ContainerId | null>(null);
  const to: ContainerId =
    (chosen && homes.some((h) => h.id === chosen) ? chosen : undefined) ??
    (defaultTo && homes.some((h) => h.id === defaultTo) ? defaultTo : undefined) ??
    homes[0]?.id ??
    "";
  const [quantity, setQuantity] = useState<number>(copy.quantity);
  const stack = copy.quantity > 1;
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= copy.quantity;
  const note =
    shift === "sell"
      ? "Everything in a box is for sale. Boxes live on Inventory."
      : shift === "unsell"
        ? "Into a binder: it's yours to keep again."
        : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !to) return;
    onMove(to, quantity);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  // The panel opens with the keyboard on its first pick. (It only opens
  // with somewhere to go: Unsorted is always a box to sell into, Main always
  // a binder to come back to.)
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-label={words.form(line)}
      className="basis-full rounded-md border border-dashed border-control bg-sheet p-3"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <div>
          <label htmlFor={selectId} className={LABEL}>
            {words.pick}
          </label>
          <select
            id={selectId}
            ref={ref}
            className={SELECT}
            value={to}
            aria-describedby={note ? helpId : undefined}
            onChange={(e) => setChosen(e.target.value)}
          >
            {homes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        {stack && (
          <Input
            label={words.quantity}
            type="number"
            inputMode="numeric"
            min={1}
            max={copy.quantity}
            step={1}
            value={Number.isFinite(quantity) ? quantity : ""}
            onChange={(e) => setQuantity(e.target.value === "" ? Number.NaN : Math.floor(Number(e.target.value)))}
            error={valid ? undefined : `Pick 1 to ${copy.quantity}.`}
            helperText={valid ? `of ${copy.quantity}` : undefined}
          />
        )}
      </div>
      {note && (
        <p id={helpId} className="mt-2 text-xs text-ink-3">
          {note}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={`${QUIET_BUTTON} max-sm:min-h-11`}>
          {words.keep}
        </button>
        {/* aria-disabled, not disabled: the button stays focusable and says why it waits (submit refuses it). */}
        <NeonButton
          type="submit"
          variant="secondary"
          size="1"
          aria-disabled={!valid || !to || undefined}
          className="max-sm:min-h-11"
        >
          {words.go(stack && valid ? quantity : null)}
        </NeonButton>
      </div>
    </form>
  );
}
