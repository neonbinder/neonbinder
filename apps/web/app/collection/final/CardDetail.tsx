import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { StarIcon as StarSolid } from "@heroicons/react/20/solid";
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import CardFace from "../prototypes/_shared/CardFace";
import CopyDetailsForm from "../prototypes/_shared/CopyDetailsForm";
import { FOCUS, QUIET_BUTTON, shortDate, useLiverySurface } from "../prototypes/p1/ui";
import { FeatureBadges } from "./CardRows";
import { LoadingNote, SkeletonBars } from "./catalog/Skeleton";
import { printRunLabel, setLabel, shortCardName, teamTextColor, variantLabel } from "./data/labels";
import { emptyCopyDetails, useCapabilities, useCollectionActions, useCopiesOf, useDemoExtension } from "./data/store";
import type { Card, Copy, CopyDetails, CopyId } from "./data/types";
import { lineNames, lineSummary } from "./lineItems";
import { usePageApi } from "./pageApi";

/** What the shared copy form edits (the prototypes' copy shape). */
type FormValue = ComponentProps<typeof CopyDetailsForm>["value"];

/** A copy's details as the form holds them. The demo's filing and sale ride along. */
function toForm(d: CopyDetails): FormValue {
  const { demo } = d;
  return {
    quantity: d.quantity,
    ...(d.condition ? { condition: d.condition } : {}),
    ...(d.graded ? { graded: d.graded } : {}),
    ...(d.serialNumber ? { serialNumber: d.serialNumber } : {}),
    ...(d.costBasis !== undefined ? { costBasis: d.costBasis } : {}),
    acquiredAt: d.acquiredAt,
    ...(d.location ? { location: d.location } : {}),
    notes: d.notes,
    binderIds: demo?.binderIds ?? [],
    forSale: demo?.forSale ?? false,
    ...(demo?.askPrice === undefined ? {} : { askPrice: demo.askPrice }),
  };
}

/** The form's value as the store takes it. `withDemo`: keep the demo's filing and sale. */
function fromForm(v: FormValue, withDemo: boolean): CopyDetails {
  const { binderIds, forSale, askPrice, ...core } = v;
  return withDemo
    ? { ...core, demo: { binderIds, forSale, ...(askPrice === undefined ? {} : { askPrice }) } }
    : core;
}

