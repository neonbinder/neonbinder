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
 * NEO-121 — one USPS scan as EasyPost reports it, normalised at the browser
 * service boundary (`tracking_details[]` → this shape, `datetime` → ms).
 * Exported so the stored shape, the browser service's response typing, and
 * `shipmentTracking.applyTrackerSnapshot`'s args cannot drift apart.
 *
 * `message` is USPS's own wording ("Origin Primary Processing", "Delivery")
 * and is rendered as TEXT, never HTML. Every string here is truncated by
 * `applyTrackerSnapshot` before it is stored — see `labelPurchases` below.
 */
export const trackingScanValidator = v.object({
  at: v.number(),          // scan time in ms
  status: v.string(),      // EasyPost scan status, verbatim
  message: v.string(),     // USPS's own message, verbatim
  // The whole location is optional: EasyPost omits `tracking_location`
  // entirely on some scans, and omits individual parts on others.
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zip: v.optional(v.string()),
  country: v.optional(v.string()),
});

/**
 * NEO-121 — a whole tracker as of one moment: what a `tracker.created` /
 * `tracker.updated` webhook event carries, and what `GET /shipments/:id`
 * returns for a bought shipment. Exported for convex/postage.ts,
 * convex/shipmentTracking.ts, and the browser service response typing.
 *
 * `updatedAt` is the monotonic guard: a snapshot is applied only when it is
 * strictly newer than the row's `trackerUpdatedAt`, which makes out-of-order
 * and duplicate webhook deliveries no-ops. `scans` is the FULL list every
 * time — EasyPost resends the whole history — so applying a snapshot is a
 * replace, not a merge.
 */
