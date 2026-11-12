import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { playerNames } from "../data/labels";
import { SPORT_LINE, VARIANT_STRIPE, sportHue } from "./colours";
import { isPulled, NOT_IN_NB, orderLabel, rowFacts, VARIANT_ROLE_LABEL, type PickRow, type PickSection } from "./model";

/**
 * NEO-500 — the printed pick sheet: the screen's rows as a dense list, one
 * line per card at about 9pt, so 40 or more fit a letter page. It is drawn
 * only while the page prints (`usePrinting`), so the screen and the
 * accessibility tree never carry a second copy of the list.
 *
 * Built for a pen and a box of cards: a tick box at the left, the count
 * only when it is more than one, the number, the player, the variant as a
 * thin band of the divider's colour plus its name, the condition, and the
 * order at the right. A set's divider is a thin rule in its sport's colour
 * with the set title inline; the sport's name is written once, where the
 * sport starts. Colours are the paper roles (pick-list.css).
 *
 * NEO-509: a sale filed with its set by the listing's words alone prints
 * like a card, with "Not in NB" among its marks, the listing's own variant
 * word, and its next step (check the order's photo) after the variant. Every
 * line NB has no card for wraps rather than cut that step short
 * (`nb-pick-sheet-lost`).
 */

/** True while the page is printing: the Print button, Ctrl/⌘+P and print emulation all count. */
export function usePrinting(): boolean {
  const [printing, setPrinting] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("print").matches);
  useEffect(() => {
    // flushSync: the sheet must be in the page before the browser lays out the print.
    const on = () => flushSync(() => setPrinting(true));
    const off = () => setPrinting(false);
    window.addEventListener("beforeprint", on);
    window.addEventListener("afterprint", off);
    const query = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    const change = (e: MediaQueryListEvent) => (e.matches ? on() : off());
    query?.addEventListener?.("change", change);
    return () => {
      window.removeEventListener("beforeprint", on);
      window.removeEventListener("afterprint", off);
      query?.removeEventListener?.("change", change);
    };
  }, []);
  return printing;
}

/** "Parallel Gold Foil", "Insert parallel 8 Bit Ballers Red", "Base", a listing's "Variation". */
function variantText(row: PickRow): string {
  const facts = rowFacts(row);
  if (!facts) return "";
  return [facts.role && VARIANT_ROLE_LABEL[facts.role], facts.variantWord, facts.variantName].filter(Boolean).join(" ");
}

function markersText(row: PickRow): string {
  const notInNb = !row.card && rowFacts(row) !== null;
  const marks = [notInNb && NOT_IN_NB, row.isNew && "New", row.lastOnes && "Last ones", row.short > 0 && `Short ${row.short}`].filter(Boolean);
  return marks.length ? marks.join(", ") : "";
}

export default function PrintSheet({
  sections,
  pulled,
  showSlot,
}: {
  sections: PickSection[];
  pulled: ReadonlySet<string>;
  showSlot: boolean;
}) {
  const columns = 7 + (showSlot ? 1 : 0);
  // The sport's name goes on the first set of each run of that sport.
  const sportStarts = sections.map((section, i) => {
    if (section.kind !== "set") return undefined;
    const before = sections.slice(0, i).findLast((s) => s.kind === "set");
    return before?.kind === "set" && before.sportName === section.sportName ? undefined : section.sportName;
  });
  return (
    <table className="nb-pick-sheet" aria-label="Pick sheet">
      <colgroup>
        <col className="nb-pick-sheet-tick" />
        {showSlot && <col className="nb-pick-sheet-slot" />}
        <col className="nb-pick-sheet-qty" />
        <col className="nb-pick-sheet-no" />
        <col className="nb-pick-sheet-player" />
        <col />
        <col className="nb-pick-sheet-cond" />
        <col className="nb-pick-sheet-order" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Pulled</span>
          </th>
          {showSlot && <th scope="col">Slot</th>}
          <th scope="col">Qty</th>
          <th scope="col">No.</th>
          <th scope="col">Player</th>
          <th scope="col">Card</th>
          <th scope="col">Cond.</th>
          <th scope="col" className="nb-pick-sheet-right">
            Order
          </th>
        </tr>
      </thead>
      {sections.map((section, i) => {
        let head: { title: string; sport?: string; line?: string } | null = null;
        if (section.kind === "set") {
          head = { title: section.title, sport: sportStarts[i], line: SPORT_LINE[sportHue(section.sportCode)] };
        } else if (section.kind === "order") head = { title: orderLabel(section.order) };
        else if (section.kind === "cantFind") head = { title: "Can't find it" };
        else if (section.kind === "new") head = { title: "Sold since you started" };
        const count = section.rows.reduce((n, r) => n + r.quantity, 0);
        return (
          <tbody key={section.key}>
            {head && (
              <tr className="nb-pick-sheet-group">
                <th scope="rowgroup" colSpan={columns} className={head.line ?? ""}>
                  {head.sport && <b className="nb-pick-sheet-sport">{head.sport}</b>}
                  <b>{head.title}</b>
                  <span className="nb-pick-sheet-count">{count}</span>
                </th>
              </tr>
            )}
            {section.rows.map((row) => {
              const c = row.card;
              const facts = rowFacts(row);
              const done = isPulled(row, pulled);
              const role = facts?.role ?? null;
              // Outside a set's divider the line names its set too.
              const card = facts
                ? [section.kind === "set" ? "" : facts.setTitle, variantText(row), row.serial ?? ""].filter(Boolean).join(" ")
                : (row.problem ?? "");
              // A sale NB has no card for keeps its next step on paper too.
              const step = facts && !c && row.problem ? row.problem : "";
              const marks = markersText(row);
              return (
                <tr key={row.key} data-pulled={done || undefined} className={c ? "nb-pick-sheet-row" : "nb-pick-sheet-row nb-pick-sheet-lost"}>
                  <td>
                    <span className="nb-pick-tick">{done ? "✓" : ""}</span>
                  </td>
                  {showSlot && <td>{row.spot?.slot ?? ""}</td>}
                  <td className="nb-pick-sheet-strong">{row.quantity > 1 ? `×${row.quantity}` : ""}</td>
                  <td className="nb-pick-sheet-strong">{facts ? `#${facts.cardNumber}` : ""}</td>
                  <td>
                    {c ? (
                      <>
                        <span className="nb-pick-sheet-strong">{playerNames(c)}</span>
                        {c.teams.length > 0 && ` ${c.teams.map((t) => t.name).join(" / ")}`}
                      </>
                    ) : facts?.players ? (
                      <span className="nb-pick-sheet-strong">{facts.players}</span>
                    ) : (
                      row.listingTitle
                    )}
                    {marks && <i className="nb-pick-sheet-mark"> {marks}</i>}
                  </td>
                  <td>
                    {role && <span aria-hidden="true" className={`nb-pick-band nb-pick-sheet-band ${VARIANT_STRIPE[role]}`} />}
                    {card}
                    {step && <i>{card ? ` ${step}` : step}</i>}
                  </td>
                  <td>{row.grade ? `${row.grade.grader} ${row.grade.grade} #${row.grade.cert}` : row.condition}</td>
                  <td className={`nb-pick-sheet-right${row.orders.length > 1 ? " nb-pick-sheet-wrap" : ""}`}>{row.orders.map(orderLabel).join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
  );
}
