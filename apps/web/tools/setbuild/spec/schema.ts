/**
 * NEO-339 — the set-build spec: a declarative description of the NB rows a
 * run should leave behind, and every operator decision needed to get there.
 *
 * The spec is the operator. Every decision the Set Builder UI would ask a
 * human for is answered here by NAME (an NB name, resolved exactly-one) or by
 * MARKETPLACE ID (a base mapping, a reconcile pair, a SportLots review line).
 * Nothing is ever decided by position, and nothing is wildcarded: a review row
 * or a pending marketplace set the spec does not name is an open decision, and
 * `apply` stops there (plan §2.3, §4 "Runner rules").
 *
 * Every object is `.strict()`: a misspelt key ("whenPasued") is a parse error,
 * never a silently ignored answer.
 *
 * Consumers: the runner (B2), the MCP server and CLI (C). Keep this file
 * stable; a shape change is announced in the builder report.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LeagueLevel } from "../../../convex/leagues";

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/** A non-blank string, trimmed. Names and marketplace ids alike. */
const text = z.string().trim().min(1);

/** The two marketplaces, by credential site key. */
export const SiteKeySchema = z.enum(["buysportscards", "sportlots"]);

/** The two marketplaces, by platform-slot side (the reconcile/pairing vocabulary). */
export const SideSchema = z.enum(["bsc", "sportlots"]);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const BrandYearPathSchema = z
  .object({
    sport: text,
    /** The year row's value as NB shows it ("2024"). */
    year: text,
    manufacturer: text,
  })
  .strict();

export const SetPathSchema = z
  .object({
    sport: text,
    year: text,
    manufacturer: text,
    set: text,
  })
  .strict();

// ---------------------------------------------------------------------------
// Entity review (the "Confirm New Players & Teams" wizard)
// ---------------------------------------------------------------------------

/**
 * One review row's answer. `create` mints the entity, `{ link }` links the row
 * to the ONE existing NB entity of that name (exactly-one, or the step stops),
 * `skip` is the wizard's Skip.
 */
export const NamedDecisionSchema = z
  .object({
    name: text,
    decision: z.union([
      z.literal("create"),
      z.literal("skip"),
      z.object({ link: text }).strict(),
    ]),
  })
  .strict();

/**
 * A player row's answer: `NamedDecision`'s, plus `birthYear` on a link. NB
 * keeps several players under one name ("Jose Rodriguez"), so a link by name
 * alone stops as ambiguous; `{ link, birthYear }` names the one same-name
 * player born that year (exactly-one, or the step stops). Without
 * `birthYear` a link behaves as before.
 */
export const PlayerLinkSchema = z
  .object({
    link: text,
    birthYear: z
      .number()
      .int()
      .gte(1000)
      .lte(9999)
      .optional()
      .describe("The linked player's birth year: picks one of several NB players sharing the name."),
  })
  .strict();

export const PlayerDecisionSchema = z
  .object({
    name: text,
    decision: z.union([z.literal("create"), z.literal("skip"), PlayerLinkSchema]),
  })
  .strict();

/** A team row's answer; `location` / `league` fill the New Team step when creating. */
export const TeamDecisionSchema = NamedDecisionSchema.extend({
  location: text.optional(),
  league: text.optional(),
}).strict();

/**
 * NEO-331 — where a league sits in the pyramid: `leagues.level`, a REQUIRED
 * column since NEO-331. The values are the schema's own union (the stored
 * lowercase values, not the buttons' labels), and the type check below fails
 * the build if the two lists ever drift. A value, not an import of
 * `LEAGUE_LEVELS`: that module is server code a Node tool cannot load.
 */
export const LEAGUE_LEVEL_VALUES = [
  "major",
  "minor",
  "college",
  "international",
  "independent",
  "other",
] as const;
type SameLevels<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const levelsMatchSchema: SameLevels<(typeof LEAGUE_LEVEL_VALUES)[number], LeagueLevel> = true;
void levelsMatchSchema;