export const trackerSnapshotValidator = v.object({
  trackerId: v.string(),                        // trk_…
  status: v.string(),                           // EasyPost status enum, verbatim
  statusDetail: v.optional(v.string()),
  updatedAt: v.number(),                        // EasyPost updated_at, ms
  lastScanAt: v.optional(v.number()),           // newest scan's `at`
  estDeliveryAt: v.optional(v.number()),
  publicTrackingUrl: v.optional(v.string()),    // https only
  scans: v.array(trackingScanValidator),        // oldest → newest, full list
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
  // Absent when the ref cannot be attributed to any set attached to this
  // card's parent row. The ref is still the card's marketplace identity and
  // must never be dropped for want of a source — an unattributed ref is
  // reported, the same way an orphaned one is. It simply cannot participate
  // in sync-by-set until an operator attaches the set it came from.
  src: v.optional(v.string()),
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
/**
 * NEO-239 — the `metadata` FIELDS, exported so every validator that speaks
 * metadata is BUILT from this one definition.
 *
 * Same lesson as `selectorOptionFields` above, learned the same way. Four
 * places re-typed this three-field object by hand — `getAncestorChain`'s
 * `returns`, `storeReconciledOptions`' args, `setVariantTypePlatformData`'s
 * args and `updateSelectorOptionMetadata`'s args — and when NEO-239 added
 * `isBase` to the table, `getAncestorChain` started throwing
 * `Object contains extra field 'isBase'` for every chain containing a Base
 * row. Server-side, so the SetSelector page error-boundaried the moment the
 * flag existed: the seed flow synced variant types, the flag was written
 * correctly, and the NEXT query to walk that chain took the page down.
 *
 * A required-object caller writes `v.object(selectorOptionMetadataFields)`;
 * an optional one uses `selectorOptionFields.metadata`. Neither re-lists a
 * field, so the next addition here reaches all four for free.
 */
export const selectorOptionMetadataFields = {
  cardNumberPrefix: v.optional(v.string()),   // e.g. "DK-" for Diamond Kings
  isInsert: v.optional(v.boolean()),
  isParallel: v.optional(v.boolean()),
  /**
   * NEO-239 — "this variantType row is the set's BASE", as an NB ROLE.
   *
   * Was detected by comparing the display value to the literal `"base"`,
   * which made an NB behaviour depend on a name that came from a
   * marketplace, and broke the moment an operator renamed the row. The role
   * is decided ONCE — when the variantType row is created from BSC's `base`
   * variant slot — and read from here afterwards, so a rename is free.
   *
   * Absent means "not the base", including on rows written before this
   * field; `backfillVariantFacetAndBaseRole` sets it on the existing ones.
   */
  isBase: v.optional(v.boolean()),
};

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
  // NEO-189 — slot → which BSC FACET that slot's id belongs to.
  //
  // A BSC id is not self-describing: `topps-series-1` is a value of the
  // `setName` facet, `dugout-collection-artists-proofs` is a value of the
  // `variantName` facet. The checklist fetch used to guess from the NB LEVEL
  // of the row holding the id, which is wrong for the case this feature
  // exists for — BSC files Topps Series 1 and Series 2 as two `setName` sets
  // while SportLots has one set, so a **setName** id has to hang off a Base
  // (`variantType`) row. Level-guessing discarded those ids silently.
  //
  // Keyed by SLOT, in a map parallel to `platformLabels`, rather than encoded
  // into the slot key or the id:
  //   • the slot key is already stored on every card as `platformData.*.src`,
  //     so re-namespacing it would mean rewriting card pointers — the exact
  //     silent-repointing hazard slots were introduced to avoid;
  //   • folding it into the id would corrupt the value adapters filter on and
  //     every equality check that compares ids;
  //   • a parallel slot-keyed map inherits the allocation and detach
  //     lifecycle that already works, and gets the right default for free.
  //
  // ABSENT = written before NEO-189. That is inert, not unknown: the fetch
  // falls back to the old level rule and nothing infers a facet, because a
  // wrong guess changes which marketplace sets a live checklist sources.
  //
  // BSC only — SportLots has one unit of attachment, so there is nothing to
  // disambiguate. See convex/bscFacets.ts.
  //
  // NEO-239 widened the union with `variant`. THE VALIDATOR MUST BE DEPLOYED
  // BEFORE ANYTHING WRITES ONE — a `variant` tag written against the old
  // two-literal union is rejected at write time, and a row that already
  // carries one cannot be READ back by a rolled-back deployment either (Convex
  // validates documents on read as well). Rolling this deployment back after
  // the backfill has run therefore breaks reads on every tagged row; the
  // recovery is to roll forward, not back.
  platformFacets: v.optional(v.object({
    bsc: v.optional(
      v.record(
        v.string(),
        v.union(
          v.literal("setName"),
          v.literal("variantName"),
          v.literal("variant"),
        ),
      ),
    ),
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
  /**
   * @deprecated NEO-239 — DEAD FIELD. Nothing reads it and nothing writes it.
   *
   * It used to mean "a human typed this row", and five unrelated behaviours
   * hung off that one bit: whether marketplaces were queried, whether the
   * attach panel rendered, whether the row could be renamed, whether its cards
   * survived a re-sync, and a "Custom" badge. Every one of those is now
   * expressed as what the row actually CARRIES — marketplace ids per side, an
   * `isBase` role, a card's `platformData.<side>.ref`. There is no custom kind
   * of row.
   *
   * Kept optional and unread rather than dropped: removing a field from the
   * schema needs a backfill over every existing row, and the `city` /
   * `league → leagueId` precedent (NEO-236) is to leave the tombstone until a
   * ticket clears the data. Do not reintroduce a read.
   */
  isCustom: v.optional(v.boolean()),
  createdByUserId: v.optional(v.string()), // Audit trail for hand-added entries
  // Built from `selectorOptionMetadataFields` above — never re-listed here.
  metadata: v.optional(v.object(selectorOptionMetadataFields)),
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
  // NEO-211 — a marketplace label this row's operator has already said NO to.
  //
  // The sync never renames a row: it stores what the marketplace calls the set
  // (`platformLabels[side][primarySlot]`) and `getSelectorSyncSuggestions`
  // derives "upstream calls this something else" from the difference. Without
  // this field a deliberate NB rename would be re-suggested on every single
  // re-sync forever, which trains the operator to dismiss the one notice that
  // matters.
  //
  // Stored NORMALISED (`selectorValueKey`, i.e. lowercase+trim) and compared
  // normalised, so a re-cased "TOPPS" does not re-open a decision already made
  // about "Topps". Cleared the moment that side's label becomes something
  // genuinely new — a decline is a decision about ONE label, not a permanent
  // mute on the side.
  declinedUpstreamLabels: v.optional(v.object({
    bsc: v.optional(v.string()),
    sportlots: v.optional(v.string()),
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
  /**
   * NEO-120 — one row per postage label actually bought from EasyPost.
   *
   * **This IS the shipments table** (NEO-121 decision 2). The ticket named a
   * separate `shipments` table before NEO-120 landed this one; renaming a
   * Convex table is a copy migration for no gain, so scan visibility was added
   * here as optional fields instead. Rows bought before NEO-121 stay valid and
   * simply render as "no scans yet".
   *
   * `easypostShipmentId` is stored alongside `labelUrl` on purpose — **EasyPost
   * label URLs expire.** The shipment id is how a reprint re-fetches a fresh
   * URL; a stored URL alone silently stops working after a while. It is also
   * the webhook's lookup key, hence `by_shipment`.
   *
   * `toAddress` is a snapshot, not a reference: what was on the label is a
   * historical fact and must not change if anything else is later edited.
   *
   * **The tracker fields below are seller-forgeable and are never proof of
   * delivery.** A seller can read their own webhook URL and HMAC secret in
   * their EasyPost dashboard, so they can post whatever tracker they like to
   * their own ingest path. That is acceptable — the blast radius is fake scan
   * lines on their own rows — but nothing downstream may treat these fields as
   * evidence that a package moved, was delivered, or was ever mailed. For a
   * letter there is no delivery scan at all: `out_for_delivery` is the normal
   * terminal state.
   *
   * Every stored tracker string is TRUNCATED and `scans` is CAPPED (newest
   * kept) by `shipmentTracking.applyTrackerSnapshot`, so a hostile payload
   * cannot push a row past the Convex document limit and turn EasyPost's
   * retry policy into a loop. Scans are a snapshot on the row rather than a
   * table because every event carries the full history (decision 3).
   *
   * **No sale linkage yet** (decision 7). Convex optional fields are additive
   * with no migration, so the day sales exist this gains `saleId?:
   * v.id("sales")` in one line. A field that is never written is a reader
   * trap, so there is deliberately no placeholder here.
   */
  labelPurchases: defineTable({
    userId: v.string(), // Clerk user ID
    easypostShipmentId: v.string(),
    trackingCode: v.string(),
    // Integer cents. Postage arrives as a decimal string ("0.78") and float
    // money accumulates error the moment you total a month of it.
    costCents: v.number(),
    weightOz: v.number(),
    toAddress: postalAddressValidator,
    labelUrl: v.string(),
    purchasedAt: v.number(),

    // NEO-121 — scan visibility. All optional: absent on every row bought
    // before this shipped, and on any row whose tracker has not reported yet.
    trackerId: v.optional(v.string()),            // trk_…, from the buy response or the first event
    trackingStatus: v.optional(v.string()),       // EasyPost status enum verbatim; the UI maps it to words
    trackingStatusDetail: v.optional(v.string()),
    trackerUpdatedAt: v.optional(v.number()),     // EasyPost updated_at (ms) — the monotonic guard
    lastScanAt: v.optional(v.number()),           // newest scan's time
    estDeliveryAt: v.optional(v.number()),
    publicTrackingUrl: v.optional(v.string()),    // EasyPost public_url; https only, checked before storing
    scans: v.optional(v.array(trackingScanValidator)), // capped at 50, newest kept
    // Server-side cooldown for the seller-facing "Check for new scans"
    // button: a refresh within 60 s is answered from the row without calling
    // EasyPost, so a click loop cannot burn the seller's key or 429 the buy
    // path. Distinct from `trackerUpdatedAt`, which is EasyPost's clock.
    lastRefreshAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_shipment", ["easypostShipmentId"]),

  /**
   * NEO-121 — one row per seller, holding that seller's EasyPost webhook
   * registration. Under NEO-120 every seller has their own EasyPost account,
   * so a webhook has to be registered on each account with that seller's key
   * (through the browser service — the key never reaches Convex).
   *
   * **Why a per-seller token AND a per-seller secret** (decision 4): Convex
   * mints a random 32-byte URL token and a separate random 32-byte HMAC
   * secret per seller, and registers
   * `${CONVEX_SITE_URL}/webhooks/easypost/<urlToken>` with that secret. The
   * token finds this row; the row's secret verifies the body. There is no
   * shared platform secret to keep in sync across dev / preview / prod, and
   * one seller's secret forges nothing for another seller.
   *
   * **`urlToken` is a bearer credential**, not just an identifier: anyone
   * holding it can post to that seller's ingest path (the HMAC still gates
   * the write, but the token must be handled like the secret). Neither
   * `urlToken` nor `secret` may ever appear in a public validator, in any
   * response, or in a log line on either service.
   *
   * `lastError` is an NB-authored enum for exactly that reason: EasyPost's own
   * error text echoes the URL it rejected, and that URL contains the token, so
   * storing the upstream message would write the bearer credential into a
   * field a client could read.
   *
   * One row per user. Re-registration patches this row rather than inserting;
   * `url` is stored so a changed `CONVEX_SITE_URL` re-registers.
   */
  easypostWebhooks: defineTable({
    userId: v.string(), // Clerk user ID
    urlToken: v.string(), // SECRET — bearer credential, never leaves the server
    secret: v.string(),   // SECRET — HMAC key, never leaves the server
    webhookId: v.optional(v.string()), // hook_…; absent while registration is pending or failed
    mode: v.optional(v.union(v.literal("test"), v.literal("production"))),
    url: v.string(), // what was actually registered
    registeredAt: v.optional(v.number()),
    lastAttemptAt: v.number(), // read by the retry gate (>= 1h between attempts)
    lastError: v.optional(
      v.union(
        v.literal("rejected"),     // EasyPost refused the registration
        v.literal("unauthorized"), // the seller's key was rejected
        v.literal("unavailable"),  // browser service unreachable, or a preview site
        v.literal("no_key"),       // the seller has no EasyPost key saved
      ),
    ),
    lastEventAt: v.optional(v.number()), // last verified event we accepted
    disabledAt: v.optional(v.number()),  // mirrored from EasyPost if we learn of it
  })
    .index("by_user", ["userId"])
    .index("by_token", ["urlToken"]),

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
      // NEO-141: the marketplace session is dead and cannot be renewed from
      // what we hold (we no longer store a password), so the user must supply
      // it again. Distinct from `hasCredentials: false` — the secret still
      // exists and still holds the username. `needsReauthSince` is the epoch-ms
      // first-detection time (not refreshed on repeat detections). Both
      // optional: existing rows read as "no re-auth needed" (no migration).
      needsReauth: v.optional(v.boolean()),
      needsReauthSince: v.optional(v.number()),
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
    // NEO-211 adds "done": a sync that SUCCEEDED but has something the admin
    // needs to see — marketplace links that were detached because upstream
    // stopped listing them, and/or a platform that could not be reached while
    // the other one stored fine. The happy-and-quiet path still deletes the
    // row, so "done" means "there is a notice here", not "finished".
    status: v.union(v.literal("syncing"), v.literal("error"), v.literal("done")),
    message: v.optional(v.string()),
    requestId: v.optional(v.string()),
    // NEO-211 D — rows whose marketplace link was removed because that side
    // was fetched successfully and did not return the id. The ROW is never
    // deleted (sets are fixed), so this is the only trace the event leaves;
    // per Jason 2026-09-03 nothing else is persisted to remember it.
    //
    // Capped at UNLINK_NOTICE_LIMIT entries with the true count in
    // `unlinkedTotal` — a status row is read reactively by every open column,
    // and an unbounded list on a bad re-sync would be shipped to the browser
    // on every keystroke elsewhere in the tree.
    unlinked: v.optional(
      v.array(
        v.object({
          // NEO-219: may DANGLE. `deleteSelectorOption` sweeps the status rows
          // keyed on the deleted row (its child columns'), but not one that
          // merely NAMES it here — a sibling column's notice can outlive the
          // row it points at. Inert today: the notice renders `value`, which
          // is denormalised right here, and the id is only ever used to scroll
          // to a row that is either present or not. Anything that starts
          // dereferencing this id must tolerate a null `ctx.db.get`.
          id: v.id("selectorOptions"),
          value: v.string(),
          side: v.union(v.literal("bsc"), v.literal("sportlots")),
          // Whether the row carries a stored checklist. Only meaningful at the
          // levels that can (variantType/insert/parallel); absent elsewhere.
          hasCards: v.optional(v.boolean()),
        }),
      ),
    ),
    unlinkedTotal: v.optional(v.number()),
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
    // NEO-102: an OPERATOR decided this card carries no team at all.
    //
    // DISTINCT FROM `teamCheckDoneAt` above, which means only that the BSC
    // per-card lookup RAN, regardless of outcome. The distinction is
    // load-bearing rather than pedantic: every teamless card synced before
    // this feature existed already carries `teamCheckDoneAt`, so conflating
    // the two would make every one of those cards permanently invisible to the
    // reconciliation this field exists to drive. A card the background queue
    // merely CHECKED still needs a human — that is the whole point — while a
    // card a human deliberately marked teamless does not.
    //
    // The two together are what `features/cardAttention.ts` reads to decide
    // whether a stored card is badged "missing team": empty `teamOnCardIds`
    // alone cannot distinguish "no team on this card" from "nobody has looked
    // yet", and these two fields are exactly the missing bits.
    //
    // Set ONLY by an operator action (`cardChecklist.confirmCardNoTeam`), and
    // server-stamped — no client-supplied argument anywhere on this path
    // carries a timestamp, because a forgeable one is operator-review
    // suppression the client can mint for itself. CLEARED the moment a
    // non-empty `teamOnCardIds` is actually written in the same transaction
    // (`updateCard`, or the commit's reviewed content patch), so it can never
    // contradict the teams on the row. Never touched by a linkage-only
    // re-sync, and never set or cleared by a sync that carries no teams.
    teamNoneConfirmedAt: v.optional(v.number()),
    // The Clerk subject of the operator who confirmed it — same shape and
    // purpose as `players.createdByUserId` and
    // `entityReviewQueue.createdByUserId`. Audit only: no UI reads it.
    // (`getCardChecklist` does list it in its `returns`, because that
    // validator is strict and would otherwise reject every row carrying it —
    // that query is admin-gated.)
    //
    // A Clerk subject STRING rather than an `Id<"users">`: `requireAdmin`
    // returns the subject, and while a `users` table exists in this schema,
    // nothing in `convex/` has ever written or read a row in it — so there is
    // no document to point at, and every other audit column in this codebase
    // is the subject string.
    teamNoneConfirmedByUserId: v.optional(v.string()),
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
    // LEGACY (NEO-217). The raw marketplace autograph string ("On-Card" /
    // "Sticker" / "Cut", and SportLots' literal "Unknown"). Still arrives on
    // the commit wire and is still derived into `features.autographed` at
    // insert — that derived value is the one truth for "this card is an
    // autograph". No longer written on insert, no longer displayed on the
    // row, and no longer diffed by the NEO-203 re-sync review. Kept only for
    // rows written before NEO-217; there is no backfill.
    autographType: v.optional(v.string()),
    // NEO-189: this card's VARIATION name — "Action", "Nickname", "Sliding",
    // "Standing by bucket". One NeonBinder name per card, settled when the
    // sources are paired at import; a marketplace's own wording is never
    // stored.
    //
    // A plain string, deliberately, with no vocabulary table behind it:
    // variation names are per-card and very often have no reuse at all, so a
    // shared list would be one row per card wearing a join.
    //
    // Feeds the eBay Parallel/Variety aspect (via deriveCardFeatures'
    // `parallelName`) and listing-title generation, which is why only a real
    // printing variety may reach it — see `parseVariationDescription` in
    // adapters/buysportscards.ts for the shelf notes that used to leak in here.
    cardVariation: v.optional(v.string()),
    // NEO-189: when this card is a VARIATION of another card in the same set,
    // the card it varies. Absent on a normal card and on a parent.
    //
    // A variation is the same checklist slot printed a second way — a different
    // photo, a nickname on the nameplate, an outright error. NOT a parallel: a
    // parallel is a whole alternate printing of a set and is already its own
    // `selectorOptions` row with its own checklist. The two axes are
    // orthogonal; a parallel's checklist can itself contain variations.
    //
    // WHY A POINTER, NOT A DERIVED GROUPING
    //
    // The obvious alternative is to derive the relationship from the card
    // number — BSC suffixes a variation (`11` → `11b`), so `11b` "obviously"
    // belongs to `11`. Three things kill that:
    //
    //   1. `updateCard` lets `cardNumber` be patched freely. A derived grouping
    //      silently breaks the first time an operator corrects a number.
    //   2. The parent is not always the bare number. 2021 Topps has no card #1
    //      at all — it ships `1a` (base), `1b`, `1c`. 150 of its 660 stems have
    //      no bare-numbered row.
    //   3. SportLots does not suffix at all. It gives every variation of #13
    //      the number `13` and distinguishes them in the description, so there
    //      is nothing to derive from on that side.
    //
    // The suffix is still how the link is DERIVED at import (see
    // `resolveVariationParents` in lib/cards/variations.ts) — it just is not
    // what the link IS.
    //
    // A variation is a FULL CARD, not a delta on its parent: `playerIds`,
    // `cardName`, `teamOnCardIds`, `printRun`, `features`, `sku` and both
    // platform refs are all independently its own. Do not inherit-and-lock from
    // the parent — under the hobby's "Legend" convention a variation is
    // routinely a different player entirely (2021 Topps #52 is Archie Bradley;
    // 52b/52c/52d are Mickey Mantle).
    //
    // Deleting a parent must clear this on its children — see `deleteCard`,
    // which follows the same discipline `deleteCardCrossListingsFor` already
    // establishes for junction rows.
    variationOfCardId: v.optional(v.id("cardChecklist")),
    // NEO-189: the operator set this parent by hand, so automation must leave
    // it alone.
    //
    // Without this a re-sync silently undoes the correction: the commit pass
    // re-derives every link from the card-number stem and clears any row it
    // did not derive, so a hand-set parent survives exactly until the next
    // fetch. That is the same failure NEO-137 fixed for card pairing, and it
    // is fixed the same way — `placeholderPairs.mechanism: "manual"` marks a
    // pair the automatic diff must skip, and this marks a parent link the
    // automatic diff must skip.
    //
    // Set only by `setCardVariationParent` and by a custom card created with a
    // parent. Never set by the marketplace commit path.
    variationParentManual: v.optional(v.boolean()),
    // NEO-25: marketplace-agnostic listing title & description, authored once
    // and reused by every marketplace adapter (eBay/SportLots/BSC/MySlabs/
    // MyCardPost) so a listing doesn't recompute the title each time. NOT
    // eBay-specific. Manually edited today in the card detail panel; an
    // auto-generator (composed from the card's resolved features) is a
    // separate follow-up ticket. Optional + additive — absent on legacy rows.
    listingTitle: v.optional(v.string()),
    listingDescription: v.optional(v.string()),
    // NEO-101: the auto-generated title's CORE (year / manufacturer / set /
    // players) did not fit inside eBay's 80-character cap at creation time, so
    // the generator cut it at a word boundary to keep room for the card number.
    // The title is valid and listable — it is just missing identifying words a
    // human should put back, which is why this drives a "needs attention" item
    // (`features/cardAttention.ts` → `titleTruncated`) rather than an error.
    //
    // Set ONLY at insert, from `assessListingTitle(...).coreFits === false`,
    // and omitted entirely otherwise. CLEARED (patched to `undefined`) by any
    // operator write of `listingTitle` through `updateCard`: once a human has
    // authored the title, whether the machine's attempt fit is no longer a
    // question anyone is asking.
    //
    // WHY IT IS STORED AT ALL, when nothing else about the write-once
    // generation is: a stored row does not carry the player names or the set
    // name the title was built from — those live behind `playerIds` and an
    // ancestor walk — so "did the core fit?" cannot be re-derived from the row
    // the way `titleOverLimit` (just measure the string) can. Recomputing it
    // would mean re-resolving names for every row on every render.
    listingTitleTruncated: v.optional(v.boolean()),
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
    /**
     * @deprecated NEO-239 — DEAD FIELD on the write side. Nothing writes it.
     *
     * "Is this card ours or the marketplace's?" is answered by the row itself:
     * `platformData.bsc?.ref || platformData.sportlots?.ref` (see
     * `hasMarketplaceRef`). A card with no ref is preserved across a re-sync,
     * sorts after the marketplace numbers and is never reported as dropped
     * upstream — because it has no upstream, not because a human made it.
     *
     * Still READ by an old SPA bundle to render the retired "Custom" badge, so
     * it stays in the validator (a whole-row `returns` must list every field a
     * document can carry) until a backfill ticket clears the data.
     */
    isCustom: v.optional(v.boolean()),
    // Player names declared on a hand-added card before the players exist as
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
    .index("by_selector_option_and_number", ["selectorOptionId", "cardNumber"])
    // NEO-189: "give me this card's variations" as one indexed read rather than
    // a scan of the set. Also what `deleteCard` uses to find the children whose
    // pointer it must clear.
    .index("by_variation_parent", ["variationOfCardId"]),

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
    .index("by_sport_id", ["sportId"])
    // NEO-147: the first search index in the codebase, backing
    // `PlayerAutocomplete`. Every typeahead before this one fetched up to 500
    // rows and filtered client-side with `.includes()` — workable for an admin
    // scoped to one sport, not for a collector searching the whole player
    // universe from the spine-label designer.
    //
    // Indexed on `name`, NOT `nameNormalized`: `normalizePlayerName()` sorts
    // the name's tokens alphabetically for dedup, so "Ken Griffey Jr" is
    // stored as "griffey jr ken". Prefix search over that returns nonsense
    // ordering and misses the obvious query. The search index does its own
    // tokenization and is case-insensitive, so the raw display name is both
    // correct and what the user is actually typing.
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["sportId"],
    }),

  // NEO-156: leagues as a first-class entity.
  //
  // `teams.league` was a free-text string, and nothing populated it reliably —
  // 0 of 35 dev teams and 2 of 58 prod teams carried one. Every team belongs to
  // a league, so the relationship is modelled rather than typed.
  //
  // A REFERENCE, not a copied display label. Same lesson as NEO-96: when
  // `teams.sport`/`players.primarySport` held display strings, three writers
  // populated them with two different casings and reads silently missed each
  // other, duplicating entities. A league renamed here stays the same row.
  //
  // Rows are seeded on demand from the sport's `sportConfig` — `league` gives
  // the abbreviation ("MLB") and `espn.leagueName` the full name ("Major League
  // Baseball") — so neither is invented here. Leagues an operator adds by hand
  // carry whatever they typed.
  leagues: defineTable({
    name: v.string(),
    // Short form for dense UI (a team list showing league beside each name).
    // Optional because an operator-added league may only have one form.
    abbreviation: v.optional(v.string()),
    nameNormalized: v.string(),
    // Leagues are per-sport: "National League" means nothing without one, and
    // two sports can legitimately hold the same league name.
    sportId: v.id("selectorOptions"),
    // NEO-240: where this league sits in the professional pyramid.
    //
    // Added now, rather than when someone asks for a filter, because Wikidata
    // career-team enrichment (`players.teamYears`, P54) routinely returns MiLB
    // clubs — a player's stints at Durham and Scranton arrive alongside the MLB
    // ones — and each of those clubs creates a league row through
    // `findOrCreateLeague`. Without a level, an operator opening League
    // Management sees "Major League Baseball" and "International League" as
    // peers, with nothing on the row saying which one a card set is about.
    //
    // Optional because it is not knowable for every row: no backfill was run
    // (NEO-240 decision), so every pre-existing league carries no level, and an
    // operator-added league only has one once someone says so. Unset sorts LAST
    // in `listForManagement`, not first — an unclassified row is the one the
    // operator has work to do on, and burying it at the top would hide the
    // classified majority.
    level: v.optional(
      v.union(
        v.literal("major"),
        v.literal("minor"),
        v.literal("college"),
        v.literal("international"),
        v.literal("independent"),
        v.literal("other"),
      ),
    ),
    // NEO-240: the league's own lifespan, mirroring `teams.yearsActive`.
    //
    // Vintage sets reference leagues that no longer exist (the Federal League,
    // the ABA, the Negro Leagues), and "when did this exist" is the fact that
    // tells an operator whether a 1914 set's league is the row in front of them
    // or a same-named successor. `to` absent means still active.
    yearsActive: v.optional(
      v.object({
        from: v.number(),
        to: v.optional(v.number()),
      }),
    ),
    // NEO-240: same container shape as `players.externalIds` / `teams.externalIds`.
    // A `Q<digits>` id validated through `lib/players/wikidata-id.ts` at every
    // write; nothing else stores an unvalidated id here, because a malformed one
    // is worse than a missing one (it reads as "already enriched" forever).
    externalIds: v.optional(
      v.object({
        wikidataId: v.optional(v.string()), // e.g. "Q1163715"
      }),
    ),
    // NEO-240: other names the SAME league answers to.
    //
    // Two independent sources of them. (1) Operators: "MLB", "the American
    // League" and "Major League Baseball" are one row in this hobby's usage,
    // and typing any of the three anywhere a league is resolved must land on
    // it rather than mint a fourth row. (2) Wikidata: a club's P118 (league)
    // resolves to a label whose wording is often not ours ("Major League
    // Baseball" vs "MLB"), and matching on the canonical name alone would
    // duplicate the row on every enrichment pass.
    //
    // Marketplaces contribute NOTHING here — none of the five sends a league
    // string at all — so this list is entirely NB's own vocabulary, and no NB
    // behaviour keys on a marketplace value through it.
    //
    // Matched normalised (`normalizeLeagueName`), so casing and punctuation
    // differences do not need their own entries. An alias equal to the row's
    // own name is redundant and is dropped rather than stored.
    aliases: v.optional(v.array(v.string())),
    lastUpdated: v.number(),
  })
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
    // NEO-156: the league this team plays in. Every creation path attaches one
    // through `leagues.resolveDefaultLeagueId`, so a team without it is either
    // a pre-NEO-156 row or one whose sport has no configured league.
    leagueId: v.optional(v.id("leagues")),
    // DEPRECATED (NEO-156) — the free-text predecessor of `leagueId`. Kept so
    // existing rows still validate and so the backfill has something to read;
    // `backfillLeagueIds` resolves it to a real row. Nothing writes it any
    // more, and reads prefer `leagueId`. Remove once prod shows zero rows
    // carrying it and no `leagueId`.
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
    // NEO-147: provenance for `colors`, now that teamcolorcodes.com is the
    // primary source (see convex/adapters/teamColorCodes.ts). Presence means
    // "this row has been resolved against that site", and it is what makes the
    // backfill re-runnable without redoing work: `enrichUnenrichedTeams` skips
    // any row carrying it, including one a human resolved by hand.
    colorSource: v.optional(v.object({
      url: v.string(),
      // The source-side name that won, kept so a human auditing a suspicious
      // match can see what it matched against — our "UConn Huskies baseball"
      // resolves to the site's "connecticut huskies", which looks wrong until
      // you see both names side by side.
      matchedName: v.string(),
      resolvedAt: v.number(),
    })),
    // NEO-147: set when a name matched MORE THAN ONE source page — there are
    // 10+ distinct "Huskies" teams on the site. Never guessed: the team editor
    // presents these for a human to pick, which writes `colorSource` and
    // clears this. Follows the entityReviewQueue principle (a human confirms
    // ambiguity) without reusing that table, which is scoped to one fetch
    // batch and consumed by its own wizard.
    colorCandidates: v.optional(v.array(v.object({
      name: v.string(),
      url: v.string(),
    }))),
    externalIds: v.optional(v.object({
      wikidataId: v.optional(v.string()),
      espnId: v.optional(v.string()),
    })),
    lastUpdated: v.number(),
  })
    .index("by_name_normalized", ["nameNormalized"])
    // Same compound-index optimization as players above. See its comment.
    .index("by_name_normalized_and_sport_id", ["nameNormalized", "sportId"])
    .index("by_sport_id", ["sportId"])
    // NEO-240: the reverse of `teams.leagueId`, for League Management's
    // "teams in this league" panel. Without it that panel is a full `teams`
    // scan filtered in memory per selected league — the same shape the
    // `by_sport_id` index above exists to avoid, and it gets worse as the
    // MiLB/defunct-franchise rows arrive.
    .index("by_league_id", ["leagueId"])
    // NEO-212: mirrors players.search_name. The entity-review wizard's team
    // pickers (and the team editor's) were the same 500-row fetch + client-side
    // `.includes()` filter that NEO-147 removed from the player typeahead —
    // fine while a sport had a few dozen teams, wrong once the league/defunct
    // franchise backfill grew the table. Indexed on `name` (the raw display
    // name the operator types), filterable by `sportId` so a football set never
    // matches a baseball team.
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["sportId"],
    }),


  // NEO-92: per-fetch review queue backing the step-through "new players &
  // teams" wizard (replaces the old single-screen checkbox dialog). One row
  // per unknown name surfaced by fetchCardChecklist. NEO-99: the Wikidata pool
  // (convex/wikidataPool.ts) drains "pending" rows 5 at a time via the
  // runEntityReviewLookup work item, patching status/enrichment as each lookup
  // completes — the wizard subscribes reactively and presents rows in
  // COMPLETION order (whichever finishes first), not original fetch order.
  // `decision` is patched by the user's own action in
  // the wizard (recordDecision) — durable across a page refresh, unlike
  // keeping it only in React state. NEO-212: a third "skip" decision variant
  // now exists alongside create/link. Skip means "not a person / not a team" —
  // the card keeps the raw name as free text, and nothing is created or linked.
  // It is the escape hatch for the junk that BSC checklists carry in player
  // columns (header rows, "CHECKLIST", sponsor text), which previously had to
  // be created as a bogus player just to clear the wizard. A skip is recorded
  // durably in `entityReviewSkips` (below) at commit time so the same name
  // never re-enters the wizard for that set.
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
      // NEO-235, player-only. Team NAMES that Wikidata links to the player
      // with NO usable start year (Tony Gwynn's "San Diego State Aztecs
      // baseball" P54 statement carries no P580/P582 at all). They cannot
      // become `careerTeams` entries — that shape requires `fromYear`, and
      // synthesizing one from the player's work period fabricates a stint that
      // never happened — so they are surfaced by name instead of dropped
      // silently, for the wizard to show and an operator to date by hand.
      undatedCareerTeams: v.optional(v.array(v.string())),
      isHallOfFame: v.optional(v.boolean()),
      // NEO-212, player-only disambiguation context. Wikidata routinely returns
      // several entities for one card name ("Chris Johnson" is a running back,
      // an outfielder and a British cyclist), and a bare label gave the
      // operator nothing to choose on. All three are best-effort: a real but
      // thinly-documented player has none of them.
      // Wikidata's English `schema:description` ("American football running
      // back").
      description: v.optional(v.string()),
      birthYear: v.optional(v.number()),
      // Title of the English Wikipedia article (enwiki sitelink), so the wizard
      // can link out to the full article for a human to confirm against.
      enwikiTitle: v.optional(v.string()),
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
        // NEO-212, player-only: career-team labels that came back from
        // Wikidata (enrichment.careerTeams) but that the admin UNCHECKED in
        // the wizard. Commit must not create team rows for these. Recorded as
        // an exclusion list rather than a rewritten careerTeams array so the
        // decision stays auditable against what the lookup actually returned —
        // "the operator rejected these two" rather than a silently shorter
        // list. Names, matched against enrichment.careerTeams[].name.
        excludedCareerTeamNames: v.optional(v.array(v.string())),
      }),
      v.object({
        action: v.literal("link"),
        linkedPlayerId: v.optional(v.id("players")),
        linkedTeamId: v.optional(v.id("teams")),
      }),
      // NEO-212: "this name is not a person / not a team". Carries no payload —
      // nothing is created, nothing is linked, and the card keeps the raw name
      // as free text. Commit writes an `entityReviewSkips` row so the name
      // stays out of this set's wizard on every later fetch.
      v.object({ action: v.literal("skip") }),
    )),
  })
    .index("by_selector_option", ["selectorOptionId"])
    .index("by_selector_option_and_batch", ["selectorOptionId", "batchId"])
    .index("by_selector_option_and_user", ["selectorOptionId", "createdByUserId"])
    // NEO-99: lets the stale-pending sweep (crons.ts → sweepStalePendingRows)
    // read only rows in a given status, oldest-first (every Convex index is
    // ordered by its fields then `_creationTime` ascending). The sweep queries
    // `status = "pending"` and ages the ones older than the cutoff to "error",
    // so a lookup whose work item died mid-flight can never orphan a row on
    // "Looking up…" forever. Cheap in steady state: pending rows resolve within
    // seconds under the Wikidata pool, so the common run reads the oldest few,
    // finds none stale, and stops.
    .index("by_status", ["status"]),

  // NEO-212: durable record of names an operator decided are NOT an entity.
  //
  // Written by commitCardChecklist for every entityReviewQueue row decided
  // "skip", and consulted by resolveUnknownsAndStartBatch so a skipped name
  // never re-enters the wizard for that set. Without it a skip only survives
  // until the next fetch: entityReviewQueue rows are per-batch throwaways
  // cleaned up on commit, so the same "CHECKLIST" header row would be handed
  // back to the operator on every re-fetch of the set, forever.
  //
  // SCOPED PER SET, ON PURPOSE. The key is (selectorOptionId, kind,
  // nameNormalized), not a global name list. The junk that warrants a skip is
  // an artifact of one marketplace checklist's formatting, and a name that is
  // noise on one set is very often a real player on another — "Chase" is a
  // sponsor logo on one issue and a shortstop on the next. A global skip list
  // would let one operator's judgement on one set silently suppress a real
  // player everywhere, which is unrecoverable without an audit trail nobody
  // would think to check. Per-set keeps the blast radius to the set the
  // operator was actually looking at.
  //
  // `kind` is part of the key because a name can legitimately be skipped as a
  // player while still being a valid team on the same set (and vice versa).
  //
  // `skippedByUserId` is audit-only — unlike entityReviewQueue.createdByUserId
  // it does NOT scope reads. A skip is a fact about the set's data, so it
  // applies to every operator who fetches that set afterwards; scoping it per
  // user would just make each admin re-skip the same junk.
  entityReviewSkips: defineTable({
    selectorOptionId: v.id("selectorOptions"),
    kind: v.union(v.literal("player"), v.literal("team")),
    // Normalized form is what the lookup compares against, matching how
    // players/teams are deduped elsewhere.
    nameNormalized: v.string(),
    // Raw name as it appeared on the checklist, kept for display in any future
    // "review skipped names" admin surface — a normalized string is not
    // something a human should be asked to read back.
    name: v.string(),
    skippedAt: v.number(),
    skippedByUserId: v.string(),
    // The commit that recorded (or last refreshed) this skip. Optional because
    // rows written before this field existed have no answer, and because a
    // commit can run without a review batch at all.
    //
    // Audit context for the admin read-back in `convex/entityReviewSkips.ts`,
    // and the one field that makes "why is this name suppressed?" answerable:
    // it points at the review batch whose decisions produced the row, which is
    // what a Convex log search needs to reconstruct the session. Unlike
    // `skippedByUserId` it is safe to return to the client — it identifies a
    // batch, not a person.
    batchId: v.optional(v.string()),
  })
    // The only read pattern: "was this exact name skipped for this set as this
    // kind?" — one indexed point lookup per unknown name during resolution.
    // The prefix also covers a per-set (and per-set-and-kind) listing, which is
    // exactly what `entityReviewSkips.listForSet` reads for the admin
    // read-back / undo surface.
    .index("by_selector_option_and_kind_and_name", [
      "selectorOptionId",
      "kind",
      "nameNormalized",
    ]),

  // NEO-195: candidate cards for ONE checklist fetch, written as reconciliation
  // produces them so the review modal can fill in live instead of waiting for
  // the whole fetch.
  //
  // WHY A SEPARATE TABLE AND NOT cardChecklist
  //
  // The modal promises, in its own subtitle, "No cards are saved until you
  // confirm." Candidates are exactly the things that are NOT saved yet — the
  // operator may discard any of them — so they cannot live in the catalog.
  // Confirm promotes them; cancel drops them.
  //
  // WHY status EXISTS
  //
  // A fetch is fast (~6s) but the per-card BSC team lookup that follows is not
  // (~74s on a 743-card set). Showing a card before its team resolves is worse
  // than making the operator wait: it looks reviewable, so they either wait
  // anyway and gain nothing, or approve a card that was not ready. `status` is
  // the gate that makes streaming safe rather than merely faster.
  //
  // A row is `ready` only when everything a reviewer needs is on it — its
  // variation grouping, its players, its team.
  checklistCandidates: defineTable({
    selectorOptionId: v.id("selectorOptions"),
    // One fetch run. Scopes cleanup and keeps a stale run from bleeding into a
    // fresh one if an operator re-syncs before cancelling.
    batchId: v.string(),
    createdByUserId: v.string(),

    // ── the reconciled card, mirroring previewCardValidator ────────────────
    cardNumber: v.string(),
    cardName: v.string(),
    teams: v.optional(v.array(v.string())),
    players: v.optional(v.array(v.string())),
    attributes: v.optional(v.array(v.string())),
    isRookie: v.optional(v.boolean()),
    isRelic: v.optional(v.boolean()),
    printRun: v.optional(v.number()),
    autographType: v.optional(v.string()),
    cardVariation: v.optional(v.string()),
    isVariation: v.optional(v.boolean()),
    platformData: cardPlatformWireDataValidator,
    // NEO-199 — BSC and SportLots name this card differently. Written only on a
    // `matched` row whose two sides disagreed (see lib/cards/card-name.ts), so
    // a set where the marketplaces agree stores nothing extra on any of its
    // ~900 rows. `cardName` above is still BSC's answer; this is the one the
    // merge used to discard, kept so the review modal can offer the choice.
    nameConflict: v.optional(
      v.object({ bsc: v.string(), sportlots: v.string() }),
    ),

    // ── which column of the modal this belongs in ──────────────────────────
    bucket: v.union(
      v.literal("matched"),
      v.literal("bscOnly"),
      v.literal("slOnly"),
    ),
    // Pairing confidence for a matched row; the modal surfaces a fuzzy match
    // differently from an exact one.
    confidence: v.optional(v.number()),

    // ── streaming ─────────────────────────────────────────────────────────
    // Card-number stem. A parent and its variations share one, and the whole
    // group is released together — otherwise an operator reviews #20 and #20b
    // appears underneath it afterwards.
    stem: v.string(),
    status: v.union(v.literal("pending"), v.literal("ready")),
    lastUpdated: v.number(),
  })
    .index("by_batch", ["batchId"])
    .index("by_batch_and_status", ["batchId", "status"])
    // Cleanup, and the modal's live read. Both are per-OPERATOR, not per-row:
    // two admins syncing the same selectorOption at once each own their own
    // candidate set, so one operator's fetch must neither clear nor surface
    // the other's rows (NEO-195). `createdByUserId` therefore has to be part
    // of the index rather than an in-memory filter, and it comes second
    // because every caller fixes the selectorOption first.
    //
    // This REPLACED a bare ["selectorOptionId"] index. That index is a prefix
    // of this one, so a future genuinely-global per-row query is still served
    // here and a second index would only add write cost — a batch is ~900
    // inserts.
    .index("by_selector_option_and_user", [
      "selectorOptionId",
      "createdByUserId",
    ]),

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

  // Placeholder-upload job ownership record (NEO-148). Written by
  // createPlaceholderUploadUrl (convex/adapters/placeholderUploads.ts)
  // immediately after minting the signed POST policy, so the row exists
  // before the client ever uploads a byte.
  //
  // Its entire purpose is to make the path confinement enforceable AFTER
  // mint time, not just at mint time: every downstream function (NEO-151/152)
  // must take `jobId` ONLY, look up this row, verify `row.userId ===
  // identity.subject`, and re-derive `objectPath` FROM THE ROW — never
  // from a client-supplied argument.
  //
  // =====================================================================
  // NO FUNCTION ANYWHERE MAY ACCEPT `objectPath` AS AN ARGUMENT.
  // Scope: ALL THREE placeholder tables (placeholderJobs,
  // placeholderImages, placeholderPairs) and every function that touches
  // them — convex/placeholderPipeline.ts, placeholderBatch.ts,
  // placeholderPairing.ts, adapters/preprocess.ts.
  // =====================================================================
  // Both `neonbinder-convex` and the preprocess runtime SA hold
  // bucket-wide `roles/storage.objectViewer` on the placeholder-uploads
  // bucket (see neonbinder_ioc/main.tf) — they can read ANY user's
  // object, not just the caller's own. `jobId` (opaque, unguessable,
  // looked up server-side) is the only thing that keeps that bucket-wide
  // read grant from becoming a cross-user read oracle. An `objectPath`
  // argument would let a caller ask to read/process any other user's path
  // directly, bypassing the ownership check entirely — it doesn't matter
  // how well the check is written if the path never goes through it.
  //
  // NEO-170 extended this table with the batch lifecycle the original comment
  // reserved for NEO-151 (progress counts, per-image status, failure states),
  // and added the two tables below it. The rule above did NOT relax when it
  // did; it widened, which is why its scope line names three tables. In
  // practice every function takes `jobId` as its only client-supplied handle,
  // looks up THIS row, checks `row.userId === identity.subject`, and passes
  // `jobId` + `userId` to the preprocess service — which re-derives the object
  // path on its own side. `placeholderImages` and `placeholderPairs` carry
  // `userId` too so an ownership check never has to hop through a join it
  // might forget to make.
  placeholderJobs: defineTable({
    jobId: v.string(), // server-generated (crypto.randomUUID()) in createPlaceholderUploadUrl / startPlaceholderStream
    userId: v.string(), // Clerk user ID as string — ownership check is row.userId === identity.subject
    // Where this job's bytes live. In "zip" mode that is the single uploaded
    // archive, placeholders/{userId}/{jobId}/input.zip. In "stream" mode there
    // is no archive — the browser POSTs one image at a time straight into
    // extracted/ — so the row records the job PREFIX,
    // placeholders/{userId}/{jobId}/, which is what both modes actually have in
    // common. Either way it is re-derived server-side and is never client input.
    objectPath: v.string(),
    createdAt: v.number(),
    // How images get into this job (NEO-170 streaming intake). Optional, and
    // ABSENT MEANS "zip" — every row written before streaming existed is a zip
    // job, so backfilling the field would be a migration that changes nothing.
    // Readers must treat `undefined` and `"zip"` as the same thing; the one
    // place that must not is `startPlaceholderBatch`, which refuses `"stream"`
    // explicitly (there is no archive for it to extract).
    mode: v.optional(v.union(v.literal("zip"), v.literal("stream"))),
    // Which client started this run — a DISPLAY hint for the admin page ("ran
    // from the scanner CLI" vs "from the web app"), nothing more. Absent means
    // unknown, which is every row that predates the field. It is NOT a security
    // boundary and is deliberately spoofable: the client passes it, the server
    // stores it verbatim, and no decision anywhere is gated on it — so there is
    // nothing to gain by faking it. Kept to the two known clients as a union so
    // the value is at least well-formed.
    source: v.optional(v.union(v.literal("scanner"), v.literal("web"))),
    // Lifecycle (NEO-170). "pending" is what `insertPlaceholderJob` writes at
    // mint time. "uploaded" is RESERVED — nothing writes it yet, because
    // confirming that the client actually finished its PUT is a NEO-152
    // concern; it is in the union so that adding the confirm step later is not
    // a schema migration. Until then a batch is startable straight from
    // "pending", and starting one before the upload has landed fails with
    // INPUT_NOT_FOUND from `/extract` — a clean terminal failure on a job the
    // user can simply start again, which is why startable-from-pending is
    // safe rather than merely convenient.
    //
    // The batch then runs "extracting" → "processing" → "pairing" →
    // "succeeded", or lands on "failed" from any of them. "failed" is
    // deliberately re-entrant: starting a batch from "failed" re-registers the
    // zip's entries over the existing image rows, KEEPING the ones that already
    // reached "done" (see registerExtractedImages) and sweeping the previous
    // attempt's pairs. That is what makes a restart cheap — it never re-pays
    // Vision/Anthropic for an image that already succeeded — and it is the
    // difference between a retryable upload and a dead one.
    // `cancelPlaceholderBatch` forces this same "failed" state, so a job wedged
    // mid-flight has a recovery lever: cancel, then start again.
    //
    // "collecting" is the stream-mode entry state and has no zip-mode
    // counterpart: the job is open, the scanner is still feeding it images, and
    // each confirmed image is enqueued as it arrives. It leaves that state ONLY
    // through `closePlaceholderStream` (explicitly, or via the idle-timeout
    // cron), landing in "processing" when work is still draining or going
    // straight to "pairing" when it is not. It is deliberately NOT startable:
    // there is no archive to extract, and Start on a stream job is a category
    // error rather than a retry.
    status: v.union(
      v.literal("pending"),
      v.literal("uploaded"),
      v.literal("collecting"),
      v.literal("extracting"),
      v.literal("processing"),
      v.literal("pairing"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    // Progress counters (NEO-170). All optional so pre-NEO-170 rows — and the
    // row `insertPlaceholderJob` writes at mint time — stay valid without a
    // migration. `processedImages + failedImages === totalImages` is the
    // batch-complete condition; see recordImageOutcomeImpl.
    totalImages: v.optional(v.number()), // accepted entries the extract step found
    processedImages: v.optional(v.number()),
    failedImages: v.optional(v.number()),
    rejectedEntries: v.optional(v.number()), // zip members extract declined (not images, too big, etc.)
    startedAt: v.optional(v.number()), // when the batch was started, not when the job was created
    finishedAt: v.optional(v.number()),
    // Terminal failure detail. `errorCode` is the low-cardinality tag to group
    // and alert on (e.g. "ZIP_REJECTED", "TOO_MANY_IMAGE_FAILURES");
    // `errorDetail` is free text for a human reading one specific job.
    errorCode: v.optional(v.string()),
    errorDetail: v.optional(v.string()),
    // ---- stream mode only (NEO-170) ----
    // Next entry index `createPlaceholderImageUploadUrl` will hand out. The
    // transactional allocation counter: read, bounds-checked against
    // PLACEHOLDER_MAX_ENTRY_INDEX, and incremented inside one mutation, which
    // is what makes two concurrent upload-URL requests get 3 and 4 rather than
    // both getting 3 and writing over each other's object. Zip mode never sets
    // it — there the indexes come from `/extract`.
    nextEntryIndex: v.optional(v.number()),
    // Last time this job saw the user do anything: an upload-URL allocation, a
    // confirm, or an image completing. The idle sweep (crons.ts, every 10
    // minutes) closes any "collecting" job whose last activity is older than
    // PLACEHOLDER_STREAM_IDLE_MS, so a scanner session abandoned mid-batch
    // still reaches a terminal state instead of holding one of the user's two
    // active-job slots forever.
    lastActivityAt: v.optional(v.number()),
    // How many times pairing fell back to the identity resolver — as measured by
    // the FINAL pairing run, over the complete batch.
    //
    // PURE DIAGNOSTICS — not a spend figure, and NOT expected to be zero.
    //
    // This comment used to say "the number that matters is ZERO", on the
    // reasoning that the adjacency pre-pass should pair an in-order scan without
    // consulting identity once. That was true while pairing lived in preprocess
    // and `resolveIdentity` was a Haiku call. NEO-170 ended both halves of it:
    // identity is now produced by /process-entry and sits on this row, so
    // `resolveIdentity` is an in-memory Map lookup costing nothing, and pairing
    // deliberately runs `useAdjacency: false` — identity-first for EVERY card —
    // because the pre-pass matched on side-disagreement alone and produced real
    // mispairs (see the useAdjacency comment in placeholderPairing.ts).
    //
    // So one call per done image is the healthy reading, not a regression: the
    // release E2E asserts `resolver calls: 6` for a six-image batch, precisely
    // to prove identity-first pairing ran over all of them. What this number is
    // still good for is noticing that pairing ran at all, and over how much.
    //
    // ONLY the final run records it, and that is load-bearing rather than an
    // optimisation. Incremental pairing recomputes the whole batch after every
    // completion, and a run over a partial batch that ends on an odd prefix
    // ALWAYS has one trailing image with no partner yet — which goes to the pool
    // and costs a resolver call. Summing across runs would therefore report
    // roughly one per odd-length intermediate pass even for a perfectly ordered
    // scan, so the total would track how the completions happened to interleave
    // rather than anything about the batch, and "assert 0" would be unusable.
    // The final run sees every row, so its count is the honest answer for the
    // batch as a whole — and an image that genuinely needs the pool still needs
    // it there.
    //
    // Absent means 0, and nothing writes it on the healthy path. Reset with the
    // other counters on restart.
    resolverCalls: v.optional(v.number()),
    // Debounce latch for incremental pairing. Set when a completion schedules a
    // pairing run, cleared by that run before it reads any rows — so a
    // completion landing mid-run re-schedules and the result converges, while a
    // burst of completions between runs costs one run rather than one each.
    // Not a lock: it bounds how many runs are QUEUED, and the pairing writes are
    // an idempotent diff precisely because it does not bound how many overlap.
    pairingScheduled: v.optional(v.boolean()),
    // When the HEAVY preprocess service's warm-gate first fired for this batch
    // (NEO-175). Set by `settleImageOutcome` the first time a fast completion
    // escalates an image, alongside scheduling a single heavy `/warmup`. Its ONLY
    // job is to make that warm-up fire exactly once per batch — every later
    // escalation reads it set and skips the warm-up (a warm instance answers
    // immediately, so a stray extra would be harmless, but there is no reason to
    // send one). Absent means this batch has never needed the heavy service.
    // Reset with the other counters on restart.
    heavyWarmStartedAt: v.optional(v.number()),
  })
    .index("by_job", ["jobId"])
    .index("by_user", ["userId"])
    // Feeds the idle-stream sweep, and nothing else. The equality on `status`
    // keeps the scan inside the "collecting" jobs of the whole deployment
    // (there are never many — a job stops collecting within minutes), and the
    // range on `lastActivityAt` narrows it to the idle ones, so the cron reads
    // the rows it is about to close and no others. Without it the sweep would
    // be a full scan of every placeholder job ever created, ten minutes apart,
    // forever.
    .index("by_status_and_activity", ["status", "lastActivityAt"]),

  // One row per image the extract step accepted out of a placeholder upload
  // (NEO-170). This is the unit of work the preprocess workpool operates on:
  // one row ⇄ one `/process-entry` call ⇄ one work item.
  //
  // `entryIndex` is the entry index WITHIN the zip, assigned by the preprocess
  // service's extract step, and it is the only handle passed back to
  // `/process-entry`. It is not a path and cannot be pointed at another user's
  // upload — see the placeholderJobs comment above. (`index` would have been
  // the obvious name; it is spelled `entryIndex` because "index" next to
  // `.index(...)` in this file reads as the database concept, and because
  // `entry_index` is what crosses the wire to the service.)
  //
  // `workId` is the workpool's opaque handle, stored so cancelPlaceholderBatch
  // can cancel in-flight work. It is `v.string()` rather than a branded type
  // because the brand (`WorkId`) is a TypeScript-only phantom; the value on the
  // wire is a string.
  placeholderImages: defineTable({
    jobId: v.string(),
    userId: v.string(), // denormalized from placeholderJobs so ownership needs no join
    entryIndex: v.number(), // entry index within the zip (assigned by extract) or the stream (allocated by placeholderJobs.nextEntryIndex)
    originalName: v.string(), // the zip member's filename — used by adjacency pairing
    // "awaiting_upload" is the stream-mode entry state: the row and its object
    // key exist and a signed POST policy has been handed out, but the browser
    // has not yet told us the bytes landed. Such a row is NOT counted in
    // `totalImages` and is NEVER enqueued — `confirmPlaceholderImageUpload` is
    // what moves it to "queued" and does both. Closing or canceling the job
    // deletes whatever is still in this state, which is what keeps an allocation
    // whose upload was abandoned from wedging the batch-complete condition.
    status: v.union(
      v.literal("awaiting_upload"),
      v.literal("queued"),
      v.literal("processing"),
      v.literal("done"),
      v.literal("failed"),
    ),
    workId: v.optional(v.string()), // workpool handle, set once the row is enqueued
    // Identity + orientation, populated from the /process-entry response.
    // `players` is the canonical list (many for leaders/combo cards). There is
    // deliberately no `player` column: the service derives its `player` field
    // as `players[0]`, so a stored copy could never legitimately differ from
    // `players[0]` and could only ever go stale. Callers that want the single
    // headline name read `players[0]` themselves.
    players: v.optional(v.array(v.string())),
    team: v.optional(v.string()),
    cardNumber: v.optional(v.string()),
    side: v.optional(v.string()), // "front" | "back" as classified; string, not a union, because the service owns the vocabulary
    rotationDegrees: v.optional(v.number()), // CCW rotation applied before classification
    orientConfidence: v.optional(v.number()),
    textCount: v.optional(v.number()), // Vision word count — the free signal the adjacency pre-pass runs on
    croppedSource: v.optional(v.string()), // which stage of the crop cascade won
    dhash: v.optional(v.string()), // 16-char lowercase hex perceptual hash, consumed by pairing
    // Set true when the FAST preprocess service declined this image
    // (`needs_escalation: true`) and it was re-routed to the HEAVY service
    // (NEO-175). While `escalated === true && status === "processing"` the image
    // is heavy-processing: its `workId` (if any) is a HEAVY-pool handle, so
    // cancel must target the heavy pool for it, and the batch-level cold-start
    // notice scopes to exactly these rows. Absent/false = fast tier (the common
    // case). It stays set after the heavy result lands (a done/failed escalated
    // row keeps the flag), which is what lets the notice clear once the heavy
    // service has produced its first result. Reset with the other per-image
    // fields when a restart re-queues a non-done row.
    escalated: v.optional(v.boolean()),
    // File extension of the PROCESSED output object ("jpg" | "png" | "webp"),
    // memoised the first time a download URL is minted for this image.
    //
    // Not a copy of anything: the service does not report which extension it
    // wrote (`ProcessEntryResponse` has no such field, and the output's format
    // is whatever the CROPPED image sniffed as, not necessarily the input's), so
    // `createPlaceholderImageDownloadUrl` finds the object by trying the known
    // extensions in the service's own order and records the answer here. Absent
    // means "not looked up yet", never "no output" — the row's `status` is what
    // says whether an output exists.
    //
    // A cache, so it must stay derivable: deleting it costs one extra probe, not
    // correctness. If the service ever starts reporting the output type, this is
    // the column to populate at completion time instead.
    outputExtension: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorDetail: v.optional(v.string()),
    // Set by the pairing pass, not by processing. Absent means pairing has not
    // run for this row yet — distinct from "unmatched", which means it ran and
    // found nothing.
    pairStatus: v.optional(v.union(v.literal("paired"), v.literal("unmatched"))),
    // Entry indexes this image must never be AUTO-paired with again, because
    // the user explicitly split them (NEO-152).
    //
    // A manual PAIR was always durable — the row carries mechanism "manual" and
    // the matcher is told to leave it alone. A manual UNPAIR left no trace at
    // all, so on a still-running batch the very next incremental pass was free
    // to re-form the pair the user had just rejected. That made correcting a
    // live batch impossible and forced review to wait for the batch to finish,
    // which does not survive contact with a set upload of several hundred
    // cards: nobody waits.
    //
    // Scoped to the PAIRING, not the image: splitting A from B says "these two
    // are not partners", and leaves A free to pair with its real partner. A
    // flag on the image would have said "never pair A again", which is a much
    // bigger claim than the user made.
    //
    // Absent means no rejections. Cleared for a specific partner if the user
    // later pairs them by hand after all.
    unpairedFrom: v.optional(v.array(v.number())),
  })
    // The ONLY index this table needs. It answers both "every image of this
    // job" (prefix `jobId` alone) and "this job's images in zip order", so a
    // separate `by_job` on `["jobId"]` would be a strict prefix of this one —
    // a second copy of the same index, paid for on every write, that Convex
    // would never choose over this one for anything. Ordered iteration is a
    // hot path rather than a convenience: pairing's adjacency pre-pass assumes
    // a sheet's front and back are neighbours in the zip.
    .index("by_job_and_index", ["jobId", "entryIndex"]),

  // Front/back pairs produced by the pairing pass (NEO-170), one row per
  // matched pair. Unmatched images are NOT recorded here — they are marked
  // `pairStatus: "unmatched"` on placeholderImages instead, so "every image is
  // accounted for" is a property of one table rather than a set difference.
  //
  // `confidence` and `mechanism` are kept separate on purpose: `mechanism`
  // says HOW the pair was found (the free zip-adjacency pre-pass, or the paid
  // identity-resolver pool pass) and `confidence` says how strong the evidence
  // was. They vary independently — an adjacency match can be side-only, and a
  // pool match can be exact — and the pair of them is what tells us whether
  // the adjacency pre-pass is earning its keep.
  placeholderPairs: defineTable({
    jobId: v.string(),
    // Denormalized from placeholderJobs. Defense in depth for a future
    // per-user sweep (delete/export everything belonging to one user without
    // joining through the jobs table) — it is NOT what ownership checks read
    // today: every read path here resolves the job row from `jobId` and
    // compares THAT row's `userId`, because the job row is the record the
    // whole path-confinement design is anchored on.
    userId: v.string(),
    frontIndex: v.number(), // placeholderImages.entryIndex of the front
    backIndex: v.number(), // placeholderImages.entryIndex of the back
    player: v.optional(v.string()),
    team: v.optional(v.string()),
    cardNumber: v.optional(v.string()),
    confidence: v.union(
      v.literal("exact"),
      v.literal("fuzzy"),
      v.literal("side-only"),
    ),
    // How the pair was made. "adjacency" / "pool" are the automatic mechanisms.
    // "manual" (NEO-152) is a pair a USER forced — for a card whose identity the
    // model misread or could not read — and it is STICKY: the automatic pairing
    // pass excludes manually-paired images from its input and never touches
    // manual pair rows in its diff. That stickiness is the whole reason a manual
    // pair needs its own mechanism value rather than being an ordinary pair the
    // next auto-run would recompute away. See `runPairing` and
    // `manuallyPairPlaceholderImages`.
    mechanism: v.union(v.literal("adjacency"), v.literal("pool"), v.literal("manual")),
    score: v.number(),
    // No `createdAt` column: `_creationTime` already records when the pair was
    // first found, and a hand-maintained copy could only ever drift from it.
    //
    // These rows ARE patched now — incremental pairing (NEO-170) re-runs after
    // image completions and revises a pair whose merged identity, confidence,
    // mechanism or score changed once a later image arrived, rather than
    // deleting and re-inserting it. That is deliberate and load-bearing: the
    // client subscribes to this table, and a delete+insert of an unchanged-
    // looking pair is a visible flicker. The identity of a pair row is
    // (jobId, frontIndex, backIndex); everything else on it is revisable until
    // the job reaches a terminal status.
  }).index("by_job", ["jobId"]),
});
