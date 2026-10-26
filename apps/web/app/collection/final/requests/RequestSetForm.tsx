import { useMutation } from "convex/react";
import { useId, useRef, useState, type FormEvent } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LABEL, SELECT_PANEL } from "../../prototypes/p1/ui";
import { useDrill, writeErrorMessage } from "../data/store";

/**
 * NEO-361 — Request a set: one NB doesn't have. The collector names it
 * (sport, year, brand, set); our crew builds it in the set builder.
 * Collectors never build sets. Until it is added (or after a decline) the
 * collector can file cards from it as their own, with "Add a card from it".
 */
export default function RequestSetForm({
  searched,
  sportId,
  onAddCard,
}: {
  searched: string;
  /** The sport the Checklists drill is on, if any. */
  sportId: string | null;
  /** Open Request a card on the set just asked for. */
  onAddCard: (privateSetId: string) => void;
}) {
  const requestSet = useMutation(api.collectionRequests.requestSet);
  const sports = useDrill("sport", {});
  const [sport, setSport] = useState(sportId ?? "");
  const [year, setYear] = useState("");
  const [brand, setBrand] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ id: string; label: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const alertId = useId();
  const flag = (name: string) =>
    invalid === name ? { "aria-invalid": true as const, "aria-describedby": alertId } : {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const gap: [string, string] | null = !sport
      ? ["sport", "Pick the sport."]
      : !year.trim()
        ? ["year", "Add the year."]
        : !brand.trim()
          ? ["brand", "Add the brand."]
          : !name.trim()
            ? ["name", "Add the set's name."]
            : null;
    setProblem(gap?.[1] ?? null);
    setInvalid(gap?.[0] ?? null);
    if (gap) {
      const field = formRef.current?.elements.namedItem(gap[0]);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    setSending(true);
    try {
      const r = await requestSet({
        sportId: sport as Id<"selectorOptions">,
        year: year.trim(),
        brand: brand.trim(),
        name: name.trim(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(searched.trim() ? { searched: searched.trim() } : {}),
      });
      setSent({ id: r.privateSetId, label: [year.trim(), brand.trim(), name.trim()].join(" ") });
      setYear("");
      setBrand("");
      setName("");
      setNotes("");
    } catch (err) {
      setProblem(writeErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-4" aria-label="Request a set" noValidate>
      <p className="text-sm text-ink-2">
        For a set we don&apos;t have at all. Our crew builds it, and you can file your cards from it in the meantime.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Sport</span>
          <select
            name="sport"
            {...flag("sport")}
            className={SELECT_PANEL}
            value={sport}
            disabled={!sports}
            aria-busy={sports === undefined || undefined}
            onChange={(e) => setSport(e.target.value)}
          >
            <option value="">{sports === undefined ? "Loading…" : "Pick one"}</option>
            {sports?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Input surface="panel" name="year" {...flag("year")} label="Year" placeholder="1996" value={year} onChange={(e) => setYear(e.target.value)} autoComplete="off" />
        <Input surface="panel" name="brand" {...flag("brand")} label="Brand" placeholder="Playoff" value={brand} onChange={(e) => setBrand(e.target.value)} autoComplete="off" />
        <Input surface="panel" name="name" {...flag("name")} label="Set" placeholder="Contenders" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>
      <Textarea
        label="Notes (optional)"
        placeholder="Where you found it, how many cards it has…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <p id={alertId} role="alert" className="min-h-[1.25rem] text-sm text-neon-pink-text">
        {problem ?? ""}
      </p>
      <div role="status">
      {sent && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-neon-green/50 p-3 text-sm">
          <p className="min-w-0 flex-1 text-ink">Sent {sent.label}. File your cards from it while our crew builds it.</p>
          <NeonButton type="button" variant="secondary" outline onClick={() => onAddCard(sent.id)}>
            Add a card from it
          </NeonButton>
        </div>
      )}
      </div>
      <div className="flex justify-end">
        <NeonButton type="submit" variant="primary" aria-disabled={sending || undefined}>
          {sending ? "Sending…" : "Send request"}
        </NeonButton>
      </div>
    </form>
  );
}