/**
 * A `z.custom` refinement rather than `z.enum`, deliberately: the review block
 * is a union (`"none-expected"` | the answers), and zod reports a failed enum
 * inside a union as a bare "Invalid input" on the union's own path. A
 * non-fatal refinement failure is reported where it happened, with this
 * message.
 */
export const LeagueLevelSchema = z.custom<LeagueLevel>(
  (v) => typeof v === "string" && (LEAGUE_LEVEL_VALUES as readonly string[]).includes(v),
  {
    message: `level must be one of ${LEAGUE_LEVEL_VALUES.join(", ")} (the stored values, lowercase).`,
    // Non-fatal: a fatal issue aborts the branch, which is what turns it into
    // the union's bare "Invalid input".
    fatal: false,
  },
);

/**
 * A league row's answer. NEO-331: a `create` must carry a `level` — the New
 * League step holds "Add as New League" until one is pressed, and never
 * pre-picks one, so the spec has to say it. A `level` on a link or skip is
 * refused rather than ignored: it would be an answer nobody reads.
 */
export const LeagueDecisionSchema = NamedDecisionSchema.extend({
  level: LeagueLevelSchema.optional().describe(
    `The new league's level (${LEAGUE_LEVEL_VALUES.join(", ")}). Required when decision is "create"; only read then.`,
  ),
})
  .strict()
  .superRefine((d, ctx) => {
    if (d.decision === "create" && d.level === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["level"],
        message: `A league "create" needs a level: one of ${LEAGUE_LEVEL_VALUES.join(", ")}.`,
      });
    }
    if (d.decision !== "create" && d.level !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["level"],
        message: 'level is only read on a "create"; remove it from a link or skip.',
      });
    }
  });

