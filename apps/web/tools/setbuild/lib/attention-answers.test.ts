import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { ATTENTION_LABELS } from "../../../components/SetSelector/card-attention";
import { ResolveError } from "../service";
import {
  CardAnswerError,
  CardFixAborted,
  applyCardAnswers,
  cardAnswersForDigest,
  foldCardNumber,
  refusalText,
} from "./attention-answers";
import type { CardFixAnswer } from "./attention";
import { BASE, FUTURE, SET, SPORT, attentionClient, card, era, type Store } from "./attention.fixture";

const WRITES = ["selectorOptions:updateCard", "cardChecklist:confirmCardNoTeam", "teams:findOrCreate", "players:findOrCreate"];
const writesOf = (client: ReturnType<typeof attentionClient>) => client.calls.filter((c) => WRITES.includes(c.name));

/** A store with one teamless card #1 on Base (missingTeam). */
const teamless = (): Store => ({ rows: { [BASE]: [card("c1", "1", "Mike Trout", { playerIds: ["p1"], listingTitle: "T" })] } });

const teamsHandlers = {
  "teams:erasByNameAndSport": (a: Record<string, unknown>) =>
    ({
      "Los Angeles Angels": [era("t-laa", "Angels", 1961, undefined, "Los Angeles")],
      "New York Yankees": [era("t-nyy", "Yankees", 1903, undefined, "New York")],
      "Philadelphia Athletics": [era("t-pa1", "Athletics", 1901, 1954, "Philadelphia"), era("t-pa2", "Athletics", 1955, 1967, "Philadelphia")],
    })[a.name as string] ?? [],
  "teams:nearMatches": () => [],
};

describe("card addressing (invariant 7)", () => {
  test("a number on two cards of the row stops with both cardIds, before anything is written", async () => {
    const store: Store = {
      rows: { [BASE]: [card("c-a", "103b", "Jose Fernandez", { listingTitle: "T" }), card("c-b", "103B", "Jose Fernandez Var", { listingTitle: "T" })] },
    };
    const client = attentionClient({ store, handlers: teamsHandlers });
    const err = await applyCardAnswers(client, SET, [{ cardNumber: "103b", answer: { noTeam: true } }]).catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).candidates.map((c) => c.id)).toEqual(["c-a", "c-b"]);
    expect((err as ResolveError).message).toBe("#103b is on 2 cards on Base; add the cardId of the one you mean.");
    expect(writesOf(client)).toEqual([]);

    // The cardId the listing printed settles it.
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "#103b", cardId: "c-b", answer: { noTeam: true } }]);
    expect(r.outcome).toBe("applied");
    expect(client.callsTo("cardChecklist:confirmCardNoTeam").map((c) => c.args)).toEqual([{ cardId: "c-b" }]);
  });

  test("a cardId that is not that number, a number that is nowhere", async () => {
    const client = attentionClient({ store: teamless() });
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "2", cardId: "c1", answer: { noTeam: true } }])).rejects.toThrow(
      "Card c1 on Base is #1, not #2.",
    );
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "99", answer: { noTeam: true } }])).rejects.toThrow("No card numbered #99 on Base.");
  });

  test("one bad answer anywhere in the batch: nothing is written", async () => {
    const client = attentionClient({ store: teamless(), handlers: teamsHandlers });
    await expect(
      applyCardAnswers(client, SET, [
        { cardNumber: "1", answer: { teams: ["Los Angeles Angels"] } },
        { cardNumber: "1", answer: { teams: ["Philadelphia Athletics"] } },
      ]),
    ).rejects.toThrow(ResolveError);
    expect(writesOf(client)).toEqual([]);
  });

  test("a malformed answer is refused before any read", async () => {
    const client = attentionClient({ store: teamless() });
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { noTeam: true, teams: [] } as never }])).rejects.toThrow(CardAnswerError);
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "1", answer: {} as never }])).rejects.toThrow(CardAnswerError);
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { title: 5 } as never }])).rejects.toThrow(CardAnswerError);
    expect(client.calls).toEqual([]);
  });

  test("foldCardNumber folds a leading # and case, nothing else", () => {
    expect(foldCardNumber(" #103B ")).toBe("103b");
    expect(foldCardNumber("BCP-100")).toBe("bcp-100");
    expect(foldCardNumber("1")).not.toBe(foldCardNumber("01"));
  });
});

