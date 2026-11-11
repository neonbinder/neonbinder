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
  /**
   * Baseball 2024 Topps Chrome Base, the seed's own fetch: 334 rows, card #300's row LEFT OUT
   * so exactly one card (#300) is still asked of BSC live (D8). Seed only.
   */
  toppsChrome2024Base: "2024-topps-chrome-base",
  teamBonus2010: "2010-topps-insert-team-bonus",
  /** Baseball 2010 Topps Insert Silk Collection: 201 cards, every one numbered `NNO`, so each pairs by player (exactly one card and one NNO row). */
  silkCollection2010: "2010-topps-insert-silk-collection",
  peakPerformance2010: "2010-topps-insert-peak-performance",
  peakPerformanceRelics2010: "2010-topps-insert-peak-performance-relics",
  turkeyRed2010: "2010-topps-insert-turkey-red",
  careerBestJumboJerseys2009: "2009-topps-insert-career-best-jumbo-jerseys",
  bowman2026Base: "2026-football-bowman-base",
  topps2014FootballBase: "2014-football-topps-base",
  /** Baseball 2024 Topps Chrome Insert Future Stars: 20 cards (`FS-1`..`FS-20`), the setup's insert fetch. */
  futureStars2024: "2024-topps-chrome-insert-future-stars",
  /** Hockey 1995 Roanoke Express ECHL Base: 25 cards, every one `NNO`, so each pairs by player. */
  roanokeExpress1995: "1995-hockey-roanoke-express-echl-base",
  /**
   * The Roanoke file with Chris Pollack's row LEFT OUT: 24 rows, so exactly one card is asked of BSC
   * live per fetch. The one-marketplace spec uploads it; that card is the player it creates.
   */
  roanokeExpress1995OneLive: "1995-hockey-roanoke-express-echl-base-one-live",
  /** Baseball 2025 Bowman Draft Insert Bowman Draft Nights Autographs: 5 cards (`BDNA-EW`..), the autograph-format spec's set. */
  bowmanDraftNightsAutographs2025: "2025-bowman-draft-insert-bowman-draft-nights-autographs",
  /**
   * Baseball 2025 Bowman Draft Insert Prospect Dual Autographs: 14 cards (`PDA-AD`..), the dual-team spec's set,
   * with `PDA-WW`'s row LEFT OUT (13 rows): the one card whose two-club team value that spec reads live.
   */
  prospectDualAutographs2025: "2025-bowman-draft-insert-prospect-dual-autographs",
  /**
   * Baseball 2026 Bowman Insert Anime: 35 rows read (the `TBD` row is no card number we can read, so
   * that one card is still asked of BSC); six of the cards are football players.
   */
  bowmanAnime2026: "2026-bowman-insert-anime",
  /**
   * Hockey 1995 Halifax Mooseheads QMJHL Base, ALL 26 cards. No spec uploads it whole: it is the
   * source of the trimmed copy below (made from it with `--omit-number`).
   */
  halifaxMooseheads1995Full: "1995-hockey-halifax-mooseheads-qmjhl-base-full",
  /**
   * The Halifax file with cards 1, 2, 3, 24 and 25 left OUT: 21 rows. The NEO-487 stall spec uploads
   * it, so exactly five cards are asked of BSC live: #1-#3 are the stalled ids, #24 and #25 answer.
   */
  halifaxMooseheads1995FiveLive: "1995-hockey-halifax-mooseheads-qmjhl-base-five-live",
} as const;

export type ChecklistName = (typeof CHECKLISTS)[keyof typeof CHECKLISTS];

/** What a fixture file holds, read off the file itself so the spec never restates a count. */
export interface ChecklistFacts {
  /** The file's absolute path, for `setInputFiles`. */
  path: string;
  /** Data rows the dialog reads (a number with a digit, or NNO): what its preview and the chip call "N rows". */
  rows: number;
  /**
   * The cards the file answers: numbered rows whose number is on exactly one
   * row (rule 7; the cards of a captured set are one per row, so each such row
   * meets exactly one card) plus NNO rows whose player is on exactly one NNO
   * row, each AND naming at least one team. This is N in "Teams from your
   * checklist: N of M cards"; M is the set's card count.
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

/** A person's or club's name as the product compares two sides: accents, case, dots and spacing set aside. */
function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The names of a "; "-joined cell, as one order-free key ("" when the cell names nobody). */
function namesKey(cell: string): string {
  return [...new Set(cell.split(";").map(nameKey).filter(Boolean))].sort().join("|");
}

export function checklistFacts(name: ChecklistName): ChecklistFacts {
  // A row is read when its number holds a digit, is an insert's letter code ("RA-MT": capitals on
  // both sides of a hyphen), or is the unnumbered "NNO" (kept as a row; a card printed with no
  // number is paired by player, below). Anything else is a skipped line.
  const isNnoRow = (r: ChecklistRow) => r.number.trim().toUpperCase().replace(/[.:]$/, "") === "NNO";
  const readable = (r: ChecklistRow) => /\d/.test(r.number) || /^[A-Z]{1,6}(?:-[A-Z]{1,6})+$/.test(r.number.trim()) || isNnoRow(r);
  const rows = checklistRows(name).filter(readable);
  const numbered = rows.filter((r) => !isNnoRow(r));
  const unnumbered = rows.filter(isNnoRow);
  const countOf = new Map<string, number>();
  for (const r of numbered) countOf.set(r.number.toUpperCase(), (countOf.get(r.number.toUpperCase()) ?? 0) + 1);
  const playerCountOf = new Map<string, number>();
  for (const r of unnumbered) playerCountOf.set(namesKey(r.player), (playerCountOf.get(namesKey(r.player)) ?? 0) + 1);
  // A numbered card is matched when its number is on exactly one row (rule 7). An unnumbered card
  // is matched by player, only when exactly one such card and exactly one NNO row name that player
  // (the captured set has one card per row, so the rows count for both sides). A matched card counts
  // here only when its row names a team: a teamless matched row leaves BSC to be asked (B1).
  const named = (r: ChecklistRow) => r.team.trim() !== "";
  const matchedNumbered = numbered.filter((r) => countOf.get(r.number.toUpperCase()) === 1 && named(r)).length;
  const matchedUnnumbered = unnumbered.filter((r) => {
    const key = namesKey(r.player);
    return key !== "" && playerCountOf.get(key) === 1 && named(r);
  }).length;
  return {
    path: `${DIRECTORY}${name}.csv`,
    rows: rows.length,
    matched: matchedNumbered + matchedUnnumbered,
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

/**
 * The chip a used checklist leaves beside the Sync button: a button named
 * "Publisher's checklist: N rows" (" · M skipped" follows when lines were), which
 * reopens the dialog. Contract: a locator, nothing waited for.
 */
export function publishersChecklistChip(page: Page, rows: number): Locator {
  return page.getByRole("button", { name: new RegExp(`^Publisher's checklist: ${rows} ${rows === 1 ? "row" : "rows"}\\b`) });
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
 * the sync's message. N is `facts.matched`; M is the set's card count on the
 * marketplace (it can differ from the file's rows: a card the checklist never
 * listed has no row), so only N is pinned.
 */
export async function expectTeamsFromChecklist(page: Page, facts: ChecklistFacts): Promise<void> {
  await expect(
    // N is read off the file; M is the set's card count on the marketplace, so it is not restated here.
    page.getByText(new RegExp(`Teams from your checklist: ${facts.matched} of [0-9]+ cards`)).first(),
  ).toBeVisible();
}
