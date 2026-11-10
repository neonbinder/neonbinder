/**
 * NEO-478 / NEO-482: the publisher's checklist, uploaded through the Set
 * Builder's "Add the publisher's checklist" dialog before Sync card checklist.
 *
 * A checklist with a team beside each card means a fetch asks BuySportsCards
 * for nothing per card (D4): the specs that used to make one `card-listing` call
 * per card upload a CSV captured from BSC's OWN per-card answers instead
 * (`playwright/tools/capture-bsc-checklist-teams.mjs`, recorded in
 * SET-REGISTRY.md), so every assertion about a set's teams stays what it was.
 * The files are in `playwright/fixtures/checklists/`; `CHECKLISTS` names them.
 *
 * Everything here is located by what the dialog shows: the button "Add the
 * publisher's checklist", the dialog "Publisher's checklist" (textbox "Paste the
 * checklist", file input "Choose a file", "N rows", "Skipped lines", buttons "Use
 * this checklist" and "Cancel"), then the chip "Publisher's checklist: N rows".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";

const DIRECTORY = fileURLToPath(new URL("../fixtures/checklists/", import.meta.url));

/** The captured files, by what they are. Each name is the file's, without `.csv`. */
export const CHECKLISTS = {
  /** Baseball 2024 Topps Stars of MLB Network Base: the default wizard fixture (10 cards, no team on any). */
  starsOfMlbNetwork: "2024-topps-stars-of-mlb-network-base",
  tulsaOilers: "1995-hockey-tulsa-oilers-chl-base",
  memphisRiverKings: "1995-hockey-memphis-riverkings-chl-base",
  sanAntonioIguanas: "1995-hockey-san-antonio-iguanas-chl-base",
  fortWorthFire: "1995-hockey-fort-worth-fire-chl-base",
  oklahomaCityBlazers: "1995-hockey-oklahoma-city-blazers-chl-base",
  newHavenRavens: "1996-new-haven-ravens-rally-raffle-base",
  welcomeToTheClub: "2025-topps-welcome-to-the-club-3x-mvp-base",
  bbmRookieEditionPremium: "2024-bbm-rookie-edition-premium-base",
  teamBonus2010: "2010-topps-insert-team-bonus",
  peakPerformance2010: "2010-topps-insert-peak-performance",
  peakPerformanceRelics2010: "2010-topps-insert-peak-performance-relics",
  turkeyRed2010: "2010-topps-insert-turkey-red",
  careerBestJumboJerseys2009: "2009-topps-insert-career-best-jumbo-jerseys",
  bowman2026Base: "2026-football-bowman-base",
  topps2014FootballBase: "2014-football-topps-base",
} as const;

export type ChecklistName = (typeof CHECKLISTS)[keyof typeof CHECKLISTS];

/** What a fixture file holds, read off the file itself so the spec never restates a count. */
export interface ChecklistFacts {
  /** The file's absolute path, for `setInputFiles`. */
  path: string;
  /** Data rows: what the dialog's preview and the chip call "N rows". */
  rows: number;
  /**
   * The cards the file answers by number: rows whose number is on exactly one
   * row (rule 7; the cards of a captured set are one per row, so each such row
   * meets exactly one card). This is N in "Teams from your checklist: N of M
   * cards": a matched card takes its answer from the file even when the row
   * names no team, so BSC is not asked about it.
   */
  matched: number;
}

/** One CSV line into cells (the captured files hold quoted cells, never a newline inside one). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

/** One captured row, as the file holds it ("; " already splits a cell with several names). */
export interface ChecklistRow {
  number: string;
  player: string;
  team: string;
}

/** The file's data rows, for a spec that builds its own paste from them. */
export function checklistRows(name: ChecklistName): ChecklistRow[] {
  const lines = readFileSync(`${DIRECTORY}${name}.csv`, "utf8").split("\n").filter((l) => l.trim() !== "");
  const [header, ...rows] = lines.map(cells);
  const at = (column: string) => header.indexOf(column);
  return rows.map((r) => ({ number: r[at("number")] ?? "", player: r[at("player")] ?? "", team: r[at("team")] ?? "" }));
}

export function checklistFacts(name: ChecklistName): ChecklistFacts {
  const rows = checklistRows(name);
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.number.toUpperCase(), (count.get(r.number.toUpperCase()) ?? 0) + 1);
  return {
    path: `${DIRECTORY}${name}.csv`,
    rows: rows.length,
    matched: rows.filter((r) => count.get(r.number.toUpperCase()) === 1).length,
  };
}

/** The button beside "Sync card checklist". Contract: a locator, nothing waited for. */
export function publishersChecklistButton(page: Page): Locator {
  return page.getByRole("button", { name: "Add the publisher's checklist" });
}

/** The open dialog. Contract: a locator, nothing waited for. */
export function publishersChecklistDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Publisher's checklist" });
}

/** The chip a used checklist leaves beside the Sync button: "Publisher's checklist: N rows". */
export function publishersChecklistChip(page: Page, rows: number): Locator {
  return page.getByText(`Publisher's checklist: ${rows} ${rows === 1 ? "row" : "rows"}`).first();
}

/** The preview's count, "N rows" (a row, singular, when it is one). */
export function previewRowCount(dialog: Locator, rows: number): Locator {
  return dialog.getByText(new RegExp(`\\b${rows} ${rows === 1 ? "row" : "rows"}\\b`)).first();
}

/**
 * Upload a captured checklist and use it. Contract: ENTRY a checklist section
 * with "Add the publisher's checklist" on screen (the set's Base or variant is
 * open). EXIT the dialog is closed and the chip "Publisher's checklist: N rows"
 * is showing, N read off the file; nothing is fetched. Returns the file's facts
 * for the result line (`expectTeamsFromChecklist`).
 */
export async function usePublishersChecklist(page: Page, name: ChecklistName): Promise<ChecklistFacts> {
  const facts = checklistFacts(name);
  // A second visit to the same open checklist (a discarded review fetched again)
  // may still hold the file the first visit used: the chip is then the proof.
  const chip = publishersChecklistChip(page, facts.rows);
  await expect(publishersChecklistButton(page).or(chip).first()).toBeVisible();
  if (await chip.isVisible()) return facts;
  await publishersChecklistButton(page).click();
  const dialog = publishersChecklistDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Choose a file").setInputFiles(facts.path);
  await expect(previewRowCount(dialog, facts.rows)).toBeVisible();
  await dialog.getByRole("button", { name: "Use this checklist" }).click();
  await expect(dialog).toBeHidden();
  await expect(publishersChecklistChip(page, facts.rows)).toBeVisible();
  return facts;
}

/**
 * The Sync result line: "Teams from your checklist: N of M cards", appended to
 * the sync's message. N is `facts.matched` and M every card (`facts.rows`, as
 * the captured set has one card per row).
 */
export async function expectTeamsFromChecklist(page: Page, facts: ChecklistFacts): Promise<void> {
  await expect(
    page.getByText(`Teams from your checklist: ${facts.matched} of ${facts.rows} cards`).first(),
  ).toBeVisible();
}