describe("MissingTeamFixer: { teams } and { noTeam }", () => {
  test("Save writes exactly { id, teamOnCardIds }, deduped, in the answer's order", async () => {
    const store = teamless();
    const client = attentionClient({ store, handlers: teamsHandlers });
    const [r] = await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: ["New York Yankees", "Los Angeles Angels", { name: "Los Angeles Angels", from: 1961 }] } },
    ]);
    expect(client.callsTo("selectorOptions:updateCard").map((c) => c.args)).toEqual([{ id: "c1", teamOnCardIds: ["t-nyy", "t-laa"] }]);
    expect(r).toMatchObject({ outcome: "applied", answered: "teams", detail: "Saved 2 teams on this card.", stillNeeds: [] });
  });

  test("a team name held in several eras is a ResolveError listing every era; { name, from } or { name, id } picks one", async () => {
    const client = attentionClient({ store: teamless(), handlers: teamsHandlers });
    const err = (await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: ["Philadelphia Athletics"] } }]).catch((e) => e)) as ResolveError;
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.candidates.map((c) => c.id)).toEqual(["t-pa1", "t-pa2"]);
    expect(err.at).toBe("cards[0].answer.teams[0]");

    const [byYear] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: [{ name: "Philadelphia Athletics", from: 1955 }] } }]);
    expect(byYear.outcome).toBe("applied");
    expect(client.callsTo("selectorOptions:updateCard").at(-1)!.args).toEqual({ id: "c1", teamOnCardIds: ["t-pa2"] });
  });

  test("an era that is not on file, and a name that is not a team", async () => {
    const client = attentionClient({ store: teamless(), handlers: teamsHandlers });
    await expect(
      applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: [{ name: "Philadelphia Athletics", from: 1990 }] } }]),
    ).rejects.toThrow('No "Philadelphia Athletics" team matches from 1990.');
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: ["Montreal Expos"] } }])).rejects.toThrow(
      'No team named "Montreal Expos" in this sport.',
    );
  });

  test("an alias the sport's teams answer to resolves only when exactly one team does", async () => {
    const client = attentionClient({
      store: teamless(),
      handlers: {
        "teams:erasByNameAndSport": () => [],
        "teams:nearMatches": (a) =>
          a.name === "LSU"
            ? [{ _id: "t-lsu", name: "LSU Tigers", confidence: "exact", matchedAlias: "LSU" }]
            : [
                { _id: "t-1", name: "Tigers A", confidence: "exact" },
                { _id: "t-2", name: "Tigers B", confidence: "exact" },
              ],
      },
    });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: ["LSU"] } }]);
    expect(r.outcome).toBe("applied");
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toEqual({ id: "c1", teamOnCardIds: ["t-lsu"] });
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: ["Tigers"] } }])).rejects.toThrow(ResolveError);
  });

  test("nine teams is refused, never trimmed; none is refused; nothing is written", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `Team ${i}`, id: `t${i}` }));
    const client = attentionClient({
      store: teamless(),
      handlers: { "teams:erasByNameAndSport": (a) => [era(`t${String(a.name).slice(5)}`, String(a.name))] },
    });
    const [over, none] = await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: nine } },
      { cardNumber: "1", answer: { teams: [] } },
    ]);
    expect(over).toMatchObject({ outcome: "refused", detail: "That is the limit of 8 teams on one card." });
    expect(none).toMatchObject({ outcome: "refused", detail: "Pick at least one team, or record that this card has none." });
    expect(writesOf(client)).toEqual([]);
  });

  test("eight teams is the cap, not past it", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `Team ${i}`, id: `t${i}` }));
    const client = attentionClient({
      store: teamless(),
      handlers: { "teams:erasByNameAndSport": (a) => [era(`t${String(a.name).slice(5)}`, String(a.name))] },
    });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: eight } }]);
    expect(r.outcome).toBe("applied");
  });

  test('"No team on this card": confirmed, already confirmed, and refused (confirmed: false) is not counted fixed', async () => {
    const store = teamless();
    const client = attentionClient({ store });
    const [first] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { noTeam: true } }]);
    expect(first).toMatchObject({ outcome: "applied", detail: "Recorded: no team on this card.", stillNeeds: [] });

    // The card no longer asks: a second "no team" is moot, never re-sent.
    const [again] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { noTeam: true } }]);
    expect(again).toMatchObject({ outcome: "moot", detail: `Already settled: this card is no longer flagged “${ATTENTION_LABELS.missingTeam}”.` });
    expect(client.callsTo("cardChecklist:confirmCardNoTeam")).toHaveLength(1);

    // A race: the background lookup linked a team between the read and the write.
    const raced = attentionClient({ store: teamless(), handlers: { "cardChecklist:confirmCardNoTeam": () => ({ confirmed: false, stamped: false }) } });
    const [refused] = await applyCardAnswers(raced, SET, [{ cardNumber: "1", answer: { noTeam: true } }]);
    expect(refused).toMatchObject({
      outcome: "refused",
      detail: "This card has teams now, or it is no longer on this checklist — nothing to confirm.",
    });

    const stamped = attentionClient({ store: teamless(), handlers: { "cardChecklist:confirmCardNoTeam": () => ({ confirmed: true, stamped: false }) } });
    expect((await applyCardAnswers(stamped, SET, [{ cardNumber: "1", answer: { noTeam: true } }]))[0]).toMatchObject({
      outcome: "applied",
      detail: "Already recorded: no team on this card.",
    });
  });

  test("players are not asked on a teamless card", async () => {
    const client = attentionClient({ store: teamless(), handlers: { "players:nearMatches": () => [{ _id: "p9", name: "Someone", confidence: "exact" }] } });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: ["Someone"] } }]);
    expect(r).toMatchObject({ outcome: "refused", detail: "This card needs a team, not a player; answer with teams, or noTeam." });
    expect(writesOf(client)).toEqual([]);
  });

  test("a New Team create: findOrCreate with Location and Name split, league only when named, then the card write", async () => {
    const minted: Record<string, unknown>[] = [];
    const client = attentionClient({
      store: teamless(),
      handlers: {
        ...teamsHandlers,
        "teams:findOrCreate": (a) => {
          minted.push(a);
          return "t-new";
        },
      },
    });
    const [r] = await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: [{ create: { location: "Wisconsin", name: "Badgers", league: "Big Ten" } }, { create: { name: "Unattached" } }] } },
    ]);
    expect(minted).toEqual([
      { name: "Badgers", sportId: SPORT, location: "Wisconsin", leagueName: "Big Ten" },
      { name: "Unattached", sportId: SPORT },
    ]);
    expect(r.created).toEqual([
      { kind: "team", name: "Wisconsin Badgers", id: "t-new", existed: false },
      { kind: "team", name: "Unattached", id: "t-new", existed: false },
    ]);
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toEqual({ id: "c1", teamOnCardIds: ["t-new"] });
  });

  test("a create whose name is already a team reports existed; one held in several eras is refused up front", async () => {
    const client = attentionClient({ store: teamless(), handlers: { ...teamsHandlers, "teams:findOrCreate": () => "t-laa" } });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: [{ create: { location: "Los Angeles", name: "Angels" } }] } }]);
    expect(r.created).toEqual([{ kind: "team", name: "Los Angeles Angels", id: "t-laa", existed: true }]);

    const err = (await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: [{ create: { location: "Philadelphia", name: "Athletics" } }] } },
    ]).catch((e) => e)) as ResolveError;
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.candidates.map((c) => c.id)).toEqual(["t-pa1", "t-pa2"]);
  });

  test("the server refusing a create refuses the answer and writes no card", async () => {
    const client = attentionClient({
      store: teamless(),
      handlers: {
        ...teamsHandlers,
        "teams:findOrCreate": () => {
          throw new ConvexError({ code: "TEAM_ERA_EXISTS", eras: [{ id: "x", years: "1901–1954" }] });
        },
      },
    });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: [{ create: { location: "Kansas City", name: "Monarchs" } }] } }]);
    expect(r).toMatchObject({
      outcome: "refused",
      detail: '"Kansas City Monarchs" already names a team in this sport (1901–1954); answer with that team instead of creating one.',
    });
    expect(client.callsTo("selectorOptions:updateCard")).toEqual([]);
  });
});

