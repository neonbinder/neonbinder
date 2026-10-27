import { useMemo, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import CardFace from "../../prototypes/_shared/CardFace";
import { getCard } from "../../prototypes/_shared/data";
import LoosePile from "../_shared/loose";
import {
  bandOf,
  cardTitle,
  useIntakeSim,
  type IntakeSim,
  type Item,
} from "../_shared/sim";
import {
  AddSources,
  BandBadge,
  CardPicker,
  CommonPrice,
  DetailsFields,
  FixTools,
  HomeSelect,
  IntakeBanner,
  KindToggle,
  NeedsYou,
  QtyField,
  RING,
  ScanImage,
  SetupSummary,
  StageCounters,
  VariantSelect,
  effectiveDetails,
  homesFor,
  initialSetup,
  type Setup,
} from "../_shared/ui";
import PublicFrame from "../_shared/PublicFrame";
import "../_shared/intake.css";

/**
 * NEO-369 — add-cards prototype 3, "Review Desk".
 *
 * Full width, split: the queue on the left, one card large on the right with
 * everything needed to judge it (both sides big, the candidate cards drawn
 * next to the scan, every field). Setup is one panel on the same screen, not
 * a wizard: fill it, press Start, and it folds into a one-line summary.
 * Medium motion: progress animates, cards do not fly around.
 */

export default function AddCardsPrototype3() {
  useDocumentTitle("Review Desk · Add cards prototype");
  const [setup, setSetup] = useState<Setup>(initialSetup("box"));
  const [started, setStarted] = useState(false);
  const [editing, setEditing] = useState(false);
  const sim = useIntakeSim({
    setChosen: setup.variant !== null,
    homeId: setup.homeId,
    running: started,
  });
  const [selected, setSelected] = useState<string | null>(null);

  const queue = useMemo(() => {
    const order = { none: 0, check: 1, matched: 2 } as const;
    const review = sim.items
      .filter((i) => i.stage === "review")
      .sort((a, b) => order[bandOf(a)] - order[bandOf(b)]);
    const working = sim.items.filter(
      (i) => i.stage !== "review" && i.stage !== "saved",
    );
    const saved = sim.items.filter((i) => i.stage === "saved");
    return { review, working, saved };
  }, [sim.items]);

  // A card is always on the desk: the one picked, or else the first that needs you.
  const picked = sim.items.find((i) => i.id === selected);
  const current =
    picked && picked.stage !== "saved"
      ? picked
      : (queue.review[0] ?? picked ?? null);

  const next = () => {
    const after = queue.review.find((i) => i.id !== current?.id);
    setSelected(after?.id ?? null);
  };

  return (
    <PublicFrame>
      <div data-motion="medium">
        <IntakeBanner
          current={3}
          note="full width split, queue + big review panel, medium motion"
        />
        <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <aside
            className="order-2 space-y-4 lg:order-none"
            aria-label="Run and queue"
          >
            <div className="space-y-3 rounded-lg border border-panel-rule bg-panel p-3 shadow-offset">
              {started && !editing ? (
                <div className="flex items-start justify-between gap-2 text-sm text-ink-2">
                  <SetupSummary setup={setup} />
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className={`shrink-0 text-neon-blue-text underline ${RING}`}
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <p className="m-0 text-sm text-ink-3">
                  Set up the run on the right.
                </p>
              )}
              {started && <StageCounters sim={sim} compact />}
            </div>
            {started && (
              <>
                <AddSources sim={sim} compact />
                {sim.counts.matched > 0 && (
                  <NeonButton
                    variant="primary"
                    className="w-full"
                    onClick={sim.actions.saveAllConfident}
                  >
                    Save all {sim.counts.matched} matched
                  </NeonButton>
                )}
                <Queue
                  title="Needs you"
                  items={queue.review}
                  selected={selected}
                  onSelect={setSelected}
                />
                <Queue
                  title="Working"
                  items={queue.working}
                  selected={selected}
                  onSelect={setSelected}
                />
                <Queue
                  title="Saved"
                  items={queue.saved}
                  selected={selected}
                  onSelect={setSelected}
                />
              </>
            )}
          </aside>

          <section
            className="order-1 min-w-0 space-y-4 lg:order-none"
            aria-label="Review"
          >
            {(!started || editing) && (
              <section
                className="space-y-4 rounded-lg border border-panel-rule bg-panel p-5 shadow-offset"
                aria-labelledby="p3-setup"
              >
                <h3
                  id="p3-setup"
                  className="m-0 text-lg font-semibold text-ink"
                >
                  {started ? "Change this run" : "Start a run"}
                </h3>
                <KindToggle setup={setup} onChange={setSetup} />
                <div className="grid gap-4 md:grid-cols-2">
                  <HomeSelect setup={setup} onChange={setSetup} />
                  <VariantSelect setup={setup} onChange={setSetup} />
                </div>
                <CommonPrice setup={setup} onChange={setSetup} />
                <h4 className="m-0 text-sm font-semibold text-ink-2">
                  Every card starts with
                </h4>
                <DetailsFields
                  kind={setup.kind}
                  value={setup.defaults}
                  onChange={(patch) =>
                    setSetup({
                      ...setup,
                      defaults: { ...setup.defaults, ...patch },
                    })
                  }
                />
                <NeonButton
                  variant="primary"
                  onClick={() => {
                    setStarted(true);
                    setEditing(false);
                  }}
                >
                  {started ? "Done" : "Start adding cards"}
                </NeonButton>
              </section>
            )}
            {started && !editing && current && (
              <Desk item={current} sim={sim} setup={setup} onNext={next} />
            )}
            {started && !editing && !current && (
              <p className="rounded-lg border border-dashed border-rule p-8 text-center text-ink-3">
                Nothing needs you right now. Cards appear here as they finish
                matching.
              </p>
            )}
            {started && !editing && <LoosePile sim={sim} />}
          </section>
        </div>
      </div>
    </PublicFrame>
  );
}

function Queue({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string;
  items: Item[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={`${title}, ${items.length}`}>
      <h3 className="mb-1 text-sm font-semibold text-ink">
        {title} <span className="font-normal text-ink-3">({items.length})</span>
      </h3>
      <ul className="m-0 max-h-[28rem] list-none space-y-1 overflow-auto p-0">
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => onSelect(i.id)}
              aria-current={i.id === selected ? "true" : undefined}
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-sm ${RING} ${
                i.id === selected
                  ? "border-neon-blue-text bg-pick-blue text-pick-blue-ink selection-edge"
                  : "border-transparent text-ink-2 hover:bg-list-hover"
              }`}
            >
              <ScanImage item={i} side="front" size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {i.stage === "review" || i.stage === "saved"
                    ? cardTitle(i.match.cardId)
                    : (i.read.player ?? i.front.file)}
                </span>
                <BandBadge item={i} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Desk({
  item,
  sim,
  setup,
  onNext,
}: {
  item: Item;
  sim: IntakeSim;
  setup: Setup;
  onNext: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const details = effectiveDetails(item, setup.defaults);
  const compare =
    item.match.suggestion ??
    (item.match.candidates.length ? null : item.match.cardId);
  return (
    <section
      className="space-y-4 rounded-lg border border-panel-rule bg-panel p-5 shadow-offset"
      aria-labelledby="p3-card"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="p3-card" className="m-0 text-2xl font-bold text-ink">
          {cardTitle(item.match.cardId)}
        </h3>
        <BandBadge item={item} />
        <span className="text-xs text-ink-3">Paired {item.pairedBy}</span>
      </div>
      <div className="grid gap-6 xl:grid-cols-[auto_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex gap-3">
            <ScanImage item={item} side="front" size="lg" />
            <ScanImage item={item} side="back" size="lg" />
          </div>
          <FixTools item={item} sim={sim} />
        </div>
        <div className="min-w-0 space-y-4">
          <NeedsYou item={item} sim={sim} onPick={() => setPicking(true)} />
          {item.match.candidates.length > 1 && (
            <div>
              <p className="m-0 mb-2 text-xs font-semibold text-ink-2">
                Side by side with your scan
              </p>
              <div className="flex flex-wrap gap-3">
                {item.match.candidates.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => sim.actions.pick(item.id, c)}
                    className={`flex flex-col items-center gap-1 rounded-md border p-2 text-xs ${RING} ${
                      item.match.cardId === c
                        ? "border-neon-green-text text-neon-green-text"
                        : "border-rule text-ink-2"
                    }`}
                  >
                    <CardFace card={getCard(c)} size="md" />
                    {cardTitle(c)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {compare && item.match.cardId && (
            <div className="flex items-center gap-3">
              <CardFace card={getCard(compare)} size="md" />
              <p className="m-0 text-xs text-ink-3">
                Catalog card {item.match.suggestion ? "suggested" : "matched"}:{" "}
                {cardTitle(compare)}
              </p>
            </div>
          )}
          {picking ? (
            <CardPicker
              item={item}
              sim={sim}
              onDone={() => setPicking(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className={`text-sm text-neon-blue-text underline ${RING}`}
            >
              Wrong card? Find it
            </button>
          )}
          <label className="flex items-center gap-2 text-xs text-ink-3">
            Put in
            <select
              className={`rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`}
              value={item.homeId}
              onChange={(e) => sim.actions.moveHome(item.id, e.target.value)}
            >
              {homesFor(setup.kind).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <DetailsFields
            kind={setup.kind}
            value={details}
            onChange={(p) => sim.actions.setDetails(item.id, p)}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
            <QtyField item={item} sim={sim} />
            <NeonButton
              variant="primary"
              disabled={!item.match.cardId || item.stage !== "review"}
              onClick={() => {
                sim.actions.confirm(item.id);
                onNext();
              }}
            >
              Save and next
            </NeonButton>
            <NeonButton variant="secondary" outline onClick={onNext}>
              Skip for now
            </NeonButton>
          </div>
        </div>
      </div>
    </section>
  );
}
