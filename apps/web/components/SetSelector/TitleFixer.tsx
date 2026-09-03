import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { Input } from "../primitives/Input";
import NeonButton from "../modules/NeonButton";
import { attentionItemLabel } from "./card-attention";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  TitleFieldNote,
  TitleLengthAlert,
  TitleLengthMeter,
  titleLengthState,
} from "./TitleLengthMeter";
import { useTitlePreview } from "./useTitlePreview";
import type { AttentionFixerProps } from "./cardAttentionRegistry";

/**
 * NEO-101 — the fixer for every title-shaped attention item:
 * `titleOverLimit`, `titleTruncated` and `aspectValueOverLimit`.
 *
 * ## Why one component for three kinds
 *
 * All three are the same sentence with a different reason: "this card's title
 * does not fit, rewrite it". Splitting them into three registry entries would
 * mean a card flagged for two of them gets asked twice, on two screens, about
 * one field — and the second ask would be answered already. So this fixer reads
 * ALL of the card's items (the locked contract hands it the whole list for
 * exactly this reason), states each one, and takes a single write that clears
 * whichever of them apply.
 *
 * ## What it shows, and why that is all
 *
 * - **The card number anchors it**, the way `MissingTeamFixer` does — `#300b`
 *   in neon green, then the name, so the operator recognises the card before
 *   reading the question. No marketplace ref appears anywhere.
 * - **The reasons are listed, not summarised.** "84 characters" and "auto title
 *   was cut short" are different problems with different fixes, and a card can
 *   have both.
 * - **The counter is the same component the drawer uses.** An operator who
 *   learns the bands in one place must not meet a different rule in the other —
 *   see the note on TitleLengthMeter.
 * - **The variation field appears only when it is the problem.** A card flagged
 *   only for its title should not be shown a second field to worry about; the
 *   drawer is where you edit a card, this is where you fix one thing.
 *
 * ## Enter, and what "disabled" means here
 *
 * Enter in either the title or the variation field saves, matching every
 * other keyboard-first dialog in this directory. Save is `aria-disabled`
 * rather than natively disabled while the title is over the cap: native
 * `disabled` removes it from the tab order, and the alert saying WHY it is
 * inert is reached through its `aria-describedby` — the NEO-189 stranding
 * finding, one level up. It is guarded in the handler too, so being
 * activatable costs nothing.
 *
 * The two text inputs get the same `aria-disabled`-not-`disabled` treatment
 * while `busy` (paired with `readOnly` to still block edits) — audit fix,
 * NEO-101: unlike `MissingTeamFixer`'s Enter handler, which lives on an outer
 * wrapper that explicitly excludes INPUT/BUTTON targets, Enter here is bound
 * to the input itself, so `save()`'s `setBusy(true)` would otherwise natively
 * disable the very field that has focus mid-keystroke — the browser force-
 * blurs a newly-disabled focused control to `<body>`, the same focus-park-
 * pattern failure class this codebase has hit and fixed several times
 * (NEO-152, NEO-189, NEO-102's own Fixer siblings).
 */