describe("UnreviewedNameFixer: { players?, teams? }", () => {
  const typedBoth = (): Store => ({
    rows: { [BASE]: [card("c1", "1", "Typed", { pendingPlayerNames: ["Yordan Alvrez"], pendingTeamNames: ["Astors"], listingTitle: "T" })] },
  });
  const players = {
    "players:nearMatches": (a: Record<string, unknown>) =>
      ({
        "Yordan Alvarez": [{ _id: "p-ya", name: "Yordan Alvarez", confidence: "exact", birthYear: 1997 }],
        "Will Smith": [
          { _id: "p-ws1", name: "Will Smith", confidence: "exact", birthYear: 1989 },
          { _id: "p-ws2", name: "Will Smith", confidence: "exact", birthYear: 1995 },
        ],
      })[a.name as string] ?? [],
    "teams:erasByNameAndSport": (a: Record<string, unknown>) => (a.name === "Houston Astros" ? [era("t-hou", "Astros", 1962, undefined, "Houston")] : []),
  };

  test("clearsCard: linking one side while the other still has typed names is refused, nothing written", async () => {
    const client = attentionClient({ store: typedBoth(), handlers: players });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: ["Houston Astros"] } }]);
    expect(r).toMatchObject({ outcome: "refused", answered: "players+teams", detail: "Link a player to clear this card." });
    expect(writesOf(client)).toEqual([]);
  });

  test("one write links both sides and retires both typed lists", async () => {
    const client = attentionClient({ store: typedBoth(), handlers: players });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: ["Yordan Alvarez"], teams: ["Houston Astros"] } }]);
    expect(client.callsTo("selectorOptions:updateCard").map((c) => c.args)).toEqual([
      { id: "c1", playerIds: ["p-ya"], teamOnCardIds: ["t-hou"], pendingPlayerNames: [], pendingTeamNames: [] },
    ]);
    expect(r).toMatchObject({ outcome: "applied", detail: "Linked 1 player and 1 team to this card.", stillNeeds: [] });
  });

  test("a side left out keeps the card's links (the picker is seeded from the row)", async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Typed", { pendingPlayerNames: ["Yordan Alvrez"], teamOnCardIds: ["t-keep"], listingTitle: "T" })] } };
    const client = attentionClient({ store, handlers: players });
    await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: ["Yordan Alvarez"] } }]);
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toEqual({
      id: "c1",
      playerIds: ["p-ya"],
      teamOnCardIds: ["t-keep"],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });

  test("a shared player name needs a birthYear; the birthYear picks one", async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Typed", { pendingPlayerNames: ["Will Smith"], teamOnCardIds: ["t"], listingTitle: "T" })] } };
    const client = attentionClient({ store, handlers: players });
    const err = (await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: ["Will Smith"] } }]).catch((e) => e)) as ResolveError;
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.message).toBe('"Will Smith" matches 2 player rows; add the birthYear of the one you mean (born 1989, 1995).');
    expect(writesOf(client)).toEqual([]);

    await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: [{ link: "Will Smith", birthYear: 1995 }] } }]);
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toMatchObject({ playerIds: ["p-ws2"] });
  });

  test('a player "create" over a shared name needs a birthYear first; one over a unique name reports existed', async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Typed", { pendingPlayerNames: ["Will Smith"], teamOnCardIds: ["t"], listingTitle: "T" })] } };
    const client = attentionClient({ store, handlers: { ...players, "players:findOrCreate": () => "p-ya" } });
    await expect(applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: [{ create: "Will Smith" }] } }])).rejects.toThrow(ResolveError);
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: [{ create: "Yordan Alvarez" }] } }]);
    expect(r.created).toEqual([{ kind: "player", name: "Yordan Alvarez", id: "p-ya", existed: true }]);
    expect(client.callsTo("players:findOrCreate")[0].args).toEqual({ name: "Yordan Alvarez", sportId: SPORT });
  });

  test("a { teams } answer on a card whose only gap is a typed team goes through the names fixer", async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Typed", { playerIds: ["p1"], pendingTeamNames: ["Astors"], listingTitle: "T" })] } };
    // A pending team name counts as having a team, so this card is unreviewedName, not missingTeam.
    const client = attentionClient({ store, handlers: players });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: ["Houston Astros"] } }]);
    expect(r.answered).toBe("players+teams");
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toEqual({
      id: "c1",
      playerIds: ["p1"],
      teamOnCardIds: ["t-hou"],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });
});