/**
 * Everything about one card: the card, its facts, every line item you own
 * (each editable in place, each removable with Undo), and an "Add a copy"
 * form so grade, cost and location go in at the moment of adding. The
 * acquired date starts at today.
 *
 * The demo adds its own: the Want toggle, binders on the form, and the sale
 * fields. The real collection keeps a copy in its one home and no price.
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
  /** Demo: tick this binder in the add form instead of the page's target. */
  addBinderId?: string;
}) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const capabilities = useCapabilities();
  const demo = useDemoExtension()?.state;
  const copies = useCopiesOf(card.id);
  const lines = copies ?? [];
  const owned = lines.reduce((n, c) => n + c.quantity, 0);
  const team = card.teams[0];
  const panel = useLiverySurface("raised");
  const run = printRunLabel(card);
  const binders = demo?.state.binders;
  const formBinders = capabilities.binders ? demo?.fileableBinders : undefined;
  const name = shortCardName(card);
  const names = lineNames(lines, binders);
  const wants = capabilities.wants ? demo : undefined;
  const wanted = wants?.isWanted(card.id) ?? false;
  const wantsFor = wants?.wants.filter((w) => w.cardId === card.id) ?? [];

  const addTo = demo
    ? addBinderId && demo.fileableBinders.some((b) => b.id === addBinderId)
      ? addBinderId
      : demo.targetBinderId
    : null;
  const freshDraft = (): FormValue => ({ ...toForm(emptyCopyDetails()), binderIds: addTo ? [addTo] : [] });
  const [draft, setDraft] = useState<FormValue>(freshDraft);
  const [editing, setEditing] = useState<{ id: string; value: FormValue } | null>(null);

  const addRef = useRef<HTMLDivElement>(null);
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

  const inBinders = demo
    ? demo.state.binders.filter((b) =>
        b.kind === "smart"
          ? demo.binderCards(b).some((c) => c.id === card.id)
          : lines.some((c) => c.demo?.binderIds.includes(b.id)),
      )
    : [];

  const add = (value: FormValue) => {
    const details = fromForm(value, !!demo);
    void api
      .run(
        () => writes.addLineItem(card, details),
        (r) =>
          r.merged
            ? `Stacked it: another ${name} on the pile`
            : `Added ${name}, ${lineSummary(details, binders)}`,
      )
      .then((r) => {
        if (r) setDraft(freshDraft());
      });
  };

  const save = (copy: Copy, value: FormValue) => {
    const details = fromForm(value, !!demo);
    void api
      .run(
        () => writes.updateCopy(copy, details),
        () => `Saved ${name}, ${lineSummary({ ...copy, ...details }, binders)}`,
      )
      .then((r) => {
        if (r) setEditing(null);
      });
  };

  const remove = (copy: Copy) => {
    void api.run(
      () => writes.removeCopy(copy),
      (r) => `Removed ${name}, ${lineSummary(r.removed, binders)}`,
    );
  };

  const toggleWant = () => {
    if (!wants) return;
    const undo = wants.toggleWant(card.id);
    api.notify(wanted ? `${name} is off your Want List` : `${name} is on your Want List`, undo);
  };

  const wantWhere = wantsFor
    .map((w) => (w.binderId ? `for ${demo?.getBinder(w.binderId)?.name ?? "a binder"}` : "for the collection"))
    .join(", ");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[6.5rem_1fr] gap-4 sm:grid-cols-[9rem_1fr]">
        <CardFace model={card} size="fill" state={owned > 0 ? "owned" : "need"} />
        <div className="min-w-0 space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-base font-semibold text-ink">
              {copies === undefined ? "Counting your copies…" : owned > 0 ? `You have ${owned}` : "Need it"}
              <span className="sr-only">.</span>
            </p>
            {wants && (
              <button
                type="button"
                aria-pressed={wanted}
                onClick={toggleWant}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${FOCUS} ${
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
          </dl>
          <FeatureBadges card={card} />
          {inBinders.length > 0 && (
            <p className="text-ink-2">
              <span className="text-ink-3">In binders: </span>
              {inBinders.map((b) => (b.kind === "smart" ? `${b.name} (smart)` : b.name)).join(", ")}
            </p>
          )}
          {wantsFor.length > 0 && (
            <p className="text-ink-2">
              <span className="text-ink-3">Wanted: </span>
              {wantWhere}
            </p>
          )}
        </div>
      </div>

      <CopyList
        name={name}
        copies={copies}
        names={names}
        binders={binders}
        focusCopyId={focusCopyId}
        copyRefs={copyRefs}
        editing={editing}
        renderEditor={(copy, i) =>
          editing && (
            <CopyDetailsForm
              card={card}
              value={editing.value}
              onChange={(value) => setEditing({ id: copy.id, value })}
              onSave={(value) => save(copy, value)}
              onCancel={() => setEditing(null)}
              binders={formBinders}
              hideSaleFields={!capabilities.saleFields}
              heading={`Edit ${names[i]}`}
              saveLabel="Save copy"
            />
          )
        }
        onEdit={(copy) => setEditing({ id: copy.id, value: toForm(copy) })}
        onRemove={remove}
        tradeBinderId={capabilities.trade ? demo?.tradeBinderId : undefined}
      />

      <div ref={addRef} className="scroll-mt-4">
        <CopyDetailsForm
          card={card}
          value={draft}
          onChange={setDraft}
          onSave={add}
          onCancel={() => {
            setDraft(freshDraft());
            onCancelAdd();
          }}
          binders={formBinders}
          hideSaleFields={!capabilities.saleFields}
          heading={lines.length > 0 ? "Add another copy" : "Add a copy"}
          saveLabel="Add to collection"
        />
      </div>
    </div>
  );
}

/**
 * "Your copies": each line item with Edit and Remove. Shared by a card's
 * detail and by a card the catalog no longer holds, whose copies the
 * collector can still see and take out.
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
  tradeBinderId,
}: {
  name: string;
  copies: Copy[] | undefined;
  names: string[];
  binders?: Parameters<typeof lineSummary>[1];
  focusCopyId?: CopyId;
  copyRefs?: RefObject<Map<CopyId, HTMLLIElement>>;
  editing?: { id: string } | null;
  renderEditor?: (copy: Copy, index: number) => ReactNode;
  /** Demo: copies filed here wear an "Up for trade" tag. */
  tradeBinderId?: string;
  onEdit?: (copy: Copy) => void;
  onRemove: (copy: Copy) => void;
}) {
  const lines = copies ?? [];
  return (
    <section aria-label={`Your copies of ${name}`} className="space-y-2">
      <h3 className="text-base font-semibold text-ink">
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
              <li key={copy.id} className="p-2">
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
                    {lineSummary(copy, binders)}
                    {tradeBinderId && copy.demo?.binderIds.includes(tradeBinderId) && (
                      <span className="ml-2 rounded border border-neon-green/60 px-1 text-xs text-neon-green-text">
                        Up for trade
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-ink-3">
                    {[
                      copy.acquiredAt ? `Added ${shortDate(copy.acquiredAt)}` : null,
                      copy.costBasis !== undefined ? `paid $${copy.costBasis.toFixed(2)}` : null,
                      copy.location ?? null,
                      copy.demo?.forSale
                        ? `For sale${copy.demo.askPrice !== undefined ? ` $${copy.demo.askPrice.toFixed(2)}` : ""}`
                        : null,
                      copy.notes ? `“${copy.notes}”` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {onEdit && (
                  <button type="button" className={QUIET_BUTTON} aria-label={`Edit ${name}, ${names[i]}`} onClick={() => onEdit(copy)}>
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  className={`${QUIET_BUTTON} hover:text-neon-pink-text`}
                  aria-label={`Remove ${name}, ${names[i]}`}
                  onClick={() => onRemove(copy)}
                >
                  Remove
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
