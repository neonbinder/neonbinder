import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * NEO-118 — a postal address, shared by the schema and by convex/shipping.ts's
 * query `returns` / mutation `args`. Defined once and exported so the stored
 * shape and the wire shape cannot drift apart; the matching TypeScript
 * interface is `PostalAddress` in lib/shipping/address.ts.
 *
 * `country` is stored even though it is always "US" today — see the note on
 * PostalAddress for why it is carried from the start.
 */
export const postalAddressValidator = v.object({
  name: v.string(),
  company: v.optional(v.string()),
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  postalCode: v.string(),
  country: v.string(),
});

/**
 * NEO-137 — a card's identity on one marketplace, plus which of its parent
 * row's mapping SLOTS that identity came from. Exported so the stored shape
 * and every wire shape that carries it cannot drift apart.
 *
 * See `cardChecklist.platformData` below and convex/platformSlots.ts.
 */
export const cardPlatformRefValidator = v.object({
  ref: v.string(),
  src: v.string(),
});

export const cardPlatformDataValidator = v.object({
  bsc: v.optional(cardPlatformRefValidator),
  sportlots: v.optional(cardPlatformRefValidator),
});

/**
 * WIRE form of the same thing: `setId` is the marketplace set id, not a slot.
 *
 * Clients and adapters know nothing about slots — a slot only has meaning
 * relative to one `selectorOptions` row. `commitCardChecklist` resolves
 * `setId` to a slot on the card's own parent row, allocating one if that set
 * is not attached there yet. That keeps the invariant simple: a stored card's
 * `src` ALWAYS names a slot on its own parent.
 */
export const cardPlatformWireRefValidator = v.object({
  ref: v.string(),
  setId: v.optional(v.string()),
});

export const cardPlatformWireDataValidator = v.object({
  bsc: v.optional(cardPlatformWireRefValidator),
  sportlots: v.optional(cardPlatformWireRefValidator),
});

export const selectorOptionLevelValidator = v.union(
  v.literal("sport"),
  v.literal("year"),
  v.literal("manufacturer"),
  v.literal("setName"),
  v.literal("variantType"),
  v.literal("insert"),
  v.literal("parallel"),
);

/**
 * NEO-137 phase 0 — the `selectorOptions` document fields, defined once and
 * exported so every hand-written `returns` validator can be built FROM the
 * schema instead of re-listing it.
 *
 * Four queries used to enumerate these fields by hand
 * (`getSelectorOptions`, `getSelectorOptionById`, `findByLevelAndValue`,
 * `getInsertTreeByVariantType`). Convex validates `returns` STRICTLY, so every
 * field added to the table had to be copied into all four or the query would
 * throw `Object contains extra field '<name>'` at runtime for any row carrying
 * it. That is exactly how `getInsertTreeByVariantType` came to be missing
 * `platformLabels`, `primaryPlatformId` and `sportConfig` — it broke Group
 * Parallels in prod for every reconciled row, the second occurrence of the
 * same bug after `sportConfig` (NEO-96).
 *
 * Deriving the validator from this object makes that drift structurally
 * impossible: a new field is in the `returns` of all four the moment it is in
 * the table. See `selectorOptionDocValidator` in convex/selectorOptions.ts.
 */