describe("TitleFixer: { title, variation? }", () => {
  const titled = (extra: Record<string, unknown> = {}): Store => ({
    rows: { [BASE]: [card("c1", "1", "Long", { teamOnCardIds: ["t"], listingTitle: "x".repeat(90), ...extra })] },
  });

  test("80 characters is written; 81 is refused in the server's sentence before the write", async () => {
    const client = attentionClient({ store: titled() });
    const [ok] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { title: "a".repeat(80) } }]);
    expect(ok).toMatchObject({ outcome: "applied", detail: "Saved the title on this card.", stillNeeds: [] });
    expect(client.callsTo("selectorOptions:updateCard").map((c) => c.args)).toEqual([{ id: "c1", listingTitle: "a".repeat(80) }]);

    const over = attentionClient({ store: titled() });
    const [refused] = await applyCardAnswers(over, SET, [{ cardNumber: "1", answer: { title: "b".repeat(81) } }]);
    expect(refused).toMatchObject({ outcome: "refused", detail: "Listing title is 81 characters; the limit is 80." });
    expect(writesOf(over)).toEqual([]);
  });

  test("measured trimmed, as the server measures it; blank is refused", async () => {
    const client = attentionClient({ store: titled() });
    const [r, blank] = await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { title: `  ${"a".repeat(80)}  ` } },
      { cardNumber: "1", answer: { title: "   " } },
    ]);
    expect(r.outcome).toBe("applied");
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toEqual({ id: "c1", listingTitle: "a".repeat(80) });
    // The first answer cleared the title: the second is moot, not a blank write.
    expect(blank).toMatchObject({ outcome: "moot", detail: "Already settled: this card's title no longer needs attention." });

    const fresh = attentionClient({ store: titled() });
    expect((await applyCardAnswers(fresh, SET, [{ cardNumber: "1", answer: { title: "   " } }]))[0]).toMatchObject({
      outcome: "refused",
      detail: "A card title can't be blank.",
    });
  });

  test("a variation of 65 writes clean; 66 is WRITTEN with a warning and the card stays flagged", async () => {
    const store = titled({ cardVariation: "v".repeat(70), listingTitle: "ok" });
    const client = attentionClient({ store });
    const [at65] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { title: "ok", variation: "w".repeat(65) } }]);
    expect(at65).toMatchObject({ outcome: "applied", answered: "title+variation", detail: "Saved the title and variation on this card." });
    expect(at65.warning).toBeUndefined();

    const store2 = titled({ cardVariation: "v".repeat(70), listingTitle: "ok" });
    const client2 = attentionClient({ store: store2 });
    const [at66] = await applyCardAnswers(client2, SET, [{ cardNumber: "1", answer: { title: "ok", variation: `${"w".repeat(66)} ` } }]);
    expect(client2.callsTo("selectorOptions:updateCard")[0].args).toEqual({ id: "c1", listingTitle: "ok", cardVariation: "w".repeat(66) });
    expect(at66).toMatchObject({
      outcome: "applied",
      warning: "Variation is 66 characters — 1 over the 65-character limit. Saved anyway; a marketplace that caps this field will reject the value.",
      stillNeeds: [ATTENTION_LABELS.aspectValueOverLimit],
    });
  });

  test("a variation on a card not flagged for one is refused", async () => {
    const client = attentionClient({ store: titled() });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { title: "ok", variation: "Gold Refractor" } }]);
    expect(r).toMatchObject({ outcome: "refused", detail: "This card's variation is not flagged; send the title alone." });
    expect(writesOf(client)).toEqual([]);
  });

  test("an unchanged cut-short title is written as the fixer would, and the card is reported still flagged", async () => {
    const client = attentionClient({ store: titled({ listingTitle: "Cut", listingTitleTruncated: true }) });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { title: "Cut" } }]);
    expect(r).toMatchObject({ outcome: "applied", stillNeeds: [ATTENTION_LABELS.titleTruncated] });
  });

  test("a title answer for a card whose title is fine is moot", async () => {
    const client = attentionClient({ store: teamless() });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { title: "New" } }]);
    expect(r.outcome).toBe("moot");
    expect(writesOf(client)).toEqual([]);
  });
});

