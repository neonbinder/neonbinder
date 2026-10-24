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
import { FeatureBadges, ForSaleBadge, TradeBadge } from "./CardRows";
import { useScopedName } from "./catalog/home";
import { LoadingNote, SkeletonBars } from "./catalog/Skeleton";
import { printRunLabel, setLabel, shortCardName, teamTextColor, variantLabel } from "./data/labels";
import {
  emptyCopyDetails,
  homesOf,
  isForSale,
  isWantedIn,
  systemContainer,
  useCapabilities,
  useCollectionActions,
  useContainers,
  useCopiesOf,
  useScope,
  useWants,
  wantOf,
  wantToggle,
} from "./data/store";
import type { Card, Container, ContainerId, Copy, CopyDetails, CopyId, MoveResult } from "./data/types";
import { binderText, lineNames, lineSummary, lineWhat, type NamedBinder } from "./lineItems";
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

/** The homes as "Where it lives" and "Move to" offer them. */
function formHomes(homes: readonly Container[]): FormHome[] {
  return homes.map((h) => ({ id: h.id, name: h.name, kind: h.kind }));
}

/** "Show box (box, for sale)" or "Main": how a pick names a home. */
function homeOption(h: Pick<Container, "name" | "kind">): string {
  return h.kind === "box" ? `${h.name} (box, for sale)` : h.name;
}

