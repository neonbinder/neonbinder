import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { ATTENTION_LABELS } from "../../../components/SetSelector/card-attention";
import { ResolveError } from "../service";
import {
  AUTOGRAPH_WAIT_MS,
  AutographFixAborted,
  CardAnswerError,
  CardFixAborted,
  applyAutographAnswers,
  applyCardAnswers,
  foldCardNumber,
  refusalText,
  resolveAutographAnswers,
} from "./attention-answers";
import { listCardAttention } from "./attention";
import { BASE, FUTURE, GOLD, SET, SPORT, attentionClient, card, cascade, era, type Store } from "./attention.fixture";

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
          return `t-new-${minted.length}`;
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
      { kind: "team", name: "Wisconsin Badgers", id: "t-new-1" },
      { kind: "team", name: "Unattached", id: "t-new-2" },
    ]);
    expect(client.callsTo("selectorOptions:updateCard")[0].args).toEqual({ id: "c1", teamOnCardIds: ["t-new-1", "t-new-2"] });
  });

  test("a team create never links: a name on file (one era, several, or an alias) is refused up front, nothing written", async () => {
    const client = attentionClient({
      store: teamless(),
      handlers: {
        ...teamsHandlers,
        "teams:nearMatches": (a) =>
          a.name === "Louisiana State Tigers" ? [{ _id: "t-lsu", name: "LSU Tigers", confidence: "exact", matchedAlias: "Louisiana State Tigers" }] : [],
        "teams:findOrCreate": () => "t-laa",
      },
    });
    // One era: find-or-create would hand back the Angels.
    const one = (await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: [{ create: { location: "Los Angeles", name: "Angels" } }] } },
    ]).catch((e) => e)) as ResolveError;
    expect(one).toBeInstanceOf(ResolveError);
    expect(one.candidates.map((c) => c.id)).toEqual(["t-laa"]);
    expect(one.message).toBe(
      '"Los Angeles Angels" is already a team in this sport; answer with "Los Angeles Angels" to put that team on the card instead of creating one.',
    );

    const several = (await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: [{ create: { location: "Philadelphia", name: "Athletics" } }] } },
    ]).catch((e) => e)) as ResolveError;
    expect(several.candidates.map((c) => c.id)).toEqual(["t-pa1", "t-pa2"]);

    const alias = (await applyCardAnswers(client, SET, [
      { cardNumber: "1", answer: { teams: [{ create: { location: "Louisiana State", name: "Tigers" } }] } },
    ]).catch((e) => e)) as ResolveError;
    expect(alias.candidates.map((c) => c.id)).toEqual(["t-lsu"]);
    expect(alias.message).toBe('"Louisiana State Tigers" is already a name of a team in this sport; answer with that team instead of creating one.');
    expect(writesOf(client)).toEqual([]);
  });

  test("a team create the server answers with a row that was on file is refused, and the card is not written", async () => {
    let created = false;
    const client = attentionClient({
      store: teamless(),
      handlers: {
        // Nothing on file while resolving; another session creates it before the write.
        "teams:erasByNameAndSport": () => (created ? [era("t-race", "Monarchs", 1920, 1965, "Kansas City")] : []),
        // The last read while resolving; from then on the team is on file.
        "teams:nearMatches": () => {
          created = true;
          return [];
        },
        "teams:findOrCreate": () => "t-race",
      },
    });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { teams: [{ create: { location: "Kansas City", name: "Monarchs" } }] } }]);
    expect(r).toMatchObject({
      outcome: "refused",
      detail: '"Kansas City Monarchs" is already a team in this sport; answer with that team instead of creating one.',
    });
    expect(r.created).toBeUndefined();
    expect(client.callsTo("selectorOptions:updateCard")).toEqual([]);
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

  test('a player "create" never links: every case where find-or-create would hand back a player on file is refused up front', async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Typed", { pendingPlayerNames: ["Will Smith"], teamOnCardIds: ["t"], listingTitle: "T" })] } };
    const client = attentionClient({
      store,
      handlers: {
        ...players,
        "players:nearMatches": (a) =>
          ({
            "Yordan Alvarez": [{ _id: "p-ya", name: "Yordan Alvarez", confidence: "exact", birthYear: 1997 }],
            "Will Smith": [
              { _id: "p-ws1", name: "Will Smith", confidence: "exact", birthYear: 1989 },
              { _id: "p-ws2", name: "Will Smith", confidence: "exact", birthYear: 1995 },
            ],
            "Bob Jones": [
              { _id: "p-bj1", name: "Bob Jones", confidence: "exact", birthYear: 1950 },
              { _id: "p-bj2", name: "Bob Jones", confidence: "exact" },
            ],
          })[a.name as string] ?? [],
        "players:findOrCreate": () => "p-new",
      },
    });
    const refusal = async (create: string, birthYear?: number) =>
      (await applyCardAnswers(client, SET, [
        { cardNumber: "1", answer: { players: [{ create, ...(birthYear !== undefined ? { birthYear } : {}) }] } },
      ]).catch((e) => e)) as ResolveError;

    // Exactly one same-name player: the server links it, whatever birthYear says.
    for (const by of [undefined, 2001]) {
      const one = await refusal("Yordan Alvarez", by);
      expect(one).toBeInstanceOf(ResolveError);
      expect(one.candidates.map((c) => c.id)).toEqual(["p-ya"]);
      expect(one.message).toBe('"Yordan Alvarez" is already a player in this sport; link that player with { "link": "Yordan Alvarez" } instead of creating one.');
    }
    // Several, no birthYear: the server refuses; say so first.
    expect((await refusal("Will Smith")).message).toBe(
      '"Will Smith" already names 2 players; link one with { "link", "birthYear" } (born 1989, 1995), or add the new player\'s birthYear.',
    );
    // Several, one born that year: the server links it.
    const year = await refusal("Will Smith", 1995);
    expect(year.candidates.map((c) => c.id)).toEqual(["p-ws1", "p-ws2"]);
    expect(year.message).toBe('A player named "Will Smith" born 1995 is already on file; link that player with { "link", "birthYear" } instead of creating one.');
    // Several, one undated: it could be the same man.
    expect((await refusal("Bob Jones", 1990)).message).toBe(
      '"Bob Jones" already names 2 players and one has no birth year on file, so a new one cannot be told apart from it; link one with { "link", "birthYear" }.',
    );
    expect(writesOf(client)).toEqual([]);

    // Several, all dated, none that year: a real create.
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: [{ create: "Will Smith", birthYear: 2001 }] } }]);
    expect(r.created).toEqual([{ kind: "player", name: "Will Smith", id: "p-new" }]);
    expect(client.callsTo("players:findOrCreate")[0].args).toEqual({ name: "Will Smith", sportId: SPORT, birthYear: 2001 });
  });

  test("a player create the server answers with a player on file is refused, and the card is not written", async () => {
    const store: Store = { rows: { [BASE]: [card("c1", "1", "Typed", { pendingPlayerNames: ["Will Smith"], teamOnCardIds: ["t"], listingTitle: "T" })] } };
    const client = attentionClient({ store, handlers: { ...players, "players:findOrCreate": () => "p-ws1" } });
    const [r] = await applyCardAnswers(client, SET, [{ cardNumber: "1", answer: { players: [{ create: "Will Smith", birthYear: 2001 }] } }]);
    expect(r).toMatchObject({
      outcome: "refused",
      detail: '"Will Smith" is already a player in this sport; link that player with { "link", "birthYear" } instead of creating one.',
    });
    expect(client.callsTo("selectorOptions:updateCard")).toEqual([]);
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

describe("refusalText", () => {
  test("a ConvexError string, a code, a plain message's first line", () => {
    expect(refusalText(new ConvexError("Listing title is 81 characters; the limit is 80."))).toBe("Listing title is 81 characters; the limit is 80.");
    expect(refusalText(new ConvexError({ code: "SOMETHING" }))).toBe("Refused (SOMETHING).");
    expect(refusalText(new Error("first\nsecond"))).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// NEO-345 — the header's "on card or sticker?", answered per row
// ---------------------------------------------------------------------------

describe("applyAutographAnswers", () => {
  const au = (id: string, n: string, extra: Record<string, unknown> = {}) =>
    card(id, n, `Auto ${n}`, { teamOnCardIds: ["t"], listingTitle: "T", attributes: ["AU"], ...extra });
  const FS = { type: "Inserts", name: "Future Stars" };
  /** Future Stars: two AU cards still None, one plain card. */
  const autos = (): Store => ({ rows: { [FUTURE]: [au("f1", "FS-1"), au("f2", "FS-2", { features: { autographed: "None" } }), card("f3", "FS-3", "Plain", { teamOnCardIds: ["t"], listingTitle: "T" })] } });
  const fast = { waitMs: 5_000, pollMs: 1_000, sleep: async () => {} };
  const writes = (c: ReturnType<typeof attentionClient>) => c.callsTo("autographFormat:setAutographFormat").map((x) => x.args);

  test("saves the row's format through the prompt's own mutation and waits until its AU cards are marked", async () => {
    const store = autos();
    const client = attentionClient({ store, cascadeAfter: 2 });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], fast);
    expect(writes(client)).toEqual([{ selectorOptionId: FUTURE, value: "On Card" }]);
    expect(r).toMatchObject({
      at: "autographs[0]",
      row: FS,
      rowLabel: "Inserts › Future Stars",
      rowId: FUTURE,
      format: "On Card",
      outcome: "applied",
      detail: "Autographs saved as on card. 2 cards on Inserts › Future Stars now marked on card. Its parallel takes the same answer.",
      parallels: { count: 1 },
    });
    expect(r.warning).toBeUndefined();
    // The row no longer asks.
    expect((await listCardAttention(client, SET)).autographs).toEqual([]);
  });

  test("a wait that runs out is said, with how many cards are still unmarked; the answer stands", async () => {
    let t = 0;
    const client = attentionClient({ store: autos(), cascadeAfter: "never" });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "Sticker/Label" }], {
      waitMs: 3_000,
      pollMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.outcome).toBe("applied");
    expect(r.detail).toBe("Autographs saved as sticker. Its parallel takes the same answer.");
    expect(r.stillUnformatted).toBe(2);
    expect(r.warning).toBe(
      "2 autographed cards on Inserts › Future Stars still show no format after 3s; the server is still marking them. List attention again shortly.",
    );
    // Bounded: the first look, then one per poll until the budget.
    expect(client.callsTo("selectorOptions:getCardChecklist").length).toBeLessThanOrEqual(1 + 4 + 1);
  });

  test("one wait for the whole call, not one per row", async () => {
    let t = 0;
    const store: Store = { rows: { [BASE]: [au("b1", "1")], [FUTURE]: [au("f1", "FS-1")] } };
    const client = attentionClient({ store, cascadeAfter: "never" });
    const results = await applyAutographAnswers(client, SET, [{ format: "On Card" }, { row: FS, format: "On Card" }], {
      waitMs: 2_000,
      pollMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(results.map((r) => r.stillUnformatted)).toEqual([1, 1]);
    expect(t).toBe(2_000);
    expect(AUTOGRAPH_WAIT_MS).toBeLessThanOrEqual(30_000);
  });

  test("a row that already has a format is moot (same or different), and nothing is written", async () => {
    const store: Store = { ...autos(), leafFeatures: { [FUTURE]: { autographFormat: "Sticker/Label" } } };
    const client = attentionClient({ store });
    const results = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], fast);
    expect(results[0]).toMatchObject({
      outcome: "moot",
      detail: "Already settled: Inserts › Future Stars's autographs are marked sticker. If that is wrong, change it in Set details.",
    });
    const same = await applyAutographAnswers(client, SET, [{ row: FS, format: "Sticker/Label" }], fast);
    expect(same[0]).toMatchObject({ outcome: "moot", detail: "Already settled: Inserts › Future Stars's autographs are marked sticker." });
    expect(writes(client)).toEqual([]);
  });

  test("a row whose autographed cards are all marked is moot: the header no longer asks", async () => {
    const store: Store = { rows: { [FUTURE]: [au("f1", "FS-1", { features: { autographed: "On Card" } })] } };
    const client = attentionClient({ store });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], fast);
    expect(r).toMatchObject({ outcome: "moot", detail: "Already settled: no autographed card on Inserts › Future Stars is waiting for a format." });
    expect(writes(client)).toEqual([]);
  });

  test("the server's refusal is a result, in its own words", async () => {
    const client = attentionClient({
      store: autos(),
      handlers: {
        "autographFormat:setAutographFormat": () => {
          throw new ConvexError("That row is gone. Refresh and try again.");
        },
      },
    });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], fast);
    expect(r).toMatchObject({ outcome: "refused", detail: "That row is gone. Refresh and try again." });
  });

  test("resolve first: an unknown row throws with candidates and nothing is written; a row answered twice is refused before any write", async () => {
    const client = attentionClient({ store: autos() });
    await expect(applyAutographAnswers(client, SET, [{ row: { type: "Inserts", name: "Nope" }, format: "On Card" }], fast)).rejects.toBeInstanceOf(ResolveError);
    const twice = applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }, { row: FS, format: "Sticker/Label" }], fast);
    await expect(twice).rejects.toBeInstanceOf(CardAnswerError);
    await expect(resolveAutographAnswers(client, SET, [{ row: FS, format: "On Card" }, { row: FS, format: "Sticker/Label" }])).rejects.toThrow(
      "autographs[1]: Inserts › Future Stars is answered at autographs[0] too. Answer each row once.",
    );
    await expect(resolveAutographAnswers(client, SET, [{ row: FS, format: "on card" as never }])).rejects.toThrow('"format" is "On Card" or "Sticker/Label".');
    expect(writes(client)).toEqual([]);
  });

  test("a row that is gone by the time it is answered is moot, and nothing is written", async () => {
    const client = attentionClient({ store: autos(), handlers: { "selectorOptions:getSelectorOptionById": () => null } });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], fast);
    expect(r).toMatchObject({ outcome: "moot", detail: "Already settled: this row is no longer in the set." });
    expect(writes(client)).toEqual([]);
  });

  test("a re-read that fails during the wait keeps the answer and says the cards were not checked", async () => {
    let t = 0;
    const store = autos();
    const client = attentionClient({ store, cascadeAfter: "never" });
    let reads = 0;
    client.on("selectorOptions:getCardChecklist", (a) => {
      // The pre-write read answers; every read after the write fails.
      if (++reads > 1) throw new Error("Convex is down");
      return store.rows[String(a.selectorOptionId)] ?? [];
    });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], {
      waitMs: 2_000,
      pollMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(writes(client)).toEqual([{ selectorOptionId: FUTURE, value: "On Card" }]);
    expect(r.outcome).toBe("applied");
    expect(r.detail).toBe("Autographs saved as on card. Its parallel takes the same answer.");
    expect(r.warning).toBe(
      "Saved, but Inserts › Future Stars could not be read back to check its cards; list attention again shortly. Its parallel could not be read back to check its cards; list attention again shortly.",
    );
    expect(r.stillUnformatted).toBeUndefined();
  });

  test("a row whose only waiting AU cards are guests is answered, and the wait is skipped: their home rows keep their own", async () => {
    const guest = au("g1", "FS-9", { isCrossListed: true, homeSetLabel: "2014 Topps" });
    const store: Store = { rows: { [FUTURE]: [guest] } };
    const client = attentionClient({ store });
    let sleeps = 0;
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "Sticker/Label" }], {
      ...fast,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(writes(client)).toEqual([{ selectorOptionId: FUTURE, value: "Sticker/Label" }]);
    expect(r).toMatchObject({
      outcome: "applied",
      detail:
        "Autographs saved as sticker. Its autographed cards here are listed from other sets, which keep their own format. Its parallel takes the same answer.",
    });
    expect(r.warning).toBeUndefined();
    expect(sleeps).toBe(0);
    // The guest is not this row's to mark.
    expect((guest as { features?: unknown }).features).toBeUndefined();
  });

  test("a failure that is not a refusal stops the run and reports every row saved before it (deepest row first)", async () => {
    const store: Store = { rows: { [BASE]: [au("b1", "1")], [GOLD]: [au("g1", "FS-1")] } };
    const client = attentionClient({ store });
    let n = 0;
    client.on("autographFormat:setAutographFormat", (a) => {
      if (++n === 2) throw new Error("network down");
      store.leafFeatures = { ...(store.leafFeatures ?? {}), [String(a.selectorOptionId)]: { autographFormat: String(a.value) } };
      return null;
    });
    const err = await applyAutographAnswers(client, SET, [{ format: "On Card" }, { row: { ...FS, parallel: "Gold" }, format: "On Card" }], fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutographFixAborted);
    const aborted = err as AutographFixAborted;
    // Gold (the deeper row) is written first; the Base write is the one that fails.
    expect(writes(client).map((w) => w.selectorOptionId)).toEqual([GOLD, BASE]);
    expect(aborted.results.map((r) => [r.at, r.outcome])).toEqual([["autographs[1]", "applied"]]);
    expect(aborted.results[0].warning).toBe("The run stopped before this row's cards were checked; list attention again.");
    expect(aborted.message).toContain("autographs[0]: stopped after 1 answer(s): network down");
  });
  // Jason, 2026-10-18 — an insert's answer reaches its parallels whose own format is unset.
  test("an insert's answer reaches its parallel: the wait covers the parallel's AU cards too", async () => {
    const store: Store = { rows: { [FUTURE]: [au("f1", "FS-1")], [GOLD]: [au("g1", "FS-1"), au("g2", "FS-2")] } };
    const client = attentionClient({ store, cascadeAfter: 1 });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "Sticker/Label" }], fast);
    expect(writes(client)).toEqual([{ selectorOptionId: FUTURE, value: "Sticker/Label" }]);
    expect(r).toMatchObject({
      outcome: "applied",
      detail: "Autographs saved as sticker. 1 card on Inserts › Future Stars now marked sticker. Its parallel takes the same answer.",
      parallels: { count: 1 },
    });
    expect(r.warning).toBeUndefined();
    expect(store.leafFeatures?.[GOLD]?.autographFormat).toBe("Sticker/Label");
    expect(store.rows[GOLD].map((c) => (c.features as Record<string, string>).autographed)).toEqual(["Sticker/Label", "Sticker/Label"]);
    // Neither row asks any more.
    expect((await listCardAttention(client, SET)).autographs).toEqual([]);
  });

  test("a parallel's cards the wait did not see marked are said on the insert's result", async () => {
    let t = 0;
    const store: Store = { rows: { [FUTURE]: [au("f1", "FS-1")], [GOLD]: [au("g1", "FS-1"), au("g2", "FS-2")] } };
    const client = attentionClient({ store, cascadeAfter: "never" });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], {
      waitMs: 2_000,
      pollMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.outcome).toBe("applied");
    expect(r.parallels).toEqual({ count: 1, stillUnformatted: 2 });
    expect(r.warning).toBe(
      "1 autographed card on Inserts › Future Stars still show no format after 2s; the server is still marking them. List attention again shortly. 2 autographed cards on its parallel still show no format; the server is still marking them. List attention again shortly.",
    );
  });

  test("a parallel answered in the same call keeps its own answer: the deeper row is written first", async () => {
    const store: Store = { rows: { [FUTURE]: [au("f1", "FS-1")], [GOLD]: [au("g1", "FS-1")] } };
    const client = attentionClient({ store });
    const results = await applyAutographAnswers(
      client,
      SET,
      [
        { row: FS, format: "On Card" },
        { row: { ...FS, parallel: "Gold" }, format: "Sticker/Label" },
      ],
      fast,
    );
    expect(writes(client)).toEqual([
      { selectorOptionId: GOLD, value: "Sticker/Label" },
      { selectorOptionId: FUTURE, value: "On Card" },
    ]);
    // Results keep the answers' order; Gold is its own row, not one Future Stars reached.
    expect(results.map((r) => [r.at, r.outcome])).toEqual([
      ["autographs[0]", "applied"],
      ["autographs[1]", "applied"],
    ]);
    expect(results[0].parallels).toBeUndefined();
    expect(store.leafFeatures?.[GOLD]?.autographFormat).toBe("Sticker/Label");
    expect(store.leafFeatures?.[FUTURE]?.autographFormat).toBe("On Card");
    expect((store.rows[GOLD][0].features as Record<string, string>).autographed).toBe("Sticker/Label");
  });

  test("a server that returns nothing for the write reaches no parallel and still waits on the row", async () => {
    const store = autos();
    const client = attentionClient({ store });
    client.on("autographFormat:setAutographFormat", (a) => {
      store.leafFeatures = { ...(store.leafFeatures ?? {}), [String(a.selectorOptionId)]: { autographFormat: String(a.value) } };
      cascade(store, String(a.selectorOptionId));
      return null;
    });
    const [r] = await applyAutographAnswers(client, SET, [{ row: FS, format: "On Card" }], fast);
    expect(r).toMatchObject({ outcome: "applied", detail: "Autographs saved as on card. 2 cards on Inserts › Future Stars now marked on card." });
    expect(r.parallels).toBeUndefined();
  });
});