describe("a batch", () => {
  test("answers apply in order against the card as it stands: a team, then the same card's title", async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Both", { listingTitle: "x".repeat(85) })] } };
    const client = attentionClient({ store, handlers: teamsHandlers });
    const results = await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: ["Los Angeles Angels"] } },
      { cardNumber: "1", answer: { title: "2014 Topps Chrome Mike Trout #1" } },
      { cardNumber: "1", answer: { noTeam: true } },
    ]);
    expect(results.map((r) => [r.at, r.outcome])).toEqual([
      ["cards[0]", "applied"],
      ["cards[1]", "applied"],
      ["cards[2]", "moot"],
    ]);
    expect(results.every((r) => r.stillNeeds?.length === 0)).toBe(true);
    // Re-read after each write that touched the row, so each gate saw the card as it then stood.
    expect(client.callsTo("selectorOptions:getCardChecklist").length).toBeGreaterThanOrEqual(3);
  });

  test("a server refusal is a result and the batch goes on; any other failure stops with the results so far", async () => {
    const store: Store = {
      rows: { [BASE]: [card("c1", "1", "A", { listingTitle: "x".repeat(85), teamOnCardIds: ["t"] }), card("c2", "2", "B", { listingTitle: "T" })] },
    };
    let calls = 0;
    const client = attentionClient({
      store,
      handlers: {
        "selectorOptions:updateCard": () => {
          calls += 1;
          throw new ConvexError("updateCard: no such card");
        },
      },
    });
    const results = await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { title: "short" } },
      { cardNumber: "2", answer: { noTeam: true } },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["refused", "applied"]);
    expect(results[0].detail).toBe("updateCard: no such card");
    expect(calls).toBe(1);

    const broken = attentionClient({
      store: { rows: { [BASE]: [card("c1", "1", "A"), card("c2", "2", "B")] } },
      handlers: {
        "cardChecklist:confirmCardNoTeam": (a) => {
          if (a.cardId === "c2") throw new Error("socket closed");
          return { confirmed: true, stamped: true };
        },
      },
    });
    const err = (await applyCardAnswers(broken, SET, [
      { cardNumber: "1", answer: { noTeam: true } },
      { cardNumber: "2", answer: { noTeam: true } },
    ]).catch((e) => e)) as CardFixAborted;
    expect(err).toBeInstanceOf(CardFixAborted);
    expect(err.results.map((r) => [r.card.cardId, r.outcome])).toEqual([["c1", "applied"]]);
    expect(err.message).toBe("cards[1]: stopped after 1 answer(s): socket closed");
  });

  test("a card on an insert row and on a parallel are addressed by their row", async () => {
    const store: Store = { rows: { [FUTURE]: [card("f1", "FS-1", "Future", { listingTitle: "T" })] } };
    const client = attentionClient({ store });
    const [r] = await applyCardAnswers(client, { set: SET, path: {} }, [
      { row: { type: "Inserts", name: "Future Stars" }, cardNumber: "FS-1", answer: { noTeam: true } },
    ]);
    expect(r.card).toEqual({ row: { type: "Inserts", name: "Future Stars" }, rowLabel: "Inserts › Future Stars", cardNumber: "FS-1", cardName: "Future", cardId: "f1" });
    expect(r.outcome).toBe("applied");
  });
});