export const selectorOptionFields = {
  level: selectorOptionLevelValidator,
  value: v.string(), // Display value (e.g., "Football")
  // NEO-137: the marketplace sets this row maps to, keyed by SLOT rather than
  // held as a bare list. A row's cards point back here by slot key instead of
  // repeating a full BSC slug / SL set id on every card.
  //
  // Slot keys (`b0`, `s0`, …) come from `platformSlotSeq` and are NEVER
  // reused. A positional index would silently repoint every card below a
  // detached entry at a different marketplace set; a retired slot key instead
  // resolves to nothing and is reported as an orphaned ref.
  //
  // Two sibling rows may hold the SAME marketplace set id in their own slots —
  // that is the M-NB-rows-to-1-marketplace-set mapping (NEO-137). NEO-6's
  // inverse (1 row → N sets) is just a row with several slots on a side.
  //
  // Helpers live in convex/platformSlots.ts; read through those, not by hand.
  platformData: v.object({
    bsc: v.optional(v.record(v.string(), v.string())),       // slot → BSC set slug
    sportlots: v.optional(v.record(v.string(), v.string())), // slot → SL set id
  }),
  // Human-readable label per SLOT (not per marketplace ID — the id is not
  // unique across rows, the slot is). Every slot gets one at attach time; the
  // SL label is the display name that used to live in
  // `platformData.sportlotsDisplay`, which had no meaning once a row could
  // hold several SL sets.
  platformLabels: v.optional(v.object({
    bsc: v.optional(v.record(v.string(), v.string())),
    sportlots: v.optional(v.record(v.string(), v.string())),
  })),
  // The SLOT that storeReconciledOptions matched against. Used during
  // re-reconciliation to refresh that one entry without clobbering
  // operator-attached extras. Absent → treat the lowest-numbered slot as
  // primary.
  primaryPlatformId: v.optional(v.object({
    bsc: v.optional(v.string()),
    sportlots: v.optional(v.string()),
  })),
  // Monotonic high-water mark per side: the next slot number to issue. Only
  // ever increases, including across detach/re-attach, which is what
  // guarantees a freed slot key is never handed out to a different
  // marketplace set while cards still point at it.
  platformSlotSeq: v.optional(v.object({
    bsc: v.optional(v.number()),
    sportlots: v.optional(v.number()),
  })),
  parentId: v.optional(v.id("selectorOptions")), // For hierarchical relationships
  children: v.optional(v.array(v.id("selectorOptions"))), // Child options
  isCustom: v.optional(v.boolean()), // Distinguishes user-added entries from marketplace data
  createdByUserId: v.optional(v.string()), // Audit trail for custom entries
  metadata: v.optional(v.object({
    cardNumberPrefix: v.optional(v.string()),   // e.g. "DK-" for Diamond Kings
    isInsert: v.optional(v.boolean()),
    isParallel: v.optional(v.boolean()),
  })),
  // NEO-96: self-describing config for a `level: "sport"` row. Absent on
  // every other level, and absent on custom sports (which degrade explicitly:
  // slugified SKU prefix, no Wikidata/ESPN enrichment).
  //
  // These values used to live in five module-level maps keyed by the sport's
  // DISPLAY NAME — SPORT_QIDS/HOF_QIDS (adapters/wikidata.ts),
  // SPORT_TO_ESPN_LEAGUE (adapters/espn.ts), SPORT_SKU_CODE (sku.ts),
  // SPORT_TO_LEAGUE (features/deriveCardFeatures.ts). Keying on the display
  // name meant renaming a sport would silently break SKU generation and
  // enrichment. Holding the config on the row makes it rename-proof: the maps
  // survive only as bootstrap DEFAULTS applied at row creation
  // (see convex/sportConfig.ts), never as runtime lookups.
  //
  // NOT to be confused with `platformData`, which holds marketplace WIRE
  // formats (bsc "baseball", sportlots "BB"). Those are resolved at the
  // adapter boundary and must never be persisted onto a domain entity.
  sportConfig: v.optional(v.object({
    skuCode: v.optional(v.string()),  // 2-char NeonBinder SKU prefix, e.g. "BB"
    league: v.optional(v.string()),   // e.g. "MLB"
    espn: v.optional(v.object({
      path: v.string(),               // e.g. "baseball/mlb"
      leagueName: v.string(),
    })),
    wikidata: v.optional(v.object({
      sportQid: v.string(),               // e.g. "Q5369" (baseball)
      hallOfFameQid: v.optional(v.string()),
    })),
  })),
  // NEO-24: marketplace-agnostic feature map. Keys come from
  // `convex/features/expectedFeatures.ts` (e.g. "league", "era",
  // "isReprint"). Values are strings ("MLB", "Modern",
  // "true"/"false", "Base Card"). When set at a higher level
  // (sport/year/manufacturer/setName/variant), the propagation engine
  // writes the value down to every descendant `cardChecklist` row that
  // has not explicitly overridden the key. See `setSelectorOptionFeature`.
  features: v.optional(v.record(v.string(), v.string())),
  lastUpdated: v.number(),
};

