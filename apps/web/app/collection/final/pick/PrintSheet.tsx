import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { playerNames, setLabel } from "../data/labels";
import { SPORT_LINE, VARIANT_STRIPE, sportHue } from "./colours";
import { isPulled, orderLabel, VARIANT_ROLE_LABEL, variantName, variantRole, type PickRow, type PickSection } from "./model";

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

/** "Parallel Gold Foil", "Insert parallel 8 Bit Ballers Red", "Base". */
function variantText(row: PickRow): string {
  const c = row.card;
  if (!c) return "";
  const role = variantRole(c);
  const name = variantName(c);
  return name ? `${VARIANT_ROLE_LABEL[role]} ${name}` : VARIANT_ROLE_LABEL[role];
}

function markersText(row: PickRow): string {
  const marks = [row.isNew && "New", row.lastOnes && "Last ones", row.short > 0 && `Short ${row.short}`].filter(Boolean);
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
              const done = isPulled(row, pulled);
              const role = c ? variantRole(c) : null;
              // Outside a set's divider the line names its set too.
              const card = c
                ? `${section.kind === "set" ? "" : `${setLabel(c.set)} `}${variantText(row)}${row.serial ? ` ${row.serial}` : ""}`
                : (row.problem ?? "");
              const marks = markersText(row);
              return (
                <tr key={row.key} data-pulled={done || undefined} className={c ? "nb-pick-sheet-row" : "nb-pick-sheet-row nb-pick-sheet-lost"}>
                  <td>
                    <span className="nb-pick-tick">{done ? "✓" : ""}</span>
                  </td>
                  {showSlot && <td>{row.spot?.slot ?? ""}</td>}
                  <td className="nb-pick-sheet-strong">{row.quantity > 1 ? `×${row.quantity}` : ""}</td>
                  <td className="nb-pick-sheet-strong">{c ? `#${c.cardNumber}` : ""}</td>
                  <td>
                    {c ? (
                      <>
                        <span className="nb-pick-sheet-strong">{playerNames(c)}</span>
                        {c.teams.length > 0 && ` ${c.teams.map((t) => t.name).join(" / ")}`}
                      </>
                    ) : (
                      row.listingTitle
                    )}
                    {marks && <i className="nb-pick-sheet-mark"> {marks}</i>}
                  </td>
                  <td>
                    {role && <span aria-hidden="true" className={`nb-pick-band nb-pick-sheet-band ${VARIANT_STRIPE[role]}`} />}
                    {card}
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
