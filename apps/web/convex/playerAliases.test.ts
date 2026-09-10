/**
 * NEO-254 — a player's cards do not all print the same name.
 *
 * Jason, 2026-09-08: "cards from different years read differently for one
 * person." Ron Artest became Metta World Peace, B.J. Upton became Melvin Upton
 * Jr., Mike Stanton became Giancarlo, Fausto Carmona turned out to be Roberto
 * Hernández, Chad Johnson became Chad Ochocinco, Lloyd Free became World B.
 * Free, Lew Alcindor became Kareem Abdul-Jabbar. A checklist prints whichever
 * name was current, so without aliases the 2010 card and the 2011 card resolve
 * to two rows and one man's inventory is split in half.
 *
 * The model mirrors `leagues.aliases` (NEO-240) deliberately — stored raw,
 * matched normalized, bounded 32 x 64, own name dropped rather than refused —
 * with one addition it cannot borrow: `players` is far too large to scan, so
 * the aliases are ALSO written flat to `playerAliases` and the lookup is one
 * indexed read. That second copy is what these tests spend most of their time
 * on, because two copies of one fact can disagree.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_alias_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_alias_001",
  name: "Admin User",
  role: "admin",
};

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Basketball",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

/** A player plus its alias index rows, exactly as the writer would leave them. */
async function insertPlayerWithAliases(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
  aliases: string[] = [],
): Promise<Id<"players">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      ...(aliases.length ? { aliases } : {}),
      lastUpdated: Date.now(),
    });
    for (const alias of aliases) {
      await ctx.db.insert("playerAliases", {
        playerId: id,
        sportId,
        aliasNormalized: normalizePlayerName(alias),
      });
    }
    return id;
  });
}

const aliasRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("playerAliases").collect());

// ===========================================================================
// Matching
// ===========================================================================