export const ReviewAnswersSchema = z
  .object({
    players: z.array(PlayerDecisionSchema).default([]),
    teams: z.array(TeamDecisionSchema).default([]),
    leagues: z.array(LeagueDecisionSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Checklist (fetch → Match Cards → review → commit)
// ---------------------------------------------------------------------------

/**
 * A hand-made pairing in the Match Cards dialog: one BSC card with one
 * SportLots card, each named by its marketplace card ref (the
 * `platformData.<side>.ref` the fetch carries). Card numbers are never the key
 * (invariant 7).
 */
export const CardPairSchema = z
  .object({
    bsc: text,
    sportlots: text,
  })
  .strict();

/**
 * An answer to one auto-matched pair's disagreement (`nameConflict` /
 * `playersConflict`), the pair named by either side's card ref. A conflict the
 * spec does not answer is an open decision. When the two are not the same card
 * at all, the answer is `pairing.unlink` instead, never a `choose`.
 */
export const CardConflictSchema = z
  .object({
    field: z.enum(["name", "players"]),
    bsc: text.optional(),
    sportlots: text.optional(),
    choose: SideSchema,
  })
  .strict()
  .refine((c) => c.bsc !== undefined || c.sportlots !== undefined, {
    message: "A conflict answer names the pair by its bsc and/or sportlots card ref.",
  });

export const ChecklistSchema = z
  .object({
    pairing: z
      .object({
        /** The dialog's "Keep all BSC-only cards" (`keep`) or not (`drop`). */
        unmatchedBsc: z.enum(["keep", "drop"]),
        /** The dialog's "Keep all SportLots-only cards" (`keep`) or not (`drop`). */
        unmatchedSportlots: z.enum(["keep", "drop"]),
        /**
         * The dialog's Unlink: auto-matched pairs that are NOT one card (two
         * cards sharing a number), each named by both card refs. Applied
         * first, before `pairs` and `conflicts`: both halves go back to their
         * unmatched columns and follow `unmatchedBsc` / `unmatchedSportlots`,
         * and the pair's disagreements are no longer asked.
         */
        unlink: z.array(CardPairSchema).optional(),
        pairs: z.array(CardPairSchema).optional(),
        conflicts: z.array(CardConflictSchema).optional(),
      })
      .strict()
      .superRefine((p, ctx) => {
        const unlink = p.unlink ?? [];
        const seen = new Set<string>();
        unlink.forEach((u, i) => {
          const key = `${u.bsc}\u0000${u.sportlots}`;
          if (seen.has(key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unlink", i], message: "This pair is already in unlink." });
          }
          seen.add(key);
        });
        (p.conflicts ?? []).forEach((c, i) => {
          const hit = unlink.some(
            (u) => (c.bsc === undefined || c.bsc === u.bsc) && (c.sportlots === undefined || c.sportlots === u.sportlots),
          );
          if (hit) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["conflicts", i],
              message: "This conflict's pair is in unlink, so there is nothing to choose. Remove one of the two.",
            });
          }
        });
      }),
    /** `none-expected`: the commit must open no review; any review row is an open decision. */
    review: z.union([z.literal("none-expected"), ReviewAnswersSchema]),
    /** Cards the checklist must hold after the commit (asserted, never used to decide). */
    expectCards: z.number().int().nonnegative().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Reconcile (Sync Inserts / Sync Parallels → the Reconcile dialog)
// ---------------------------------------------------------------------------

/**
 * One NB set the Reconcile dialog should save, named by its marketplace ids.
 * Order is save order. A pair whose ids exactly equal one auto-matched (or
 * already-saved) set claims it; otherwise it is built the way the dialog's
 * drags would build it.
 */
export const ReconcilePairSchema = z
  .object({
    name: text,
    bsc: z.array(text).optional(),
    sportlots: z.array(text).optional(),
  })
  .strict()
  .refine((p) => (p.bsc?.length ?? 0) + (p.sportlots?.length ?? 0) > 0, {
    message: "A reconcile pair names at least one marketplace id.",
  });

/**
 * What to do with one marketplace set no pair names: "Make its own set", or
 * leave it in Pending. `name` is the marketplace's name for the set, as a
 * draft lists it so a reader can pair it: display only, never matched (the
 * set is named by `id`).
 */
export const ReconcilePendingSchema = z
  .object({
    side: SideSchema,
    id: text,
    name: text.optional(),
    decision: z.enum(["own-set", "leave"]),
  })
  .strict();

export const ReconcileSyncSchema = z
  .object({
    pairs: z.array(ReconcilePairSchema).default([]),
    pending: z.array(ReconcilePendingSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// SportLots set review ("Sort SportLots sets for {brand}")
// ---------------------------------------------------------------------------

/**
 * One review line, by SportLots id: its own set, or filed under a variant type
 * (`variantType`, by NB title) of one of the brand's sets (`set`, by NB name).
 * `name` is the row's name under that type when the default will not do.
 */
export const SlDecisionSchema = z.union([
  z
    .object({
      slId: text,
      placement: z.literal("own-set"),
    })
    .strict(),
  z
    .object({
      slId: text,
      set: text,
      variantType: text,
      name: text.optional(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * What to do when the manufacturer row is missing after its column synced:
 * `create` adds it through "+ Custom" (`addCustomSelectorOption`, the paused
 * path), `fail` stops the run.
 */
export const ManufacturerPolicySchema = z
  .object({
    whenMissing: z.enum(["create", "fail"]),
  })
  .strict();

export const BrandYearStepSchema = z
  .object({
    kind: z.literal("brand-year"),
    path: BrandYearPathSchema,
    manufacturer: ManufacturerPolicySchema.optional(),
    /** Run the brand's Sets cold sync. */
    syncSets: z.literal(true),
    slReview: z
      .object({
        decisions: z.array(SlDecisionSchema),
      })
      .strict()
      .optional(),
  })
  .strict();

export const BaseMapSchema = z
  .object({
    /** The BSC candidate's id (a set slug, or the set listing's slug). */
    bsc: text,
    /** The SportLots candidate's id. Omitted = map BSC only. */
    sportlots: text.optional(),
    /**
     * When the server reports a side of this mapping PAUSED: `bsc-only` maps
     * BSC alone; `skip` maps nothing (plan §2.7).
     */
    whenPaused: z.enum(["bsc-only", "skip"]),
  })
  .strict();

/**
 * One parallel of an insert row (NEO-312 J1): a row at the `parallel` level
 * under the insert, named exactly. `build` builds its checklist from the
 * INSERT's checklist (the panel's "Build" on an insert), after that checklist
 * is committed; without it the parallel is only checked to exist, and
 * `expectCards`, when given, asserted.
 */
export const InsertParallelSchema = z
  .object({
    name: text,
    build: z
      .object({
        /** Rebuild even when the parallel already has cards. */
        rebuild: z.boolean().optional(),
      })
      .strict()
      .optional(),
    expectCards: z.number().int().nonnegative().optional(),
  })
  .strict();

export const VariantRowSchema = z
  .object({
    /** The row's NB name under its variant type. */
    name: text,
    checklist: ChecklistSchema.optional(),
    /** Build this parallel's checklist from the set's Base ("Build from Base"). */
    buildFromBase: z
      .object({
        /** Rebuild even when the row already has cards. */
        rebuild: z.boolean().optional(),
      })
      .strict()
      .optional(),
    expectCards: z.number().int().nonnegative().optional(),
    /** This insert's parallels, handled after its checklist (see `InsertParallelSchema`). */
    parallels: z.array(InsertParallelSchema).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Group Parallels (the "Group Parallels" dialog)
// ---------------------------------------------------------------------------

/**
 * A row of one variant type, by its exact NB name or by a marketplace id in
 * one of its platform slots (`{ "bsc": "<slug>" }`, `{ "sportlots": "<id>" }`).
 * Either form must match exactly one row of the type (top-level or already
 * grouped); an id is the steadier form, since it survives a rename.
 */
export const RowRefSchema = z.union([
  text,
  z.object({ bsc: text }).strict(),
  z.object({ sportlots: text }).strict(),
]);

/** One insert and the rows that should sit under it as its parallels. */
export const GroupParentSchema = z
  .object({
    insert: RowRefSchema,
    parallels: z.array(RowRefSchema).min(1),
  })
  .strict();

/**
 * The nesting the dialog's moves would leave. A named parallel already under
 * its insert is done; one under another insert is moved; a top-level row is
 * moved under it. A named insert that is itself a parallel, or a named
 * parallel that holds parallels of its own, is an open decision. A row the
 * spec does not name stays where it is: leaving is the default, never a
 * wildcard. `topLevel` is the dialog's ✕ on a grouped row: it moves the row
 * back out to stand as its own set.
 */
export const GroupSchema = z
  .object({
    parents: z.array(GroupParentSchema),
    /**
     * Rows that must stand as their own set, not as a parallel: a grouped one
     * is moved back to the top level, any other is left as it is. A row named
     * here and as a parallel in `parents` is an open decision.
     */
    topLevel: z.array(RowRefSchema).optional(),
    /**
     * Top-level rows of the type that hold no parallels, after the grouping
     * (asserted, never used to decide).
     */
    expectUngrouped: z.number().int().nonnegative().optional(),
  })
  .strict();

export const VariantTypeStepSchema = z
  .object({
    /** The variant type's NB title ("Insert", "Parallel"). */
    type: text,
    /** Run the type's row sync (Sync Inserts / Sync Parallels) with these answers. */
    sync: ReconcileSyncSchema.optional(),
    /**
     * Rows the type must hold after the sync, top-level and grouped alike, so
     * the count is the same before and after `group` (asserted, never used to
     * decide).
     */
    expectRows: z.number().int().nonnegative().optional(),
    /** Group Parallels, after the sync and before `rows`. */
    group: GroupSchema.optional(),
    rows: z.array(VariantRowSchema).optional(),
  })
  .strict();

export const SetStepSchema = z
  .object({
    kind: z.literal("set"),
    path: SetPathSchema,
    manufacturer: ManufacturerPolicySchema.optional(),
    variantTypes: z.object({ sync: z.literal(true) }).strict(),
    base: z
      .object({
        map: BaseMapSchema,
        checklist: ChecklistSchema.optional(),
      })
      .strict()
      .optional(),
    variants: z.array(VariantTypeStepSchema).optional(),
  })
  .strict();

export const StepSchema = z.discriminatedUnion("kind", [BrandYearStepSchema, SetStepSchema]);

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export const CredentialsSchema = z
  .object({
    /** Sites to seed through `testing.seedMyTestCredentials` (preview/testing only). */
    seed: z.array(SiteKeySchema),
    /** Warm each seeded site's session the way the profile's "Test Credentials" does. */
    warm: z.boolean(),
  })
  .strict();

export const SetBuildSpecSchema = z
  .object({
    version: z.literal(1),
    /**
     * What the confirm phrase names: `BUILD <host> <scope>`. A set path
     * (`Baseball/2024/Topps/Topps Chrome`) for a one-set spec, or a declared
     * name such as `e2e-baseline`.
     */
    scope: text,
    credentials: CredentialsSchema.optional(),
    /** Run the root Sports sync first. */
    rootSync: z.literal(true).optional(),
    steps: z.array(StepSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SetBuildSpec = z.infer<typeof SetBuildSpecSchema>;
/** The spec as written (before defaults are applied). */
export type SetBuildSpecInput = z.input<typeof SetBuildSpecSchema>;
export type Step = z.infer<typeof StepSchema>;
export type BrandYearStep = z.infer<typeof BrandYearStepSchema>;
export type SetStep = z.infer<typeof SetStepSchema>;
export type BrandYearPath = z.infer<typeof BrandYearPathSchema>;
export type SetPath = z.infer<typeof SetPathSchema>;
export type SiteKey = z.infer<typeof SiteKeySchema>;
export type Side = z.infer<typeof SideSchema>;
export type Credentials = z.infer<typeof CredentialsSchema>;
export type ManufacturerPolicy = z.infer<typeof ManufacturerPolicySchema>;
export type BaseMap = z.infer<typeof BaseMapSchema>;
export type VariantTypeStep = z.infer<typeof VariantTypeStepSchema>;
export type VariantRow = z.infer<typeof VariantRowSchema>;
export type InsertParallel = z.infer<typeof InsertParallelSchema>;
export type RowRef = z.infer<typeof RowRefSchema>;
export type GroupParent = z.infer<typeof GroupParentSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type ReconcileSync = z.infer<typeof ReconcileSyncSchema>;
export type ReconcilePair = z.infer<typeof ReconcilePairSchema>;
export type ReconcilePending = z.infer<typeof ReconcilePendingSchema>;
export type SlDecision = z.infer<typeof SlDecisionSchema>;
export type Checklist = z.infer<typeof ChecklistSchema>;
export type CardPair = z.infer<typeof CardPairSchema>;
export type CardConflict = z.infer<typeof CardConflictSchema>;
export type ReviewAnswers = z.infer<typeof ReviewAnswersSchema>;
export type NamedDecision = z.infer<typeof NamedDecisionSchema>;
export type PlayerDecision = z.infer<typeof PlayerDecisionSchema>;
export type PlayerLink = z.infer<typeof PlayerLinkSchema>;
export type TeamDecision = z.infer<typeof TeamDecisionSchema>;
export type LeagueDecision = z.infer<typeof LeagueDecisionSchema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A spec that failed validation. `issues` are zod's, each with its path. */
export class SpecError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super(
      `The spec is not valid:\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`,
    );
    this.name = "SpecError";
    this.issues = issues;
  }
}

/** `steps[2].variants[0].sync.pairs[1].bsc` — the path an issue names. */
export function issuePath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${part}` : part;
  }
  return out;
}

/** Parse and validate a spec (already JSON-decoded). Throws `SpecError`. */
export function parseSpec(raw: unknown): SetBuildSpec {
  const result = SetBuildSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new SpecError(
      result.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message })),
    );
  }
  return result.data;
}

/** Decode JSON text and validate it. Throws `SpecError` for bad JSON too. */
export function parseSpecJson(text: string): SetBuildSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SpecError([
      { path: "", message: `not JSON (${err instanceof Error ? err.message : String(err)})` },
    ]);
  }
  return parseSpec(raw);
}

/**
 * The spec's JSON Schema (draft-07), for `setbuild schema` and editors.
 * `zod-to-json-schema` is the converter the MCP SDK already ships with.
 */
export function specJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(SetBuildSpecSchema, {
    name: "SetBuildSpec",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}