// Using Clerk for authentication - users are identified by Clerk user IDs
export default defineSchema({
  // Users table for storing Clerk user data
  users: defineTable({
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    // Store the Clerk user ID as a string (not as a Convex ID)
    clerkUserId: v.optional(v.string()),
  }).index("by_clerk_user_id", ["clerkUserId"]),

  numbers: defineTable({
    value: v.number(),
  }),

  // User profiles for storing site credential references and preferences
  // Using Clerk user IDs as strings
  userProfiles: defineTable({
    userId: v.string(), // Clerk user ID as string
    siteCredentials: v.optional(v.array(v.object({
      site: v.string(),
      hasCredentials: v.boolean(),
      lastUpdated: v.optional(v.string()),
      // Per-(user, site) credential-operation lock. A credential op (store /
      // test-login / delete) is mutually exclusive so a Clear can't race an
      // in-flight marketplace login and corrupt the stored token. lockedAt is
      // the lease anchor (epoch ms); a lock older than CRED_LOCK_LEASE_MS is
      // stale and reclaimable (crash recovery). lockToken is server-minted and
      // never sent to the client — release requires a matching token. All
      // optional: existing rows read as "not locked" (no migration).
      lockedAt: v.optional(v.number()),
      lockedOp: v.optional(
        v.union(v.literal("store"), v.literal("test"), v.literal("delete")),
      ),
      lockToken: v.optional(v.string()),
    }))),
    // Per-marketplace account identifiers captured at login time so callers
    // (e.g. fetchBscChecklist) don't have to re-derive them on every request.
    marketplaceAccountIds: v.optional(v.object({
      bscSellerId: v.optional(v.string()),
    })),
    preferences: v.optional(v.object({
      // NEO-96: `defaultSport: v.optional(v.string())` removed — it had zero
      // readers anywhere in the app, so it was dropped rather than converted to
      // a reference. Re-add as v.id("selectorOptions") if a consumer appears.
      defaultYear: v.optional(v.number()),
      theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
    })),
    // NEO-118: the seller's own address, printed in the FROM block of a 4x6
    // shipping label. Lives here rather than in `publicProfiles` because a home
    // address is not public profile content — publicProfiles is served
    // unauthenticated at /u/:username. Optional so existing rows need no
    // migration; /labels treats absent as "not set up yet".
    returnAddress: v.optional(postalAddressValidator),
  }).index("by_user", ["userId"]),

  // Selector Options - stores all possible values for each selector level.
  // Fields live in `selectorOptionFields` above so query `returns` validators
  // are built from the schema rather than re-listing it (NEO-137 phase 0).
  selectorOptions: defineTable(selectorOptionFields)
    .index("by_level", ["level"])
    .index("by_parent", ["parentId"])
    .index("by_value", ["value"])
    .index("by_level_and_parent", ["level", "parentId"]),

  // Transient per-(level, parentId) marketplace-sync status for SetSelector
  // columns (NEO-47 sync redesign). A row exists only while a sync is in flight
  // ("syncing") or has errored ("error"); the happy path deletes it. The FE
  // derives a column's loading/error/Retry state from this reactively, replacing
  // EntityColumn's old sync state-machine + fragile onDone handoff. parentId
  // omitted = root (sport) level.
  selectorSyncStatus: defineTable({
    level: v.union(
      v.literal("sport"),
      v.literal("year"),
      v.literal("manufacturer"),
      v.literal("setName"),
      v.literal("variantType"),
      v.literal("insert"),
      v.literal("parallel"),
    ),
    parentId: v.optional(v.id("selectorOptions")),
    status: v.union(v.literal("syncing"), v.literal("error")),
    message: v.optional(v.string()),
    requestId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_level_and_parent", ["level", "parentId"]),

  // Card Checklist - stores individual cards within a set variant.
  // Carries enough metadata to drive an eBay Sell Inventory API listing
  // without re-fetching from marketplaces. Inventory-copy fields (grade,
  // condition, cert #) belong on a future cardInventory table — NOT here.
  cardChecklist: defineTable({
    selectorOptionId: v.id("selectorOptions"), // Points to variant-level option
    cardNumber: v.string(),
    cardName: v.string(),
    // NEO-26: DEPRECATED. The free-text `team` column was the source of
    // the "Team field is always blank when editing a card" bug — the
    // BSC/SL fetch path wrote here but the form UI read from
    // `teamOnCardIds[]`. The schema field is kept as `v.optional`
    // strictly so the `backfillTeamToOnCardIds` internal migration
    // (see `convex/cardChecklist.ts`) can read legacy rows on the way
    // to clearing the column. No code path writes to it anymore. A
    // follow-up PR removes the field outright once backfill has run
    // on prod + dev Convex.
    team: v.optional(v.string()),
    // Many-to-many links to entity tables. Multi-player cards (dual autos,
    // checklist tickets) carry multiple playerIds. teamOnCardIds is the
    // team(s) printed on the card — independent of players[].teamYears,
    // which can drift in the offseason before sets are released.
    playerIds: v.optional(v.array(v.id("players"))),
    teamOnCardIds: v.optional(v.array(v.id("teams"))),
    // NEO-90: set once the BSC per-card team-enrichment queue has checked
    // this card's `platformData.bsc` detail endpoint for a team, regardless
    // of outcome. Distinct from `teamOnCardIds` being empty, which can also
    // mean "not checked yet" — without this marker a card that legitimately
    // has no team (an insert/subset card) would be re-fetched forever on
    // every future sync. Not touched by `lastUpdated`-driven logic.
    teamCheckDoneAt: v.optional(v.number()),
    // De-duped union of BSC playerAttribute[] + BSC features[] + variant
    // metadata. Tokens: ["RC","AU","RELIC","SP","SSP","NUM",...]. Drives
    // both the eBay Features aspect and the boolean derivations below.
    attributes: v.optional(v.array(v.string())),
    // Boolean derivations from attributes — denormalized for query speed.
    isRookie: v.optional(v.boolean()),
    isRelic: v.optional(v.boolean()),
    // Numbered card print run (e.g. /99). Derived from BSC printRun or
    // set-level metadata; absent on unnumbered cards.
    printRun: v.optional(v.number()),
    // Autograph signal: presence of autographType implies the card is
    // autographed. Values: "On-Card" / "Sticker" / "Cut".
    autographType: v.optional(v.string()),
    // BSC variantName: "Gold", "Refractor", "/199", etc. Used as eBay
    // Parallel/Variety aspect tail and for title generation.
    cardVariation: v.optional(v.string()),
    // NEO-25: marketplace-agnostic listing title & description, authored once
    // and reused by every marketplace adapter (eBay/SportLots/BSC/MySlabs/
    // MyCardPost) so a listing doesn't recompute the title each time. NOT
    // eBay-specific. Manually edited today in the card detail panel; an
    // auto-generator (composed from the card's resolved features) is a
    // separate follow-up ticket. Optional + additive — absent on legacy rows.
    listingTitle: v.optional(v.string()),
    listingDescription: v.optional(v.string()),
    // User-uploaded scans only — we do NOT mirror BSC image URLs into our
    // schema (their CDN, their quotas). Empty at fetch time.
    imageUrls: v.optional(v.object({
      front: v.optional(v.string()),
      back: v.optional(v.string()),
    })),
    // NEO-137: this card's identity on each marketplace, plus which of the
    // parent row's mapping SLOTS that identity came from.
    //
    // A card carries AT MOST ONE ref per platform, and may carry none — a card
    // absent from both BSC and SportLots is still a real card, listable on
    // eBay and trackable in personal inventory.
    //
    //   ref — BSC: the card id (`r.id` from the bulk-upload row).
    //         SportLots: the raw un-tokenized description. SL exposes no
    //         per-card id and reuses card numbers across variation rows, so
    //         the description is its only identity (NEO-91).
    //   src — slot key on the parent selectorOptions row (see platformData
    //         there). This replaces NEO-6's `sourcePlatformIds`, which stored
    //         the full set id on every card.
    //
    // Two NB rows sharing one marketplace set is resolved HERE: each row's
    // cards name their own SL refs (`#A1…` vs `#B1…`) out of the same slot.
    platformData: cardPlatformDataValidator,
    isCustom: v.optional(v.boolean()),
    // Player names declared on a custom card before the players exist as
    // entities. fetchCardChecklist's reconciliation surfaces these as
    // unknownPlayers in the UnknownEntitiesDialog; commitCardChecklist
    // clears entries that the user confirms (so subsequent fetches don't
    // re-prompt for the same player).
    pendingPlayerNames: v.optional(v.array(v.string())),
    pendingTeamNames: v.optional(v.array(v.string())),
    // NEO-24: per-card override of marketplace-agnostic feature map. Inherits
    // merged ancestor `selectorOptions.features` at card-creation time
    // (`commitCardChecklist`). Subsequent edits via `setSelectorOptionFeature`
    // propagate down only to cards whose key is undefined OR equal to the
    // previous set-level value. Overridden entries stay put.
    features: v.optional(v.record(v.string(), v.string())),
    // NEO-91: NeonBinder-generated cross-marketplace SKU (see convex/sku.ts
    // for the generation algorithm + length rationale). Optional since
    // existing rows predate this field — no backfill planned, this data
    // gets deleted and resynced fresh.
    sku: v.optional(v.string()),
    sortOrder: v.number(),
    lastUpdated: v.number(),
  })
    .index("by_selector_option", ["selectorOptionId"])
    .index("by_selector_option_and_number", ["selectorOptionId", "cardNumber"]),

  // NEO-21: cross-release guest appearances. Some cards complete one set's
  // checklist but were physically printed inside a different product (2021
  // Score #301-320 shipped in 2022 Chronicles packs). The card's
  // `cardChecklist.selectorOptionId` stays pinned to where it was PRINTED —
  // that pointer is what release-year, SKU generation and provenance resolve
  // off, so it must never be repointed at the guest set. This junction table
  // is purely additive: it says "also show this card under that other
  // variant". Deleting a row here never touches the card.
  cardCrossListings: defineTable({
    cardChecklistId: v.id("cardChecklist"),    // the home card row (owns provenance/pricing/year)
    selectorOptionId: v.id("selectorOptions"), // the OTHER variant-level set this card also appears under
    createdByUserId: v.optional(v.string()),
    lastUpdated: v.number(),
  })
    .index("by_selector_option", ["selectorOptionId"]) // guest-side lookup: "who's cross-listed into me"
    .index("by_card", ["cardChecklistId"]),            // home-side lookup: "where else does this card appear"

  // Players — first-class entity. Created from BSC `players[]` / SL desc
  // parse / user input. Enriched async from Wikidata SPARQL after user
  // confirmation in the UnknownEntitiesDialog.
  players: defineTable({
    name: v.string(),
    // lowercase + token-sort dedup key. Built by normalizePlayerName().
    nameNormalized: v.string(),
    // NEO-96: a REFERENCE to the sport-level selectorOptions row, not a copy of
    // its display label. Previously `primarySport: v.string()`, which three
    // writers populated with two different casings — commitCardChecklist wrote
    // fetchCardChecklist's lowercased "baseball" (a BSC wire format that leaked
    // out of the adapter layer), while the pickers wrote the raw "Baseball".
    // Reads are exact matches, so the same player was invisible to whichever
    // path didn't create it and got silently duplicated.
    sportId: v.id("selectorOptions"),
    // Career teams from Wikidata P54 with P580/P582 qualifiers. teamId
    // points at our teams table once the team is created/known.
    teamYears: v.optional(v.array(v.object({
      teamId: v.id("teams"),
      fromYear: v.number(),
      toYear: v.optional(v.number()),
    }))),
    isHallOfFame: v.optional(v.boolean()),
    externalIds: v.optional(v.object({
      wikidataId: v.optional(v.string()), // e.g. "Q123456"
    })),
    createdByUserId: v.optional(v.string()),
    lastUpdated: v.number(),
  })
    .index("by_name_normalized", ["nameNormalized"])
    // Compound index for the hot path in commitCardChecklist's per-player
    // resolution: lookup by normalized name AND sport in one indexed read.
    // Without this, the by_name_normalized index returned every row sharing
    // a normalized name across all sports (e.g. "smith" baseball + basketball
    // + football + …), so a 300-player BSC fetch scanned 300 × N cross-sport
    // duplicates and could blow past Convex's 4096 document-scan budget on
    // a single mutation.
    .index("by_name_normalized_and_sport_id", ["nameNormalized", "sportId"])
    .index("by_sport_id", ["sportId"]),

  // Teams — first-class entity. Modeled with city + yearsActive to support
  // defunct franchises (Expos → Nationals, SuperSonics, etc.) since vintage
  // sets reference teams that no longer exist.
  teams: defineTable({
    name: v.string(),
    nameNormalized: v.string(),
    // NEO-96: reference, not a copied display label — see players.sportId.
    sportId: v.id("selectorOptions"),
    league: v.optional(v.string()),
    city: v.optional(v.string()),
    yearsActive: v.optional(v.object({
      from: v.number(),
      to: v.optional(v.number()),
    })),
    // NEO-91: hex color strings (e.g. "#008348"), from ESPN's public site
    // API — Wikidata's P462 was confirmed empty for every real team tested
    // (including the Boston Celtics), so this is intentionally sourced
    // elsewhere. Absent for defunct/historical teams ESPN doesn't carry.
    colors: v.optional(v.object({
      primary: v.optional(v.string()),
      secondary: v.optional(v.string()),
    })),
    externalIds: v.optional(v.object({
      wikidataId: v.optional(v.string()),
      espnId: v.optional(v.string()),
    })),
    lastUpdated: v.number(),
  })
    .index("by_name_normalized", ["nameNormalized"])
    // Same compound-index optimization as players above. See its comment.
    .index("by_name_normalized_and_sport_id", ["nameNormalized", "sportId"])
    .index("by_sport_id", ["sportId"]),

  // NEO-92: per-fetch review queue backing the step-through "new players &
  // teams" wizard (replaces the old single-screen checkbox dialog). One row
  // per unknown name surfaced by fetchCardChecklist. A background chained
  // action (processEntityReviewQueue in adapters/wikidata.ts) works through
  // "pending" rows one at a time, patching status/enrichment as each
  // Wikidata lookup completes — the wizard subscribes reactively and
  // presents rows in COMPLETION order (whichever finishes first), not
  // original fetch order. `decision` is patched by the user's own action in
  // the wizard (recordDecision) — durable across a page refresh, unlike
  // keeping it only in React state. There is deliberately no "skip" decision
  // variant: every name must resolve to create-or-link.
  //
  // `createdByUserId` scopes batch resumption per (selectorOptionId, user):
  // startBatch only resumes a batch created by the SAME user. Two different
  // admin sessions (or the same admin in two tabs) reviewing the same set
  // concurrently each get their own private queue rather than silently
  // sharing/colliding on one. Confirmed necessary, not just theoretical: two
  // concurrent Maestro CI workers (each a distinct test user) sharing one
  // real marketplace set produced two distinct observed bugs before this
  // field existed — a dropped Cancel tap (one worker's commit collapsed
  // another's wizard footer mid-click) and a wrong-item-shown wizard (one
  // worker's unknown name preempted another's in shared queue order).
  entityReviewQueue: defineTable({
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
    createdByUserId: v.string(),
    kind: v.union(v.literal("player"), v.literal("team")),
    name: v.string(),
    // NEO-96: reference, not a copied display label — see players.sportId.
    // getBatch resolves this to a `sportValue` string for the wizard's label so
    // the client never has to join.
    sportId: v.id("selectorOptions"),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("error"),
    ),
    enrichment: v.optional(v.object({
      wikidataId: v.optional(v.string()),
      // player-only. Team NAMES, not ids — resolving to real team rows via
      // teams.findOrCreateInternal is deferred to commit time (only once
      // "create" is the confirmed decision), so a lookup during mere
      // preview can never orphan a team row for a player the user ends up
      // linking to someone else or never creates.
      careerTeams: v.optional(v.array(v.object({
        name: v.string(),
        fromYear: v.number(),
        toYear: v.optional(v.number()),
      }))),
      isHallOfFame: v.optional(v.boolean()),
      // team-only
      league: v.optional(v.string()),
      city: v.optional(v.string()),
      yearsActive: v.optional(v.object({
        from: v.number(),
        to: v.optional(v.number()),
      })),
      colors: v.optional(v.object({
        primary: v.optional(v.string()),
        secondary: v.optional(v.string()),
      })),
      espnId: v.optional(v.string()),
    })),
    decision: v.optional(v.union(
      v.object({
        action: v.literal("create"),
        // player-only: career-team entries the admin added by hand in the
        // review wizard (in addition to whatever Wikidata found), for the
        // case where Wikidata returned nothing or missed a team. Team NAMES,
        // not ids — resolved to real team rows via get-or-create at commit
        // time (same as enrichment.careerTeams above). Harmless-but-unused if
        // ever present on a team-kind create decision; the team-kind UI path
        // never populates it.
        manualCareerTeams: v.optional(v.array(v.object({
          name: v.string(),
          fromYear: v.number(),
          toYear: v.optional(v.number()),
        }))),
      }),
      v.object({
        action: v.literal("link"),
        linkedPlayerId: v.optional(v.id("players")),
        linkedTeamId: v.optional(v.id("teams")),
      }),
    )),
  })
    .index("by_selector_option", ["selectorOptionId"])
    .index("by_selector_option_and_batch", ["selectorOptionId", "batchId"])
    .index("by_selector_option_and_user", ["selectorOptionId", "createdByUserId"]),

  // Set Selections - stores user's selected set parameters
  setSelections: defineTable({
    name: v.string(),
    description: v.string(),
    sport: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    year: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    manufacturer: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    setName: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    variantType: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    insert: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    parallel: v.optional(v.array(v.object({ site: v.string(), value: v.string() }))),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),

  // Public profiles for the Linktree-style collector page at /u/[username]
  publicProfiles: defineTable({
    userId: v.string(),             // Clerk user ID
    username: v.string(),           // URL slug, unique, lowercase a-z0-9-
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    tagline: v.optional(v.string()),
    brandColor1: v.optional(v.string()),   // hex e.g. "#00D558"
    brandColor2: v.optional(v.string()),   // hex e.g. "#A44AFF"
    // Marketplace full URLs
    ebayUrl: v.optional(v.string()),
    buySportsCardsUrl: v.optional(v.string()),
    sportlotsUrl: v.optional(v.string()),
    mySlabsUrl: v.optional(v.string()),
    myCardPostUrl: v.optional(v.string()),
    // Payment handles (links constructed at render time)
    paypalUsername: v.optional(v.string()),
    paypalEmail: v.optional(v.string()),     // PayPal email for G&S payments
    venmoUsername: v.optional(v.string()),
    cashAppUsername: v.optional(v.string()),
    // Social media full URLs
    twitterUrl: v.optional(v.string()),
    instagramUrl: v.optional(v.string()),
    tiktokUrl: v.optional(v.string()),
    youtubeUrl: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    threadsUrl: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_username", ["username"]),

  // Prize Pool - stores prizes for the wheel of fortune spin
  prizePool: defineTable({
    userId: v.string(), // Clerk user ID as string
    prizeName: v.string(),
    percentage: v.number(), // 0-100, represents the likelihood of winning this prize
    pokemonImageUrl: v.optional(v.string()), // URL to the Pokemon variant image stored in Google Cloud Storage
    sportsImageUrls: v.optional(v.array(v.string())), // Array of URLs to sports variant images stored in Google Cloud Storage
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // E2E test work-queue (NEO-49). CI runners atomically pull the next pending
  // flow from here instead of running a static shard slice, so dispatch is
  // dynamic (work-stealing): any runner grabs whatever's available, slow flows
  // can't drag a fixed shard, and the suite scales by just adding flows + runners
  // (no SHARD_TOTAL re-tuning). Scoped per CI run (`runId`) so re-runs/concurrent
  // runs never collide. Lives ONLY on the ephemeral per-PR Convex preview — the
  // queue functions fail closed in prod (gated on E2E_QUEUE_SECRET). Doubles as
  // live run observability (counts queryable any time).
  e2eFlowQueue: defineTable({
    runId: v.string(), // CI run identifier (e.g. GitHub run id) — partitions one suite execution
    flowPath: v.string(), // .maestro/flows/<dir>/<name>.yaml
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed"),
    ),
    claimedBy: v.optional(v.string()), // worker that claimed it (e.g. "r2-w1")
    attempts: v.number(), // claim count (a re-claimed lease-expired flow increments this)
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_run_status", ["runId", "status"])
    .index("by_run_flow", ["runId", "flowPath"]),
});