describe("NEO-254: an alias resolves a card name to the player", () => {
  test("the old name finds the row, on the same footing as the new one", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(
      t,
      sportId,
      "Metta World Peace",
      ["Ron Artest"],
    );

    // The 2011 card.
    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Metta World Peace",
          sportId,
        })
      ).playerId,
    ).toBe(player);
    // The 2010 card — one man, one row.
    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Ron Artest",
          sportId,
        })
      ).playerId,
    ).toBe(player);
  });

  test("an alias hit JOINS the candidate set rather than winning outright", async () => {
    /*
     * The load-bearing rule. Everything downstream is built on the SIZE of the
     * candidate set: one links silently, two or more is a question for a human,
     * and the card-year narrowing runs over whatever is there. An alias that
     * quietly outranked a primary name would skip all of it and bind the card
     * to a guess.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayerWithAliases(t, sportId, "Chad Johnson");
    await insertPlayerWithAliases(t, sportId, "Somebody Else", ["Chad Johnson"]);

    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Chad Johnson",
      sportId,
    });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBeUndefined();
  });

  test("the card-year narrowing still applies to an alias candidate", async () => {
    // Two rows answer to the name; only one was playing in the set's year, so
    // the year settles it exactly as it would for two primary-name matches.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Lakers",
        location: "Los Angeles",
        nameNormalized: "angeles lakers los",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const modern = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Metta World Peace",
        nameNormalized: normalizePlayerName("Metta World Peace"),
        sportId,
        aliases: ["Ron Artest"],
        teamYears: [{ teamId: team, fromYear: 2009, toYear: 2013 }],
        lastUpdated: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("playerAliases", {
        playerId: modern,
        sportId,
        aliasNormalized: normalizePlayerName("Ron Artest"),
      }),
    );
    // A different, long-retired man of the same former name.
    await insertPlayerWithAliases(t, sportId, "Ron Artest");
    await t.run(async (ctx) => {
      const old = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalizePlayerName("Ron Artest")).eq("sportId", sportId),
        )
        .first();
      await ctx.db.patch(old!._id, {
        teamYears: [{ teamId: team, fromYear: 1948, toYear: 1952 }],
      });
    });

    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Ron Artest",
      sportId,
      cardYear: 2011,
    });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBe(modern);
    expect(resolved.narrowedByCardYear).toBe(true);
  });

  test("NEO-253: diacritics fold on an alias exactly as on a name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(
      t,
      sportId,
      "Roberto Hernández",
      ["Fausto Carmona"],
    );

    // The accented alias spelling and the unaccented card both land on it.
    const player2 = await insertPlayerWithAliases(t, sportId, "Someone Else", [
      "José Bautista",
    ]);
    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Jose Bautista",
          sportId,
        })
      ).playerId,
    ).toBe(player2);
    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Roberto Hernandez",
          sportId,
        })
      ).playerId,
    ).toBe(player);
  });

  test("an alias in ANOTHER sport does not answer here", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const otherSport = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    await insertPlayerWithAliases(t, otherSport, "Melvin Upton Jr", ["BJ Upton"]);

    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "BJ Upton",
          sportId,
        })
      ).matchCount,
    ).toBe(0);
  });

  test("a stale index row whose player is gone is not a candidate", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Lew Alcindor", [
      "Kareem Abdul-Jabbar",
    ]);
    await t.run(async (ctx) => ctx.db.delete(player));

    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Kareem Abdul-Jabbar",
          sportId,
        })
      ).matchCount,
    ).toBe(0);
  });
});

// ===========================================================================
// Writing
// ===========================================================================

describe("NEO-254: savePlayerFields writes aliases and keeps the index in step", () => {
  test("saving aliases writes the row AND the index rows", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Metta World Peace");

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: player,
      aliases: ["Ron Artest", "Metta Sandiford-Artest"],
    });

    const row = await t.run(async (ctx) => ctx.db.get(player));
    expect(row!.aliases).toEqual(["Ron Artest", "Metta Sandiford-Artest"]);
    expect((await aliasRows(t)).map((r) => r.aliasNormalized).sort()).toEqual(
      [
        normalizePlayerName("Ron Artest"),
        normalizePlayerName("Metta Sandiford-Artest"),
      ].sort(),
    );
  });

  test("clearing them removes the row's column and every index row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Metta World Peace", [
      "Ron Artest",
    ]);

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: player,
      aliases: [],
    });

    expect((await t.run(async (ctx) => ctx.db.get(player)))!.aliases).toBeUndefined();
    expect(await aliasRows(t)).toHaveLength(0);
  });

  test("a player's OWN name is dropped rather than stored as an alias", async () => {
    // The league precedent: an operator typing the row's own name has
    // expressed a redundancy, not an error, and the row already answers to it.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Metta World Peace");

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: player,
      aliases: ["Metta World Peace", "Ron Artest"],
    });

    const row = await t.run(async (ctx) => ctx.db.get(player));
    expect(row!.aliases).toEqual(["Ron Artest"]);
    expect(await aliasRows(t)).toHaveLength(1);
  });

  test("a rename drops an alias the new name has made redundant", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Ron Artest");

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: player,
      name: "Metta World Peace",
      aliases: ["Metta World Peace", "Ron Artest"],
    });

    // Checked against the name this save LEAVES on the row, not the old one.
    expect((await t.run(async (ctx) => ctx.db.get(player)))!.aliases).toEqual([
      "Ron Artest",
    ]);
  });

  test("an alias another player's NAME already owns is ALLOWED", async () => {
    /*
     * Jason, 2026-09-08: aliases may collide. He wants "Ken Griffey" on
     * Griffey Jr. as well as on Griffey Sr., so a card carrying that name
     * considers both men and the card-year narrowing decides which.
     *
     * Refusing it solved a problem the narrowing already solves better: two
     * candidates is not a failure, it is the question the wizard exists to
     * ask.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const father = await insertPlayerWithAliases(t, sportId, "Ken Griffey");
    const son = await insertPlayerWithAliases(t, sportId, "Ken Griffey Jr");

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: son,
      aliases: ["Ken Griffey"],
    });

    // Both rows now answer to the name, and BOTH are candidates.
    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Ken Griffey",
      sportId,
    });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBeUndefined();
    expect(father).not.toBe(son);
  });

  test("an alias another player's ALIAS already owns is allowed too", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayerWithAliases(t, sportId, "Somebody", ["Ken Griffey"]);
    const other = await insertPlayerWithAliases(t, sportId, "Someone Else");

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: other,
      aliases: ["Ken Griffey"],
    });

    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Ken Griffey",
          sportId,
        })
      ).matchCount,
    ).toBe(2);
  });

  test("the editor is TOLD the alias is shared, without being stopped", async () => {
    // A note, not a refusal: the operator should know it is shared rather than
    // finding out from a review queue three sets later.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const father = await insertPlayerWithAliases(t, sportId, "Ken Griffey");
    const son = await insertPlayerWithAliases(t, sportId, "Ken Griffey Jr");

    const hits = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.aliasesInUse, {
        sportId,
        aliases: ["Ken Griffey"],
        selfId: son,
      });
    expect(hits).toEqual([{ alias: "Ken Griffey", name: "Ken Griffey" }]);
    expect(father).toBeTruthy();

    // And nothing is reported against the row that already owns it.
    expect(
      await t.withIdentity(ADMIN_IDENTITY).query(api.players.aliasesInUse, {
        sportId,
        aliases: ["Ken Griffey"],
        selfId: father,
      }),
    ).toEqual([]);
  });

  test("re-saving a row's own aliases is not a collision with itself", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Metta World Peace", [
      "Ron Artest",
    ]);

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.players.savePlayerFields, {
      id: player,
      aliases: ["Ron Artest", "Metta Sandiford-Artest"],
    });
    expect((await aliasRows(t)).length).toBe(2);
  });

  test("the bounds are the same 32 x 64 leagues uses", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(t, sportId, "Metta World Peace");
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: player,
        aliases: Array.from({ length: 33 }, (_, i) => `Name ${i}`),
      }),
    ).rejects.toThrow(/33 aliases; the limit is 32/);
    await expect(
      asAdmin.mutation(api.players.savePlayerFields, {
        id: player,
        aliases: ["x".repeat(65)],
      }),
    ).rejects.toThrow(/65 characters; the limit is 64/);
  });
});

describe("NEO-254: createByAdmin accepts aliases", () => {
  test("they are written to the row and to the index", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const { id } = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.players.createByAdmin, {
        name: "Metta World Peace",
        sportId,
        aliases: ["Ron Artest"],
      });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.aliases).toEqual([
      "Ron Artest",
    ]);
    expect(await aliasRows(t)).toHaveLength(1);
  });

  test("a shared alias is created, not refused", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayerWithAliases(t, sportId, "Ken Griffey");

    const { id } = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.players.createByAdmin, {
        name: "Ken Griffey Jr",
        sportId,
        aliases: ["Ken Griffey"],
      });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.aliases).toEqual([
      "Ken Griffey",
    ]);
    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Ken Griffey",
          sportId,
        })
      ).matchCount,
    ).toBe(2);
  });
});

// ===========================================================================
// The wizard's candidate list
// ===========================================================================

describe("NEO-254: a candidate matched by alias says so", () => {
  test("buildExistingPlayerCandidates carries `matchedAlias`", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const byAlias = await insertPlayerWithAliases(
      t,
      sportId,
      "Metta World Peace",
      ["Ron Artest"],
    );
    const byName = await insertPlayerWithAliases(t, sportId, "Ron Artest");

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Ron Artest"],
      teamNames: [],
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", sportId).eq("batchId", batchId),
        )
        .first(),
    );
    const byId = new Map(
      (row!.enrichment!.existingCandidates ?? []).map((c) => [c.playerId, c]),
    );
    // The row whose FORMER name matched says why it is on the list…
    expect(byId.get(byAlias)!.matchedAlias).toBe("Ron Artest");
    // …and the row whose primary name matched does not.
    expect(byId.get(byName)!.matchedAlias).toBeUndefined();
  });

  test("nearMatches carries it too, so the Link search can say it", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const player = await insertPlayerWithAliases(
      t,
      sportId,
      "Metta World Peace",
      ["Ron Artest"],
    );

    const matches = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.players.nearMatches, { name: "Ron Artest", sportId });
    const hit = matches.find((m) => m._id === player);
    expect(hit).toBeTruthy();
    expect(hit!.matchedAlias).toBe("Ron Artest");
  });
});

// ===========================================================================
// Bulk load
// ===========================================================================

describe("NEO-254: upsertPlayers carries aliases", () => {
  /** The loader is armed by an env flag as well as the confirm literal. */
  function armed<T>(run: () => Promise<T>): Promise<T> {
    process.env.ALLOW_BULK_LOAD = "true";
    return run().finally(() => {
      delete process.env.ALLOW_BULK_LOAD;
    });
  }

  async function seedLoadableSport(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
  }

  test("written on CREATE, to the row and the index", async () => {
    const t = convexTest(schema, modules);
    await seedLoadableSport(t);

    const res = await armed(() =>
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: "BULK_LOAD",
        sport: "Basketball",
        players: [
          {
            key: "artest",
            name: "Metta World Peace",
            aliases: ["Ron Artest"],
            stints: [],
          },
        ],
      }),
    );

    expect(res.results[0].status).toBe("created");
    const row = await t.run(async (ctx) => ctx.db.get(res.results[0].id!));
    expect(row!.aliases).toEqual(["Ron Artest"]);
    expect(await aliasRows(t)).toHaveLength(1);
  });

  test("UNIONED on adopt — an operator's alias is never removed", async () => {
    /*
     * Every other field the loader touches is gap-filled. An alias list is
     * different: the row's existing entries may have been typed by an operator
     * who knew something the dataset does not, and a load that replaced them
     * would undo that work on every re-run.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedLoadableSport(t);
    const player = await insertPlayerWithAliases(
      t,
      sportId,
      "Metta World Peace",
      ["Metta Sandiford-Artest"],
    );

    await armed(() =>
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: "BULK_LOAD",
        sport: "Basketball",
        players: [
          {
            key: "artest",
            name: "Metta World Peace",
            aliases: ["Ron Artest"],
            stints: [],
          },
        ],
      }),
    );

    const row = await t.run(async (ctx) => ctx.db.get(player));
    expect(row!.aliases).toEqual(["Metta Sandiford-Artest", "Ron Artest"]);
    expect(await aliasRows(t)).toHaveLength(2);
  });

  test("a shared alias loads, and both rows then answer to it", async () => {
    // The loader is a second door into the same column and follows the same
    // rule: a shared alias is the feature, not a fault.
    const t = convexTest(schema, modules);
    const sportId = await seedLoadableSport(t);
    const father = await insertPlayerWithAliases(t, sportId, "Ken Griffey");

    const res = await armed(() =>
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: "BULK_LOAD",
        sport: "Basketball",
        players: [
          {
            key: "griffey-jr",
            name: "Ken Griffey Jr",
            aliases: ["Ken Griffey"],
            stints: [],
          },
        ],
      }),
    );

    expect(res.results[0].status).toBe("created");
    expect(res.results[0].id).not.toBe(father);
    expect(
      (
        await t.query(internal.players.resolveNameForReview, {
          name: "Ken Griffey",
          sportId,
        })
      ).matchCount,
    ).toBe(2);
  });

  test("an alias equal to the row's own name is dropped, not a collision", async () => {
    const t = convexTest(schema, modules);
    await seedLoadableSport(t);

    const res = await armed(() =>
      t.mutation(internal.bulkLoad.upsertPlayers, {
        confirm: "BULK_LOAD",
        sport: "Basketball",
        players: [
          {
            key: "artest",
            name: "Metta World Peace",
            aliases: ["Metta World Peace"],
            stints: [],
          },
        ],
      }),
    );

    expect(res.results[0].status).toBe("created");
    expect(
      (await t.run(async (ctx) => ctx.db.get(res.results[0].id!)))!.aliases,
    ).toBeUndefined();
  });
});
