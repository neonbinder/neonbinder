import { describe, expect, test } from "vitest";
import { ATTENTION_LABELS, needsAttention, type AttentionCardRow } from "../../../components/SetSelector/card-attention";
import { careerHeading, marketplaceHeading } from "../../../components/SetSelector/attention-rules";
import { ResolveError } from "../service";
import {
  SUMMARY_ENRICH_LIMIT,
  answerForEra,
  listCardAttention,
  resolveAttentionRow,
} from "./attention";
import { BASE, FUTURE, GOLD, SET, attentionClient, card, era, quiet, type Store } from "./attention.fixture";

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

describe("listCardAttention", () => {
  test("lists what the rule flags, in the walker's order, checklist by checklist", async () => {
    const store: Store = {
      rows: {
        [BASE]: [
          quiet("c-ok", "1"),
          card("c-title", "2", "Long Title", { teamOnCardIds: ["t"], listingTitle: "x".repeat(84) }),
          card("c-team10", "10", "No Team Ten", { listingTitle: "T" }),
          card("c-team3", "3", "No Team Three", { listingTitle: "T" }),
          // An unlinked player name and an over-long title: walks with the titles.
          card("c-both", "4", "Both", { pendingPlayerNames: ["Yordan Alvrez"], listingTitle: "y".repeat(90) }),
          card("c-name", "9", "Typed", { pendingPlayerNames: ["Typed Guy"], listingTitle: "T" }),
          // Still waiting on the BSC lookup: not listed, but counted.
          card("c-wait", "5", "Waiting", { platformData: { bsc: { ref: "b5" } }, listingTitle: "T" }),
        ],
        [FUTURE]: [card("c-fs1", "FS-1", "Future One", { listingTitle: "T" })],
        [GOLD]: [card("c-gold", "FS-1", "Future One Gold", { teamOnCardIds: ["t"], listingTitleTruncated: true, listingTitle: "Cut" })],
      },
    };
    const client = attentionClient({ store });
    const out = await listCardAttention(client, SET);

    expect(out.cards.map((c) => [c.rowLabel, c.cardNumber, c.asked])).toEqual([
      ["Base", "3", "missingTeam"],
      ["Base", "10", "missingTeam"],
      ["Base", "9", "unreviewedName"],
      ["Base", "2", "title"],
      ["Base", "4", "title"],
      ["Inserts › Future Stars", "FS-1", "missingTeam"],
      ["Inserts › Future Stars › Gold", "FS-1", "title"],
    ]);
    // The count is the pill's: every row the rule flags, and only those.
    const all = Object.values(store.rows).flat();
    expect(out.totals.cards).toBe(all.filter((c) => needsAttention(c as AttentionCardRow)).length);
    expect(out.totals.awaitingTeamLookup).toBe(1);
    expect(out.totals.byKind).toEqual({
      missingTeam: 3,
      unreviewedName: 2,
      titleOverLimit: 2,
      titleTruncated: 1,
      aspectValueOverLimit: 0,
    });

    const both = out.cards.find((c) => c.cardId === "c-both")!;
    expect(both.kinds).toEqual(["titleOverLimit", "unreviewedName"]);
    expect(both.reasons).toEqual([ATTENTION_LABELS.titleOverLimit, ATTENTION_LABELS.unreviewedName]);
    expect(both.answers).toEqual(["players+teams", "title"]);
    expect(both.typed).toEqual({ players: ["Yordan Alvrez"], teams: [] });
    expect(both.title).toMatchObject({ current: "y".repeat(90), length: 90, limit: 80, band: "over", truncated: false });

    const gold = out.cards.find((c) => c.cardId === "c-gold")!;
    expect(gold.row).toEqual({ type: "Inserts", name: "Future Stars", parallel: "Gold" });
    expect(gold.link).toBe("/admin/set-builder?" + new URLSearchParams({
      sport: "sport-bb", year: "year-2014", brand: "mfr-topps", set: "set-chrome", type: "vt-ins", insert: "ins-fs", parallel: "par-gold",
    }).toString());
    expect(out.cards.find((c) => c.cardId === "c-team3")!.row).toEqual({ type: "Base" });
    expect(out.cards.find((c) => c.cardId === "c-team3")!.answers).toEqual(["teams", "noTeam"]);
  });

  test("a guest card on two of the set's checklists is listed once", async () => {
    const guest = card("c-guest", "7", "Guest", { listingTitle: "T", isCrossListed: true, homeSetLabel: "2014 Topps" });
    const store: Store = { rows: { [BASE]: [guest], [FUTURE]: [guest] } };
    const out = await listCardAttention(attentionClient({ store }), SET);
    expect(out.cards).toHaveLength(1);
    expect(out.totals.cards).toBe(1);
    expect(out.cards[0].crossListedFrom).toBe("2014 Topps");
  });

  test("an empty set: nothing listed, zero totals", async () => {
    const out = await listCardAttention(attentionClient({ store: { rows: { [BASE]: [quiet("a", "1")] } } }), SET);
    expect(out.cards).toEqual([]);
    expect(out.totals.cards).toBe(0);
    expect(out.enrichment).toEqual({ enriched: 0, of: 0 });
  });

  test("accepts the runner's { set } node as the target", async () => {
    const out = await listCardAttention(attentionClient({ store: { rows: { [BASE]: [card("a", "1", "A")] } } }), { set: SET, path: {} });
    expect(out.cards).toHaveLength(1);
  });
});