export default function TitleFixer({ row, items, onSaved }: AttentionFixerProps) {
  const updateCard = useMutation(api.selectorOptions.updateCard);

  const [title, setTitle] = useState(row.listingTitle ?? "");
  const [variation, setVariation] = useState(row.cardVariation ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const titleAlertId = `${uid}-title-limit`;
  const variationAlertId = `${uid}-variation-limit`;

  const preview = useTitlePreview(row._id, setTitle);

  // Only the fields the card was actually flagged for get edited — and written.
  const fixesVariation = items.some((i) => i.kind === "aspectValueOverLimit");
  const wasTruncated = items.some((i) => i.kind === "titleTruncated");

  const titleState = titleLengthState(title.length, LISTING_TITLE_MAX, true);
  const titleDirty = title !== (row.listingTitle ?? "");
  const canSave = !busy && !titleState.over;

  // Focus the field the operator is here to edit. The walker remounts this
  // component per card (`key={current._id}`), so this IS "focus on every
  // advance": focus is never left on a control belonging to the card just
  // answered (the NEO-189 stranding finding).
  useEffect(() => {
    const raf = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // Only the fields on screen. A fixer that wrote the whole row would
      // stomp an edit made in another tab between the walker opening and this
      // click — and it has nothing to say about the fields it never showed.
      await updateCard({
        id: row._id,
        listingTitle: title.trim(),
        ...(fixesVariation ? { cardVariation: variation.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      // ConvexError `data` is the only text that crosses intact — production
      // redacts a plain Error to "Server Error". Shown inline, never as a
      // toast: the fix is in this field, so the reason belongs beside it.
      setError(userFacingMessage(e, "Couldn't save that title. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-xs text-[#FF2EB3]">
          {error}
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-200">
          <span className="text-[#00D558]">#{row.cardNumber}</span> {row.cardName}
        </h3>
        {/* a11y (1.3.1): `list-style: none` strips the implicit list/listitem
            role in Safari + VoiceOver. `role="list"` restores it so a screen
            reader still announces "list, N items" for the reasons below. */}
        <ul role="list" className="mt-0.5 list-none text-xs text-gray-400">
          {items.map((item) => (
            <li key={item.kind}>{attentionItemLabel(item)}</li>
          ))}
        </ul>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400">
          <span>Card title</span>
          <span className="flex items-center gap-2">
            <TitleLengthMeter length={title.length} soft surface="dark" />
            <button
              type="button"
              onClick={() => preview.request(titleDirty)}
              // a11y (2.5.3): the visible label cycles through "Rebuilding…"
              // and "Replace?", neither of which is a substring of a fully
              // static name — a voice-control user saying the visible word
              // would not match. The "Replace?" case is left as the fixed
              // string on purpose: CardDetailPanel's own copy of this button
              // is asserted on by name in CardDetailPanel.titleLimits.test.tsx
              // while `confirming` is true, so the two must keep matching
              // names in that state. The confirm status text below (wired via
              // aria-describedby) already tells a screen-reader user what a
              // second click does either way.
              aria-label={
                preview.loading ? "Regenerate card title — rebuilding" : "Regenerate card title"
              }
              aria-describedby={
                preview.confirming ? `${uid}-regen-confirm` : undefined
              }
              className="rounded px-1 uppercase tracking-wide text-[#00B7FF] underline decoration-dotted focus:outline-none focus:ring-1 focus:ring-[#00B7FF] hover:text-white"
            >
              {preview.loading
                ? "Rebuilding…"
                : preview.confirming
                  ? "Replace?"
                  : "Regenerate"}
            </button>
          </span>
        </div>
        <Input
          bare
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            preview.cancelConfirm();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            void save();
          }}
          // No maxLength: a pasted over-length title must stay visible to be
          // fixable. See the same note in CardDetailPanel.
          className={`w-full p-1.5 text-sm ${busy ? "opacity-60" : ""}`}
          // Anchored to the card number so it cannot collide with the drawer's
          // own "Card title" field in a selector — Maestro's `id:` matcher
          // takes a regex, so `Card title for #.*` still targets it.
          aria-label={`Card title for #${row.cardNumber}`}
          aria-invalid={titleState.over || undefined}
          aria-describedby={titleState.over ? titleAlertId : undefined}
          // a11y (audit fix): native `disabled` here would strand focus. Enter
          // in THIS field is what sets `busy` — the moment it goes native-
          // disabled, the browser force-blurs the very input that had focus,
          // straight to <body> (the codebase's recurring focus-park-pattern
          // bug, see accessibility-auditor/focus-park-pattern.md). `readOnly`
          // blocks edits without removing the field from the tab order;
          // `aria-disabled` announces the state. The `canSave` guard in
          // `save()` already makes a second Enter/click harmless, so nothing
          // relies on the native attribute for correctness.
          aria-disabled={busy || undefined}
          readOnly={busy}
        />
        <TitleLengthAlert id={titleAlertId} length={title.length} surface="dark" />
        {preview.confirming && (
          <p
            id={`${uid}-regen-confirm`}
            role="status"
            aria-atomic="true"
            className="mt-1 text-[10px] text-[#00B7FF]"
          >
            Regenerate again to replace the title you have typed.
          </p>
        )}
        {wasTruncated && (
          <TitleFieldNote surface="dark">
            Auto title was cut short — rewrite it
          </TitleFieldNote>
        )}
        {preview.dropped.length > 0 && (
          <TitleFieldNote surface="dark">
            Left out to fit: {preview.dropped.join(", ")}
          </TitleFieldNote>
        )}
        {preview.chips.length > 0 && (
          <ul aria-label="Title built from" className="mt-1.5 flex flex-wrap gap-1">
            {preview.chips.map((chip, idx) => (
              <li
                key={`${chip.label}-${chip.value}-${idx}`}
                className="rounded-full border border-gray-700 bg-gray-800/60 px-2 py-0.5 text-[10px] text-gray-200"
              >
                <span className="mr-1 uppercase tracking-wide text-gray-400">
                  {chip.label}
                </span>
                {chip.value}
              </li>
            ))}
          </ul>
        )}
      </div>

      {fixesVariation && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400">
            <span>Variation</span>
            <TitleLengthMeter length={variation.length} max={ASPECT_VALUE_MAX} surface="dark" />
          </div>
          <Input
            bare
            type="text"
            value={variation}
            onChange={(e) => setVariation(e.target.value)}
            // a11y (audit fix): matches the title field's Enter handler —
            // without this, an operator whose card was flagged ONLY for
            // `aspectValueOverLimit` (this is the only field shown) had no
            // keyboard way to save short of tabbing to the button, breaking
            // this directory's "Enter confirms" convention (see TitleFixer's
            // own header note, and CLAUDE.md's keyboard-first rule).
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void save();
            }}
            className={`w-full p-1.5 text-sm ${busy ? "opacity-60" : ""}`}
            aria-label={`Card variation for #${row.cardNumber}`}
            aria-describedby={
              variation.length > ASPECT_VALUE_MAX ? variationAlertId : undefined
            }
            // a11y (audit fix): same reasoning as the title field above — this
            // field can now also trigger `save()` on Enter while it holds
            // focus, so native `disabled` here is the same stranding hazard.
            aria-disabled={busy || undefined}
            readOnly={busy}
          />
          <TitleLengthAlert
            id={variationAlertId}
            length={variation.length}
            max={ASPECT_VALUE_MAX}
            what="Variation"
            blocking={false}
            surface="dark"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <NeonButton
          aria-disabled={canSave ? undefined : true}
          aria-describedby={titleState.over ? titleAlertId : `${uid}-save-hint`}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save (Enter)"}
        </NeonButton>
      </div>
      {/* gray-400, not gray-500: 500 measures 3.67:1 on this dialog's
          bg-gray-900 and fails 1.4.3 — the recurring bug logged in
          accessibility-auditor/contrast-reference.md. */}
      <p id={`${uid}-save-hint`} className="text-xs text-gray-400">
        {fixesVariation
          ? "Saves the title and variation on this card."
          : "Saves the title on this card."}
      </p>
    </div>
  );
}
