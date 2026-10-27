import { useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
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
  homeName,
  homesFor,
  initialSetup,
  type Setup,
} from "../_shared/ui";
import PublicFrame from "../_shared/PublicFrame";
import "../_shared/intake.css";

/**
 * NEO-369 — add-cards prototype 1, "Guided Wizard".
 *
 * The conventional web answer: four numbered steps in the shell's normal
 * column, mouse-first, little motion. Steps 1-3 (where, which set, defaults)
 * are short pages with Next; step 4 is the live list. Cards that need you sit
 * at the top, work in progress below them, saved cards at the bottom.
 */

const STEPS = ["Where", "Which set", "Defaults", "Add cards"] as const;

export default function AddCardsPrototype1() {
  useDocumentTitle("Guided Wizard · Add cards prototype");
  const [step, setStep] = useState(0);
  const [setup, setSetup] = useState<Setup>(initialSetup("binder"));
  const sim = useIntakeSim({
    setChosen: setup.variant !== null,
    homeId: setup.homeId,
    running: step === 3,
  });

  return (
    <PublicFrame wide={false}>
      <div data-motion="low" className="mx-auto max-w-3xl">
        <IntakeBanner
          current={1}
          note="narrow column, mouse-first, low motion"
        />
        <h2 className="mb-1 text-2xl font-bold text-ink">
          Add cards from photos
        </h2>
        <ol
          className="mb-6 flex list-none flex-wrap gap-2 p-0"
          aria-label="Steps"
        >
          {STEPS.map((s, n) => (
            <li key={s}>
              <button
                type="button"
                disabled={n > step}
                onClick={() => setStep(n)}
                aria-current={n === step ? "step" : undefined}
                className={`rounded-full border px-3 py-1 text-sm ${RING} ${
                  n === step
                    ? "border-neon-green-text font-semibold text-neon-green-text"
                    : n < step
                      ? "border-rule text-ink-2"
                      : "border-rule text-ink-3 opacity-60"
                }`}
              >
                {n + 1}. {s}
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <StepCard
            title="Where are these cards going?"
            onNext={() => setStep(1)}
          >
            <KindToggle setup={setup} onChange={setSetup} />
            <HomeSelect setup={setup} onChange={setSetup} />
            <p className="m-0 text-xs text-ink-3">
              Any card can still go somewhere else on its own.
            </p>
          </StepCard>
        )}
        {step === 1 && (
          <StepCard
            title="Which set are they from?"
            onNext={() => setStep(2)}
            onBack={() => setStep(0)}
          >
            <VariantSelect setup={setup} onChange={setSetup} />
            <CommonPrice setup={setup} onChange={setSetup} />
            <p className="m-0 text-xs text-ink-3">
              Picking the set makes matching much more accurate. Skip it for a
              mixed pile and each card&apos;s set is found from its photo.
            </p>
          </StepCard>
        )}
        {step === 2 && (
          <StepCard
            title="Details for every card"
            onNext={() => setStep(3)}
            onBack={() => setStep(1)}
            next="Start adding"
          >
            <p className="m-0 text-sm text-ink-3">
              These fill in every card. Change any one card later.
            </p>
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
          </StepCard>
        )}
        {step === 3 && (
          <Workspace sim={sim} setup={setup} onEdit={() => setStep(0)} />
        )}
      </div>
    </PublicFrame>
  );
}

function StepCard({
  title,
  children,
  onNext,
  onBack,
  next = "Next",
}: {
  title: string;
  children: React.ReactNode;
  onNext: () => void;
  onBack?: () => void;
  next?: string;
}) {
  return (
    <section
      className="space-y-4 rounded-lg border border-panel-rule bg-panel p-5 shadow-offset"
      aria-label={title}
    >
      <h3 className="m-0 text-lg font-semibold text-ink">{title}</h3>
      {children}
      <div className="flex gap-2 pt-2">
        <NeonButton variant="primary" onClick={onNext}>
          {next}
        </NeonButton>
        {onBack && (
          <NeonButton variant="secondary" outline onClick={onBack}>
            Back
          </NeonButton>
        )}
      </div>
    </section>
  );
}

function Workspace({
  sim,
  setup,
  onEdit,
}: {
  sim: IntakeSim;
  setup: Setup;
  onEdit: () => void;
}) {
  const review = sim.items.filter((i) => i.stage === "review");
  const working = sim.items.filter(
    (i) => i.stage !== "review" && i.stage !== "saved",
  );
  const saved = sim.items.filter((i) => i.stage === "saved");
  const order = { none: 0, check: 1, matched: 2 } as const;
  review.sort((a, b) => order[bandOf(a)] - order[bandOf(b)]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rule px-3 py-2 text-sm text-ink-2">
        <SetupSummary setup={setup} />
        <button
          type="button"
          onClick={onEdit}
          className={`text-neon-blue-text underline ${RING}`}
        >
          Change
        </button>
      </div>
      <StageCounters sim={sim} />
      <AddSources sim={sim} compact />

      <section aria-labelledby="p1-review" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="p1-review" className="m-0 text-lg font-semibold text-ink">
            Needs you{" "}
            <span className="font-normal text-ink-3">({review.length})</span>
          </h3>
          <NeonButton
            variant="primary"
            disabled={sim.counts.matched === 0}
            onClick={sim.actions.saveAllConfident}
          >
            Save {sim.counts.matched} matched
          </NeonButton>
        </div>
        {review.length === 0 && (
          <p className="text-sm text-ink-3">
            Nothing yet. Cards land here as they finish matching.
          </p>
        )}
        <ul className="m-0 list-none space-y-3 p-0">
          {review.map((i) => (
            <ReviewRow key={i.id} item={i} sim={sim} setup={setup} />
          ))}
        </ul>
      </section>

      <LoosePile sim={sim} />

      {working.length > 0 && (
        <section aria-labelledby="p1-working" className="space-y-2">
          <h3 id="p1-working" className="m-0 text-sm font-semibold text-ink">
            Still working{" "}
            <span className="font-normal text-ink-3">({working.length})</span>
          </h3>
          <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3">
            {working.map((i) => (
              <li
                key={i.id}
                className="flex items-center gap-2 rounded-md border border-rule px-2 py-1.5"
              >
                <ScanImage item={i} side="front" size="sm" />
                <div className="min-w-0 text-xs">
                  <BandBadge item={i} />
                  <p className="m-0 mt-1 truncate text-ink-3">
                    {i.read.player ?? i.front.file}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {saved.length > 0 && (
        <section aria-labelledby="p1-saved" className="space-y-2">
          <h3 id="p1-saved" className="m-0 text-sm font-semibold text-ink">
            Saved{" "}
            <span className="font-normal text-ink-3">({saved.length})</span>
          </h3>
          <ul className="m-0 list-none divide-y divide-rule p-0 text-sm">
            {saved.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap justify-between gap-2 py-1.5 text-ink-2"
              >
                <span>
                  {i.match.cardId
                    ? cardTitle(i.match.cardId)
                    : "Requested card (private)"}
                </span>
                <span className="text-ink-3">
                  {homeName(i.homeId)} · qty {i.qty}
                  {i.newLine ? " (new line)" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ReviewRow({
  item,
  sim,
  setup,
}: {
  item: Item;
  sim: IntakeSim;
  setup: Setup;
}) {
  const [open, setOpen] = useState<null | "fix" | "pick" | "details">(null);
  const details = effectiveDetails(item, setup.defaults);
  return (
    <li className="rounded-lg border border-panel-rule bg-panel p-3 shadow-offset">
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-2">
          <ScanImage item={item} side="front" size="sm" />
          <ScanImage item={item} side="back" size="sm" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="m-0 font-semibold text-ink">
              {cardTitle(item.match.cardId)}
            </p>
            <BandBadge item={item} />
          </div>
          <p className="m-0 text-xs text-ink-3">
            Paired {item.pairedBy} · {homeName(item.homeId)}
            {details.grading
              ? ` · ${details.grading.grader} ${details.grading.grade} cert ${details.grading.cert}`
              : ""}
            {details.serial ? ` · serial ${details.serial}` : ""}
          </p>
          <NeedsYou item={item} sim={sim} onPick={() => setOpen("pick")} />
          <div className="flex flex-wrap items-center gap-3">
            <QtyField item={item} sim={sim} />
            <NeonButton
              size="1"
              variant="primary"
              disabled={!item.match.cardId}
              onClick={() => sim.actions.confirm(item.id)}
            >
              Yes, this is the card
            </NeonButton>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            {(["pick", "fix", "details"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-expanded={open === k}
                onClick={() => setOpen(open === k ? null : k)}
                className={`text-neon-blue-text underline ${RING}`}
              >
                {k === "pick"
                  ? "Wrong card"
                  : k === "fix"
                    ? "Fix the scan"
                    : "Details & where"}
              </button>
            ))}
          </div>
          {open === "pick" && (
            <CardPicker item={item} sim={sim} onDone={() => setOpen(null)} />
          )}
          {open === "fix" && <FixTools item={item} sim={sim} />}
          {open === "details" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs text-ink-3">
                Put in
                <select
                  className={`rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`}
                  value={item.homeId}
                  onChange={(e) =>
                    sim.actions.moveHome(item.id, e.target.value)
                  }
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
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