describe("missingTeam facts (MissingTeamFixer's chips)", () => {
  const suggestion = (teamId: string, name: string, playerName: string, inSetYear: boolean, label = name, uncoveredSetYear?: number) => ({
    teamId,
    name,
    label,
    source: "career" as const,
    playerName,
    inSetYear,
    ...(uncoveredSetYear !== undefined ? { uncoveredSetYear } : {}),
  });

  test("set-year career teams are suggested, folded one chip per team, never the whole-career fallback", async () => {
    const store: Store = { rows: { [BASE]: [card("ll", "200", "League Leaders", { playerIds: ["p1", "p2", "p3"] })] } };
    const client = attentionClient({
      store,
      handlers: {
        "cardChecklist:suggestedTeamsForCard": () => [
          suggestion("t-yanks", "New York Yankees", "Aaron Judge", true),
          suggestion("t-yanks", "New York Yankees", "Juan Soto", true),
          suggestion("t-angels", "Los Angeles Angels", "Mike Trout", false),
        ],
        "players:getManyByIds": () => [{ name: "Aaron Judge" }, { name: "Juan Soto" }, { name: "Mike Trout" }],
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.enriched).toBe(true);
    expect(item.players).toEqual(["Aaron Judge", "Juan Soto", "Mike Trout"]);
    expect(item.career!.heading).toBe(careerHeading(true, false, undefined));
    expect(item.career!.teams.map((t) => [t.label, t.playedHere, t.inSetYear])).toEqual([
      ["New York Yankees", ["Aaron Judge", "Juan Soto"], true],
      ["Los Angeles Angels", ["Mike Trout"], false],
    ]);
    expect(item.suggested).toEqual(["New York Yankees"]);
    expect(item.listingSays).toBeUndefined();
  });

  test("a whole-career fallback is offered, never suggested, with the uncovered year", async () => {
    const store: Store = { rows: { [BASE]: [card("foxx", "50", "Jimmie Foxx", { playerIds: ["p1"] })] } };
    const client = attentionClient({
      store,
      handlers: {
        "cardChecklist:suggestedTeamsForCard": () => [
          suggestion("t-a", "Philadelphia Athletics", "Jimmie Foxx", false, "Philadelphia Athletics · 1901–1954", 2025),
          suggestion("t-rs", "Boston Red Sox", "Jimmie Foxx", false, "Boston Red Sox", 2025),
        ],
        "teams:erasByNameAndSport": (a) =>
          a.name === "Philadelphia Athletics"
            ? [era("t-a", "Athletics", 1901, 1954, "Philadelphia"), era("t-a2", "Athletics", 1955, 1967, "Philadelphia")]
            : [],
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.suggested).toEqual([]);
    expect(item.uncoveredSetYear).toBe(2025);
    expect(item.career!.heading).toBe("No 2025 team on file — here’s the whole career. Pick the one on the card.");
    // A name held in two eras needs its era to be an answer; a unique one is just the name.
    expect(item.career!.teams.map((t) => t.answer)).toEqual([{ name: "Philadelphia Athletics", from: 1901 }, "Boston Red Sox"]);
  });

  test("invariant 8: a listing that names a different team than the set-year stint suggests nothing", async () => {
    const store: Store = {
      rows: { [BASE]: [card("c", "12", "Traded Guy", { playerIds: ["p1"], bscTeamName: "Boston Red Sox", platformData: { bsc: { ref: "b" } }, teamCheckDoneAt: 1 })] },
    };
    const client = attentionClient({
      store,
      handlers: {
        "cardChecklist:suggestedTeamsForCard": () => [suggestion("t-nyy", "New York Yankees", "Traded Guy", true)],
        "teams:erasByNameAndSport": (a) => (a.name === "Boston Red Sox" ? [era("t-bos", "Red Sox", undefined, undefined, "Boston")] : []),
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.listingDisagrees).toBe(true);
    expect(item.suggested).toEqual([]);
    expect(item.listingSays).toEqual({
      name: "Boston Red Sox",
      heading: marketplaceHeading("Boston Red Sox", 1, false),
      teams: [{ team: "Boston Red Sox", label: "Boston Red Sox", answer: "Boston Red Sox", teamId: "t-bos", playedHere: [], inSetYear: false }],
    });
    expect(item.career!.heading).toBe(careerHeading(true, true, undefined));
  });

  test("a listing name held in several eras: every era offered, none suggested, each answer names its era", async () => {
    const store: Store = { rows: { [BASE]: [card("c", "1", "Jets Card", { bscTeamName: "Winnipeg Jets" })] } };
    const client = attentionClient({
      store,
      handlers: {
        "teams:erasByNameAndSport": () => [era("j1", "Jets", 1972, 1996, "Winnipeg"), era("j2", "Jets", 2011, undefined, "Winnipeg")],
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.suggested).toEqual([]);
    expect(item.listingSays!.heading).toBe("The listing names “Winnipeg Jets” — 2 teams share that name. Pick the one on the card.");
    expect(item.listingSays!.teams.map((t) => t.answer)).toEqual([
      { name: "Winnipeg Jets", from: 1972 },
      { name: "Winnipeg Jets", from: 2011 },
    ]);
    expect(item.listingDisagrees).toBe(false);
  });

  test("the listing agrees with the set-year stint: that team is suggested and the line says so", async () => {
    const store: Store = { rows: { [BASE]: [card("c", "1", "Padre", { playerIds: ["p"], bscTeamName: "San Diego Padres" })] } };
    const client = attentionClient({
      store,
      handlers: {
        "cardChecklist:suggestedTeamsForCard": () => [suggestion("t-sd", "San Diego Padres", "Tony Gwynn", true)],
        "teams:erasByNameAndSport": () => [era("t-sd", "Padres", 1969, undefined, "San Diego")],
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.suggested).toEqual(["San Diego Padres"]);
    expect(item.listingSays!.heading).toBe(marketplaceHeading("San Diego Padres", 1, true));
    expect(item.listingSays!.teams[0].playedHere).toEqual(["Tony Gwynn"]);
    // The listing's row carries the career's provenance and is not repeated under the career.
    expect(item.career).toBeUndefined();
  });

  test("never more than eight teams suggested", async () => {
    const store: Store = { rows: { [BASE]: [card("c", "1", "Many", { playerIds: ["p"] })] } };
    const client = attentionClient({
      store,
      handlers: {
        "cardChecklist:suggestedTeamsForCard": () => Array.from({ length: 10 }, (_, i) => suggestion(`t${i}`, `Team ${i}`, `P${i}`, true)),
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.suggested).toHaveLength(8);
  });
});

describe("title facts (TitleFixer)", () => {
  test("bands, the cut-short flag, the trimmed variation and what Regenerate would write", async () => {
    const store: Store = {
      rows: {
        [BASE]: [
          card("t55", "1", "A", { teamOnCardIds: ["t"], listingTitle: "a".repeat(55), listingTitleTruncated: true }),
          card("t70", "2", "B", { teamOnCardIds: ["t"], listingTitle: "b".repeat(70), listingTitleTruncated: true }),
          card("t80", "3", "C", { teamOnCardIds: ["t"], listingTitle: "c".repeat(80), cardVariation: ` ${"v".repeat(66)} ` }),
          card("t81", "4", "D", { teamOnCardIds: ["t"], listingTitle: "d".repeat(81) }),
        ],
      },
    };
    const client = attentionClient({
      store,
      handlers: {
        "selectorOptions:previewListingTitle": () => ({
          title: "2014 Topps Chrome Jose Fernandez #103b",
          coreFits: false,
          dropped: ["Miami Marlins"],
          inputs: { cardNumber: "103b", playerNames: ["Jose Fernandez"], year: "2014", setName: "Topps Chrome", teamNames: ["Miami Marlins"] },
        }),
      },
    });
    const out = await listCardAttention(client, SET);
    const by = Object.fromEntries(out.cards.map((c) => [c.cardId, c]));
    expect(by.t55.title!.band).toBe("mobile");
    expect(by.t55.title!.truncated).toBe(true);
    expect(by.t70.title!.band).toBe("search");
    expect(by.t80.kinds).toEqual(["aspectValueOverLimit"]);
    expect(by.t80.answers).toEqual(["title+variation"]);
    expect(by.t80.variation).toEqual({ current: ` ${"v".repeat(66)} `, length: 66, limit: 65 });
    expect(by.t81.kinds).toEqual(["titleOverLimit"]);
    expect(by.t81.title!.band).toBe("over");
    expect(by.t81.title!.generated).toEqual({
      title: "2014 Topps Chrome Jose Fernandez #103b",
      length: 38,
      coreFits: false,
      dropped: ["Miami Marlins"],
      builtFrom: [
        { label: "Year", value: "2014" },
        { label: "Set", value: "Topps Chrome" },
        { label: "Player", value: "Jose Fernandez" },
        { label: "Number", value: "#103b" },
        { label: "Team", value: "Miami Marlins" },
      ],
    });
  });

  test("a variation of exactly 65 is not flagged; 66 is", async () => {
    const store: Store = {
      rows: {
        [BASE]: [
          card("v65", "1", "A", { teamOnCardIds: ["t"], listingTitle: "ok", cardVariation: "v".repeat(65) }),
          card("v66", "2", "B", { teamOnCardIds: ["t"], listingTitle: "ok", cardVariation: "v".repeat(66) }),
        ],
      },
    };
    const out = await listCardAttention(attentionClient({ store }), SET);
    expect(out.cards.map((c) => c.cardId)).toEqual(["v66"]);
  });
});

describe("enrichment bounds", () => {
  test("summary reads the facts of the first cards only; full reads them all; every card is listed", async () => {
    const many = Array.from({ length: SUMMARY_ENRICH_LIMIT + 5 }, (_, i) => card(`c${i}`, String(i + 1), `Card ${i + 1}`));
    const store: Store = { rows: { [BASE]: many } };
    const client = attentionClient({ store });
    const summary = await listCardAttention(client, SET);
    expect(summary.cards).toHaveLength(SUMMARY_ENRICH_LIMIT + 5);
    expect(summary.enrichment).toEqual({ enriched: SUMMARY_ENRICH_LIMIT, of: SUMMARY_ENRICH_LIMIT + 5 });
    expect(summary.cards[SUMMARY_ENRICH_LIMIT].enriched).toBe(false);
    expect(summary.cards[SUMMARY_ENRICH_LIMIT].players).toBeUndefined();
    expect(client.callsTo("cardChecklist:suggestedTeamsForCard")).toHaveLength(SUMMARY_ENRICH_LIMIT);

    const full = await listCardAttention(attentionClient({ store }), SET, { detail: "full" });
    expect(full.enrichment).toEqual({ enriched: SUMMARY_ENRICH_LIMIT + 5, of: SUMMARY_ENRICH_LIMIT + 5 });
  });

  test('"totals" reads no per-card facts at all: only the checklist walk and the rule', async () => {
    const many = Array.from({ length: 5 }, (_, i) => card(`c${i}`, String(i + 1), `Card ${i + 1}`, { playerIds: ["p"], listingTitle: "x".repeat(81) }));
    const client = attentionClient({ store: { rows: { [BASE]: many } } });
    const out = await listCardAttention(client, SET, { detail: "totals" });
    expect(out.totals.cards).toBe(5);
    expect(out.cards).toHaveLength(5);
    expect(out.cards.every((c) => !c.enriched && c.title!.generated === undefined && c.players === undefined)).toBe(true);
    expect(out.enrichment).toEqual({ enriched: 0, of: 5 });
    expect([...new Set(client.calls.map((c) => c.name))].sort()).toEqual([
      "selectorOptions:getCardChecklist",
      "selectorOptions:getSelectorOptions",
    ]);
  });

  test("a card whose facts fail to read is listed whole but un-enriched, never half-described", async () => {
    const store: Store = { rows: { [BASE]: [card("c", "1", "A", { playerIds: ["p"], listingTitle: "x".repeat(81) })] } };
    const client = attentionClient({
      store,
      handlers: {
        "selectorOptions:previewListingTitle": () => {
          throw new Error("previewListingTitle: no such card");
        },
      },
    });
    const [item] = (await listCardAttention(client, SET)).cards;
    expect(item.enriched).toBe(false);
    expect(item.players).toBeUndefined();
    expect(item.title!.generated).toBeUndefined();
    expect(item.kinds).toEqual(["missingTeam", "titleOverLimit"]);
  });
});

describe("resolveAttentionRow", () => {
  const client = () => attentionClient({ store: { rows: {} } });

  test("omitted is the Base; a Base ref takes no row name", async () => {
    expect((await resolveAttentionRow(client(), SET, undefined, "cards[0]")).rowId).toBe(BASE);
    expect((await resolveAttentionRow(client(), SET, { type: "base" }, "cards[0]")).rowId).toBe(BASE);
    await expect(resolveAttentionRow(client(), SET, { type: "Base", name: "Future Stars" }, "cards[0]")).rejects.toThrow(ResolveError);
  });

  test("a row and a parallel under a type; a row with no type or a type with no row is refused", async () => {
    expect((await resolveAttentionRow(client(), SET, { type: "Inserts", name: "future stars" }, "cards[0]")).rowId).toBe(FUTURE);
    expect((await resolveAttentionRow(client(), SET, { type: "Inserts", name: "Future Stars", parallel: "Gold" }, "cards[0]")).rowId).toBe(GOLD);
    await expect(resolveAttentionRow(client(), SET, { name: "Future Stars" }, "cards[0]")).rejects.toThrow(/variant type/);
    await expect(resolveAttentionRow(client(), SET, { type: "Inserts" }, "cards[0]")).rejects.toThrow(/add "name"/);
    await expect(resolveAttentionRow(client(), SET, { type: "Inserts", name: "Nope" }, "cards[0]")).rejects.toThrow(ResolveError);
  });
});

describe("answerForEra", () => {
  test("the bare name for a lone row, the first year where it is unique, the id where it is not", () => {
    expect(answerForEra("San Diego Padres", "a", [era("a", "Padres", 1969)])).toBe("San Diego Padres");
    expect(answerForEra("Winnipeg Jets", "b", [era("a", "Jets", 1972, 1996), era("b", "Jets", 2011)])).toEqual({ name: "Winnipeg Jets", from: 2011 });
    expect(answerForEra("Twins", "b", [era("a", "Twins", 1901), era("b", "Twins", 1901)])).toEqual({ name: "Twins", id: "b" });
    expect(answerForEra("Twins", "b", [era("a", "Twins"), era("b", "Twins")])).toEqual({ name: "Twins", id: "b" });
  });
});