describe("cardAnswersForDigest", () => {
  const answers: CardFixAnswer[] = [
    { cardNumber: "1", answer: { teams: ["Los Angeles Angels", { name: "Philadelphia Athletics", from: 1901 }, { create: { name: "Badgers", location: "Wisconsin" } }] } },
    { row: { type: "Inserts", name: "Future Stars" }, cardNumber: "FS-1", cardId: "f1", answer: { title: "T", variation: "V" } },
    { cardNumber: "2", answer: { noTeam: true } },
    { cardNumber: "3", answer: { players: ["A", { link: "B", birthYear: 1990 }, { create: "C" }] } },
  ];

  test("every field present, nulls for what was left out, text exactly as given", () => {
    expect(cardAnswersForDigest(answers)).toEqual([
      {
        row: null,
        cardNumber: "1",
        cardId: null,
        answer: {
          players: null,
          teams: [
            "Los Angeles Angels",
            { name: "Philadelphia Athletics", from: 1901, id: null },
            { create: { location: "Wisconsin", name: "Badgers", league: null } },
          ],
        },
      },
      { row: { type: "Inserts", name: "Future Stars", parallel: null }, cardNumber: "FS-1", cardId: "f1", answer: { title: "T", variation: "V" } },
      { row: null, cardNumber: "2", cardId: null, answer: { noTeam: true } },
      {
        row: null,
        cardNumber: "3",
        cardId: null,
        answer: { players: ["A", { link: "B", birthYear: 1990 }, { create: "C", birthYear: null }], teams: null },
      },
    ]);
  });

  test("a different title, or a trailing space, is a different digest input", () => {
    const a = cardAnswersForDigest([{ cardNumber: "1", answer: { title: "T" } }]);
    const b = cardAnswersForDigest([{ cardNumber: "1", answer: { title: "T " } }]);
    expect(a).not.toEqual(b);
  });
});

describe("refusalText", () => {
  test("a ConvexError string, a code, a plain message's first line", () => {
    expect(refusalText(new ConvexError("Listing title is 81 characters; the limit is 80."))).toBe("Listing title is 81 characters; the limit is 80.");
    expect(refusalText(new ConvexError({ code: "SOMETHING" }))).toBe("Refused (SOMETHING).");
    expect(refusalText(new Error("first\nsecond"))).toBe("first");
  });
});
