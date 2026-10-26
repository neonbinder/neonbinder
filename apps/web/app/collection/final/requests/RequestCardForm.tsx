import { useMutation, useQuery } from "convex/react";
import { useId, useRef, useState, type FormEvent } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LABEL, SELECT_PANEL } from "../../prototypes/p1/ui";
import type { Drill } from "../catalog/drill";
import { useCard, useDrill, writeErrorMessage } from "../data/store";
import type { Card, DrillItem } from "../data/types";
import PhotoField from "./PhotoField";
import { uploadPhoto } from "./photos";

/** The checklist select's "it isn't listed" choice: the collector types its name. */
const TYPED = "__typed";

/**
 * NEO-361 — Request a card. Required: the set, the checklist it is in (picked,
 * or typed when it isn't listed), the card number and the player. Notes and
 * photos of the front and back are optional. The set is a catalog set,
 * walked from sport down, or a set the collector already asked us for.
 *
 * Sending makes the card theirs to own straight away; "I have it" files a
 * copy.
 */
export default function RequestCardForm({
  searched,
  drill,
  privateSetId: initialPrivateSet,
  onHave,
}: {
  searched: string;
  drill: Drill;
  /** Start on "A set I asked for", with this one picked. */
  privateSetId: string | null;
  onHave: (card: Card) => void;
}) {
  const mySets = useQuery(api.collectionRequests.mySets, {});
  const requestCard = useMutation(api.collectionRequests.requestCard);
  const addPrivateCard = useMutation(api.collectionRequests.addPrivateCard);
  const generateUploadUrl = useMutation(api.collectionRequests.generateUploadUrl);

  const [where, setWhere] = useState<"catalog" | "mine">(initialPrivateSet ? "mine" : "catalog");
  const [sport, setSport] = useState(drill.sport ?? "");
  const [year, setYear] = useState(drill.year ?? "");
  const [brand, setBrand] = useState(drill.brand ?? "");
  const [set, setSet] = useState(drill.set ?? "");
  const [type, setType] = useState(drill.type ?? "");
  const [variant, setVariant] = useState(drill.variant ?? "");
  const [sub, setSub] = useState(drill.sub ?? "");
  const [typedVariant, setTypedVariant] = useState("");
  const [privateSet, setPrivateSet] = useState(initialPrivateSet ?? "");
  const [cardNumber, setCardNumber] = useState("");
  const [player, setPlayer] = useState("");
  const [notes, setNotes] = useState("");
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ id: string; label: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const alertId = useId();
  // Bumped on each send, to clear the file pickers.
  const [round, setRound] = useState(0);

  const sports = useDrill("sport", {});
  const years = useDrill(sport ? "year" : null, { sport });
  const brands = useDrill(sport && year ? "brand" : null, { sport, year });
  const sets = useDrill(sport && year && brand ? "set" : null, { sport, year, brand });
  const types = useDrill(set ? "variantType" : null, { sport, year, brand, set });
  const pickedType = types?.find((t) => t.id === type);
  const variants = useDrill(pickedType?.hasChildren ? "variant" : null, { sport, year, brand, set, variantType: type });
  const pickedVariant = variants?.find((t) => t.id === variant);
  const subs = useDrill(pickedVariant?.hasChildren ? "subVariant" : null, {
    sport,
    year,
    brand,
    set,
    variantType: type,
    variant,
  });
  const pickedSub = subs?.find((t) => t.id === sub);
  // The deepest pick that is a checklist (a type with children may be one too).
  const checklist = [pickedSub, pickedVariant, pickedType].find((i) => i?.variantId);
  const typing = type === TYPED;

  const reset = () => {
    setCardNumber("");
    setPlayer("");
    setNotes("");
    setFront(null);
    setBack(null);
    setRound((n) => n + 1);
  };

  /** The first required field left empty: its `name`, and what to say. */
  const missing = (): [string, string] | null => {
    if (where === "catalog") {
      if (!set) return [!sport ? "sport" : !year ? "year" : !brand ? "brand" : "set", "Pick the set it's from."];
      if (typing && !typedVariant.trim()) return ["typedVariant", "Add the checklist it's in."];
      if (!typing && !checklist) {
        const at = pickedVariant?.hasChildren ? "sub" : pickedType?.hasChildren ? "variant" : "type";
        return [at, "Pick the checklist it's in, or type it if it isn't listed."];
      }
    } else {
      if (!privateSet) return ["privateSet", "Pick the set you asked for."];
      if (!typedVariant.trim()) return ["typedVariant", "Add the checklist it's in (Base, an insert or a parallel)."];
    }
    if (!cardNumber.trim().replace(/^#/, "")) return ["cardNumber", "Add the card number."];
    if (!player.trim()) return ["player", "Add the player."];
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const gap = missing();
    setInvalid(gap?.[0] ?? null);
    if (gap) {
      setProblem(gap[1]);
      // Take the keyboard to the field that needs filling.
      const field = formRef.current?.elements.namedItem(gap[0]);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    setProblem(null);
    setSending(true);
    try {
      const photos = {
        ...(front ? { frontImageId: await uploadPhoto(generateUploadUrl, front) } : {}),
        ...(back ? { backImageId: await uploadPhoto(generateUploadUrl, back) } : {}),
      };
      const common = {
        cardNumber: cardNumber.trim(),
        player: player.trim(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...photos,
      };
      const label = `#${cardNumber.trim().replace(/^#/, "")} ${player.trim()}`;
      if (where === "catalog") {
        const r = await requestCard({
          setId: set as Id<"selectorOptions">,
          ...(typing
            ? { variantName: typedVariant.trim() }
            : { variantId: checklist!.variantId as Id<"selectorOptions"> }),
          ...(searched.trim() ? { searched: searched.trim() } : {}),
          ...common,
        });
        setSent({ id: r.privateCardId, label });
      } else {
        const r = await addPrivateCard({
          privateSetId: privateSet as Id<"privateSets">,
          variantName: typedVariant.trim(),
          ...common,
        });
        setSent({ id: r.privateCardId, label });
      }
      reset();
    } catch (err) {
      setProblem(writeErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const openSets = mySets ?? [];
  /** Wires a field to the alert when it is the one left empty. */
  const flag = (name: string) =>
    invalid === name ? { "aria-invalid": true as const, "aria-describedby": alertId } : {};

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-4" aria-label="Request a card" noValidate>
      {openSets.length > 0 && (
        <fieldset className="space-y-1">
          <legend className={LABEL}>Which set</legend>
          <div className="flex flex-wrap gap-4 text-sm text-ink">
            <label className="flex min-h-11 items-center gap-2 sm:min-h-9">
              <input type="radio" name="where" checked={where === "catalog"} onChange={() => setWhere("catalog")} />
              A set in the catalog
            </label>
            <label className="flex min-h-11 items-center gap-2 sm:min-h-9">
              <input type="radio" name="where" checked={where === "mine"} onChange={() => setWhere("mine")} />
              A set I asked for
            </label>
          </div>
        </fieldset>
      )}

      {where === "catalog" ? (
        <fieldset className="space-y-3">
          <legend className="sr-only">The set</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Pick name="sport" flag={flag} label="Sport" value={sport} items={sports} onChange={(v) => {
                setSport(v);
                setYear("");
                setBrand("");
                setSet("");
                setType("");
              }} />
            <Pick name="year" flag={flag} label="Year" value={year} items={sport ? years : []} onChange={(v) => {
                setYear(v);
                setBrand("");
                setSet("");
                setType("");
              }} />
            <Pick name="brand" flag={flag} label="Brand" value={brand} items={sport && year ? brands : []} onChange={(v) => {
                setBrand(v);
                setSet("");
                setType("");
              }} />
            <Pick name="set" flag={flag} label="Set" value={set} items={sport && year && brand ? sets : []} onChange={(v) => {
                setSet(v);
                setType("");
              }} />
          </div>
          {set && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Pick
                name="type"
                flag={flag}
                label="Checklist"
                value={type}
                items={types}
                typed="It isn't listed"
                onChange={(v) => {
                  setType(v);
                  setVariant("");
                  setSub("");
                }}
              />
              {pickedType?.hasChildren && (
                <Pick
                  name="variant"
                  flag={flag}
                  label={pickedType.name}
                  value={variant}
                  items={variants}
                  onChange={(v) => {
                    setVariant(v);
                    setSub("");
                  }}
                />
              )}
              {pickedVariant?.hasChildren && (
                <Pick name="sub" flag={flag} label={`${pickedVariant.name} parallels`} value={sub} items={subs} onChange={setSub} />
              )}
              {typing && (
                <Input
                  surface="panel"
                  name="typedVariant"
                  {...flag("typedVariant")}
                  label="Which checklist?"
                  placeholder="Gold Refractor /50"
                  value={typedVariant}
                  onChange={(e) => setTypedVariant(e.target.value)}
                  autoComplete="off"
                />
              )}
            </div>
          )}
        </fieldset>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Set you asked for</span>
            <select name="privateSet" {...flag("privateSet")} className={SELECT_PANEL} value={privateSet} onChange={(e) => setPrivateSet(e.target.value)}>
              <option value="">Pick one</option>
              {openSets.map((s) => (
                <option key={s._id} value={s._id}>
                  {[s.year, s.name.toLowerCase().startsWith(s.brand.toLowerCase()) ? s.name : `${s.brand} ${s.name}`].join(" ")}
                </option>
              ))}
            </select>
          </label>
          <Input
            surface="panel"
            name="typedVariant"
            {...flag("typedVariant")}
            label="Which checklist?"
            placeholder="Base"
            value={typedVariant}
            onChange={(e) => setTypedVariant(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      <div className="grid grid-cols-[7rem_1fr] gap-3">
        <Input
          surface="panel"
          name="cardNumber"
          {...flag("cardNumber")}
          label="Card number"
          placeholder="41"
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
          autoComplete="off"
        />
        <Input
          surface="panel"
          name="player"
          {...flag("player")}
          label="Player"
          placeholder="Reggie White"
          value={player}
          onChange={(e) => setPlayer(e.target.value)}
          autoComplete="off"
        />
      </div>
      <Textarea
        label="Notes (optional)"
        placeholder="Anything that helps us find it: a code on the back, the print run…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <PhotoField key={`front${round}`} label="Front photo (optional)" file={front} onFile={setFront} onProblem={setProblem} />
        <PhotoField key={`back${round}`} label="Back photo (optional)" file={back} onFile={setBack} onProblem={setProblem} />
      </div>

      <p id={alertId} role="alert" className="min-h-[1.25rem] text-sm text-neon-pink-text">
        {problem ?? ""}
      </p>
      {/* Mounted before anything is sent, so the news is announced. */}
      <div role="status">{sent && <Sent key={sent.id} id={sent.id} label={sent.label} onHave={onHave} />}</div>
      <div className="flex justify-end">
        {/* aria-disabled, not disabled: the keyboard stays on the button while it sends. */}
        <NeonButton type="submit" variant="primary" aria-disabled={sending || undefined}>
          {sending ? "Sending…" : "Send request"}
        </NeonButton>
      </div>
    </form>
  );
}

/** What a send says, with "I have it" once the new card has loaded. */
function Sent({ id, label, onHave }: { id: string; label: string; onHave: (card: Card) => void }) {
  const card = useCard(id);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-neon-green/50 p-3 text-sm">
      <p className="min-w-0 flex-1 text-ink">
        Sent {label}. It&apos;s yours to file now, and it&apos;s in My requests.
      </p>
      <NeonButton type="button" variant="secondary" outline disabled={!card} onClick={() => card && onHave(card)}>
        I have it
      </NeonButton>
    </div>
  );
}

function Pick({
  name,
  flag,
  label,
  value,
  items,
  typed,
  onChange,
}: {
  name: string;
  flag: (name: string) => object;
  label: string;
  value: string;
  items: DrillItem[] | undefined;
  /** Adds the "it isn't listed" choice under this wording. */
  typed?: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <select
        name={name}
        {...flag(name)}
        className={SELECT_PANEL}
        value={value}
        disabled={!items || (items.length === 0 && !typed)}
        aria-busy={items === undefined || undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{items === undefined ? "Loading…" : "Pick one"}</option>
        {items?.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
        {typed && <option value={TYPED}>{typed}</option>}
      </select>
    </label>
  );
}
