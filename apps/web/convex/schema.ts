import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
      defaultSport: v.optional(v.string()),
      defaultYear: v.optional(v.number()),
      theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
    })),
  }).index("by_user", ["userId"]),

  // Selector Options - stores all possible values for each selector level
  selectorOptions: defineTable({
    level: v.union(
      v.literal("sport"),
      v.literal("year"),
      v.literal("manufacturer"),
      v.literal("setName"),
      v.literal("variantType"),
      v.literal("insert"),
      v.literal("parallel")
    ),
    value: v.string(), // Display value (e.g., "Football")
    platformData: v.object({
      // Either side may be an array at the variant levels (variantType /
      // insert / parallel) when a single canonical row maps to multiple
      // marketplace sets (e.g. 2022 Topps split into Series 1 / Series 2 on
      // SportLots). Sport/year/manufacturer/setName rows stay single-string.
      // See NEO-6 phase 1 for the multi-version mapping design.
      bsc: v.optional(v.union(v.string(), v.array(v.string()))),
      sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
      // SL display name captured at the time the user picked the SL Base
      // anchor in BaseSetPicker. Used by ReconciliationModal to seed the
      // SL prefix filter (sibling `sportlots` holds the radio ID, which is
      // numeric and not human-comparable). Optional + additive for
      // backwards compatibility; missing rows self-heal on next sync.
      sportlotsDisplay: v.optional(v.string()),
    }),
    // Human-readable label per attached marketplace ID. Keyed by the
    // marketplace ID string. Absent on legacy / single-ID rows — fall back
    // to the ID itself when rendering. Only populated when an operator
    // attaches extras beyond the reconciliation-derived primary.
    platformLabels: v.optional(v.object({
      bsc: v.optional(v.record(v.string(), v.string())),
      sportlots: v.optional(v.record(v.string(), v.string())),
    })),
    // The marketplace ID that storeReconciledOptions matched against. Used
    // during re-reconciliation to refresh that one entry without clobbering
    // operator-attached extras. Absent on legacy rows — treat the first
    // entry in platformData.<side> as primary in that case.
    primaryPlatformId: v.optional(v.object({
      bsc: v.optional(v.string()),
      sportlots: v.optional(v.string()),
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
    // NEO-24: marketplace-agnostic feature map. Keys come from
    // `convex/features/expectedFeatures.ts` (e.g. "league", "era",
    // "isReprint", "cardType"). Values are strings ("MLB", "Modern",
    // "true"/"false", "Base Card"). When set at a higher level
    // (sport/year/manufacturer/setName/variant), the propagation engine
    // writes the value down to every descendant `cardChecklist` row that
    // has not explicitly overridden the key. See `setSelectorOptionFeature`.
    features: v.optional(v.record(v.string(), v.string())),
    lastUpdated: v.number(),
  })
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
    platformData: v.object({
      bsc: v.optional(v.string()),
      sportlots: v.optional(v.string()),
    }),
    // NEO-6 phase 1: when the parent variant has multiple attached BSC/SL
    // set IDs, each card records which source set it came from. Used for
    // the "show only Series 2" filter on the checklist and to target the
    // correct marketplace listing for later updates. Absent on cards
    // whose variant has a single source per marketplace.
    sourcePlatformIds: v.optional(v.object({
      bsc: v.optional(v.string()),
      sportlots: v.optional(v.string()),
    })),
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
    sortOrder: v.number(),
    lastUpdated: v.number(),
  })
    .index("by_selector_option", ["selectorOptionId"])
    .index("by_selector_option_and_number", ["selectorOptionId", "cardNumber"]),

  // Players — first-class entity. Created from BSC `players[]` / SL desc
  // parse / user input. Enriched async from Wikidata SPARQL after user
  // confirmation in the UnknownEntitiesDialog.
  players: defineTable({
    name: v.string(),
    // lowercase + token-sort dedup key. Built by normalizePlayerName().
    nameNormalized: v.string(),
    primarySport: v.string(),
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
    .index("by_name_normalized_and_sport", ["nameNormalized", "primarySport"])
    .index("by_sport", ["primarySport"]),

  // Teams — first-class entity. Modeled with city + yearsActive to support
  // defunct franchises (Expos → Nationals, SuperSonics, etc.) since vintage
  // sets reference teams that no longer exist.
  teams: defineTable({
    name: v.string(),
    nameNormalized: v.string(),
    sport: v.string(),
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
    .index("by_name_normalized_and_sport", ["nameNormalized", "sport"])
    .index("by_sport", ["sport"]),

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