/**
 * Everything about one card: the card, its facts, every line item you own
 * (each editable in place, movable to another binder or box, and removable,
 * each with Undo), and an "Add a copy" form so grade, cost and where it lives
 * go in at the moment of adding. The acquired date starts at today.
 *
 * NEO-359: a copy lives in ONE home. "Where it lives" picks it on an add
 * (the page's scope, else Main, by default); an existing line changes home
 * only through its Move control (`moveCopy`, which can move part of a stack),
 * never through Edit (`updateCopy` keeps the home). A copy in a box is for
 * sale; Up for trade is a flag and the card stays where it lives.
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
  const team = card.teams[0];
  const panel = useLiverySurface("raised");
  const run = printRunLabel(card);
  const name = shortCardName(card);
  const homes = capabilities.binders ? homesOf(containers) : [];
  const names = lineNames(lines, containers);
  const wants = capabilities.wants ? allWants : undefined;
  const wanted = capabilities.wants && isWantedIn(wants, card.id, scope);
  const want = wantOf(wants, card.id);

  // Where an add lands unless the collector picks otherwise: the opener's
  // binder, else the page's scope, else Main.
  const isHomeId = (id: string | undefined) => !!id && homes.some((h) => h.id === id);
  const defaultHome = isHomeId(addBinderId)
    ? addBinderId
    : scope !== "all" && isHomeId(scope)
      ? scope
      : systemContainer(containers, "main")?.id;
  const [draft, setDraft] = useState<FormValue>(() => toForm(emptyCopyDetails()));
  const [draftHome, setDraftHome] = useState<ContainerId | undefined>(undefined);
  const [draftTrade, setDraftTrade] = useState(false);
  const addHome = draftHome ?? defaultHome;
  const [editing, setEditing] = useState<{ id: string; value: FormValue; trade: boolean } | null>(null);

  const addRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * Where the keyboard goes once the copy's form closes or opens: back to its
   * Edit button, or into the form's first field.
   */
  const [refocus, setRefocus] = useState<{ copyId: CopyId; into: "edit" | "form" } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      const id = CSS.escape(refocus.copyId);
      const target =
        refocus.into === "edit"
          ? root?.querySelector<HTMLElement>(`[data-copy-edit="${id}"]`)
          : root?.querySelector<HTMLElement>(`[data-copy-editor="${id}"] input, [data-copy-editor="${id}"] select`);
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

  const save = (copy: Copy, value: FormValue, trade: boolean) => {
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
          setRefocus({ copyId: copy.id, into: "edit" });
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
        const sale =
          to?.kind === "box" && copy.homeKind !== "box"
            ? ` ${many ? "They're" : "It's"} for sale now.`
            : to?.kind !== "box" && copy.homeKind === "box"
              ? " Off the sale table."
              : "";
        return `Moved ${what} to ${to?.name ?? "its new home"}${stacked}.${sale}`;
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
              {copies === undefined ? "Counting your copies…" : owned > 0 ? `You have ${owned}` : "Need it"}
              <span className="sr-only">.</span>
            </p>
            {capabilities.wants && (
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
            {want && (
              <>
                <dt className="text-ink-3">Wanted</dt>
                <dd className="text-ink-2">{wantWhere}</dd>
              </>
            )}
          </dl>
          <FeatureBadges card={card} />
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
              onChange={(value) => setEditing({ ...editing, id: copy.id, value })}
              onSave={(value) => save(copy, value, editing.trade)}
              onCancel={() => {
                setEditing(null);
                setRefocus({ copyId: copy.id, into: "edit" });
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
        onEdit={(copy) => {
          setEditing({ id: copy.id, value: toForm(copy), trade: copy.upForTrade });
          setRefocus({ copyId: copy.id, into: "form" });
        }}
        onRemove={remove}
        showTrade={capabilities.trade}
        showSale={capabilities.binders}
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
          homes={homes.length > 0 ? formHomes(homes) : undefined}
          homeId={addHome}
          onHomeChange={homes.length > 0 ? (id) => setDraftHome(id) : undefined}
          upForTrade={capabilities.trade ? draftTrade : undefined}
          onUpForTradeChange={capabilities.trade ? setDraftTrade : undefined}
          heading={lines.length > 0 ? "Add another copy" : "Add a copy"}
          saveLabel="Add to collection"
        />
      </div>
    </div>
  );
}

/** Where a line lives, as a small tag: a binder or a box glyph and the home's name. */
function HomeTag({ copy, homes }: { copy: Copy; homes?: readonly NamedBinder[] }) {
  const where = binderText(copy, homes);
  if (!where) return null;
  const Icon = copy.homeKind === "box" ? ArchiveBoxIcon : BookOpenIcon;
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-ink-3">
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="sr-only">in </span>
      {where}
    </span>
  );
}

/**
 * "Your copies": each line item with Edit, Move and Remove. Shared by a
 * card's detail and by a card the catalog no longer holds, whose copies the
 * collector can still see and take out.
 *
 * Remove takes the row, and the button with it, away once the write lands:
 * the keyboard moves to the next copy's Edit (or Remove), else the one
 * before, else the "Your copies" heading. A move that folds the whole line
 * into a twin lands the keyboard on the twin's Move button.
 */
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
  editing?: { id: string } | null;
  renderEditor?: (copy: Copy, index: number) => ReactNode;
  /** Copies flagged Up for trade wear a tag (capability `trade`). */
  showTrade?: boolean;
  /** Copies in a box wear a "For sale" tag (capability `binders`). */
  showSale?: boolean;
  /** Where a line can move to (capability `binders`). Move shows only with two or more. */
  homes?: readonly Container[];
  /** Moves `quantity` of the line; resolves `null` when the server refused. */
  onMove?: (copy: Copy, toHomeId: ContainerId, quantity: number) => Promise<MoveResult | null>;
  onEdit?: (copy: Copy) => void;
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

  /** The line whose Move panel is open. */
  const [moving, setMoving] = useState<CopyId | null>(null);
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
      const target = landedHere ? root?.querySelector<HTMLElement>(`[data-copy-move="${id}"]`) : null;
      (target ?? headingRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [landed, landedHere]);
  const canMove = !!onMove && !!homes && homes.length > 1;
  const moveButton = (id: CopyId) =>
    sectionRef.current?.querySelector<HTMLElement>(`[data-copy-move="${CSS.escape(id)}"]`) ?? null;
  const closeMove = (id: CopyId) => {
    moveButton(id)?.focus();
    setMoving(null);
  };
  const submitMove = (copy: Copy, toHomeId: ContainerId, quantity: number) => {
    if (!onMove) return;
    closeMove(copy.id);
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
            editing?.id === copy.id && renderEditor ? (
              <li key={copy.id} className="p-2" data-copy-editor={copy.id}>
                {renderEditor(copy, i)}
              </li>
            ) : (
              <li
                key={copy.id}
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
                    <HomeTag copy={copy} homes={binders} />
                    {showSale && isForSale(copy) && <ForSaleBadge />}
                    {showTrade && copy.upForTrade && <TradeBadge />}
                  </span>
                  <span className="block text-xs text-ink-3">
                    {[
                      copy.acquiredAt ? `Added ${shortDate(copy.acquiredAt)}` : null,
                      copy.costBasis !== undefined ? `paid $${copy.costBasis.toFixed(2)}` : null,
                      copy.location ?? null,
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
                    onClick={() => onEdit(copy)}
                  >
                    Edit
                  </button>
                )}
                {canMove && (
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    data-copy-move={copy.id}
                    aria-label={`Move ${name}, ${names[i]}`}
                    aria-expanded={moving === copy.id}
                    onClick={() => setMoving(moving === copy.id ? null : copy.id)}
                  >
                    Move
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
                {canMove && moving === copy.id && homes && (
                  <MovePanel
                    copy={copy}
                    line={names[i]}
                    homes={homes}
                    onMove={(to, quantity) => submitMove(copy, to, quantity)}
                    onCancel={() => closeMove(copy.id)}
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

/**
 * A line's Move control, open under it: where to (every other home), and,
 * on a stack, how many go ("Quantity to move", all of them to start). Enter
 * moves, Escape keeps it where it is; either way the keyboard goes back to
 * the line's Move button.
 */
function MovePanel({
  copy,
  line,
  homes,
  onMove,
  onCancel,
}: {
  copy: Copy;
  /** The line's name ("Raw, Mint ×3"), for the panel's own name. */
  line: string;
  homes: readonly Container[];
  onMove: (toHomeId: ContainerId, quantity: number) => void;
  onCancel: () => void;
}) {
  const selectId = useId();
  const helpId = useId();
  const others = homes.filter((h) => h.id !== copy.homeId);
  const [to, setTo] = useState<ContainerId>(others[0]?.id ?? "");
  const [quantity, setQuantity] = useState<number>(copy.quantity);
  const stack = copy.quantity > 1;
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= copy.quantity;
  const dest = others.find((h) => h.id === to);
  const sellNote =
    dest?.kind === "box" && copy.homeKind !== "box"
      ? "A box is the sale table: these go up for sale."
      : dest && dest.kind !== "box" && copy.homeKind === "box"
        ? "Into a binder: these come off the sale table."
        : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !to) return;
    onMove(to, quantity);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  // The panel opens with the keyboard on its first pick.
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-label={`Move ${line}`}
      className="basis-full rounded-md border border-dashed border-control bg-sheet p-3"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <div>
          <label htmlFor={selectId} className={LABEL}>
            Move to
          </label>
          <select
            id={selectId}
            ref={ref}
            className={SELECT}
            value={to}
            aria-describedby={sellNote ? helpId : undefined}
            onChange={(e) => setTo(e.target.value)}
          >
            {others.map((h) => (
              <option key={h.id} value={h.id}>
                {homeOption(h)}
              </option>
            ))}
          </select>
        </div>
        {stack && (
          <Input
            label="Quantity to move"
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
      {sellNote && (
        <p id={helpId} className="mt-2 text-xs text-ink-3">
          {sellNote}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={QUIET_BUTTON}>
          Keep it here
        </button>
        {/* aria-disabled, not disabled: the button stays focusable and says why it waits (submit refuses it). */}
        <NeonButton type="submit" variant="secondary" size="1" aria-disabled={!valid || !to || undefined}>
          {stack && valid ? `Move ${quantity}` : "Move it"}
        </NeonButton>
      </div>
    </form>
  );
}
