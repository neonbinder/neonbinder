/**
 * NEO-339 — the answer shapes `nb_fix` and `setbuild fix --answers` accept,
 * as one zod definition: the MCP tool's input schema and the CLI's file parse
 * are this schema, so a phrase printed for a file and a phrase the tool
 * computes are taken over the same parsed value.
 *
 * The shapes are lib/attention.ts's (cards), lib/name-suggestions.ts's
 * (names) and lib/attention-answers.ts's (autographs); the checks below fail
 * the typecheck when any of them drifts from this schema.
 */

import { z } from "zod";
import type { CardFixAnswer } from "./attention";
import { MAX_SUGGESTION_DECISIONS, type NameFixAnswer } from "./name-suggestions";
import type { AutographFixAnswer } from "./attention-answers";
import { MAX_FIX_DETACH, type DetachFixAnswer } from "./detach-answers";
import { AUTOGRAPH_FORMATS } from "../../../convex/features/deriveCardFeatures";
import type { FixAnswers } from "../service";

const text = (what: string) => z.string().trim().min(1).describe(what);

const rowRef = z
  .object({
    type: text("The variant type's title, e.g. \"Inserts\".").optional(),
    name: text("The row under that type, e.g. \"Future Stars\".").optional(),
    parallel: text("A parallel under that row.").optional(),
  })
  .strict();

const birthYear = z.number().int().min(1800).max(2100);

const teamAnswer = z.union([
  text("An NB team's full name, exactly one in the sport."),
  z
    .object({
      name: text("The team's full name."),
      from: z.number().int().optional().describe("The era's first year, when the sport holds the name more than once."),
      id: text("The NB team id, when eras cannot be told apart by year (the listing prints it).").optional(),
    })
    .strict(),
  z
    .object({
      create: z
        .object({
          location: text("The place or sponsor the name begins with (\"Wisconsin\" for Wisconsin Badgers).").optional(),
          name: text("The team name after the location (\"Badgers\")."),
          league: text("An existing NB league, only when the operator names one.").optional(),
        })
        .strict(),
    })
    .strict(),
]);

const playerAnswer = z.union([
  text("An NB player's name, exactly one in the sport."),
  z.object({ link: text("The NB player's name."), birthYear: birthYear.optional() }).strict(),
  z.object({ create: text("The new player's name."), birthYear: birthYear.optional() }).strict(),
]);

const cardAnswer = z.union([
  // NEO-339: "No player on this card" (a checklist, team, logo or relic card).
  z.object({ noPlayer: z.literal(true) }).strict(),
  z.object({ noTeam: z.literal(true) }).strict(),
  z
    .object({
      title: text("The listing title exactly as it should be saved (at most 80 characters)."),
      variation: z.string().trim().optional().describe("The variation text, only on a card flagged for it."),
    })
    .strict(),
  z
    .object({
      players: z.array(playerAnswer).max(20).optional(),
      teams: z.array(teamAnswer).max(8).optional(),
    })
    .strict()
    .refine((a) => a.players !== undefined || a.teams !== undefined, { message: "Give players, teams, noPlayer, noTeam or title." }),
]);

export const CardFixAnswerSchema = z
  .object({
    row: rowRef.optional().describe("The card's checklist; omit for Base."),
    cardNumber: text("The card number as nb_attention printed it."),
    cardId: text("NB's card id, only when the number is on more than one card in the row.").optional(),
    answer: cardAnswer,
  })
  .strict();

export const NameFixAnswerSchema = z
  .object({
    row: rowRef.optional().describe("The row; omit for the path's own row (the set, or the brand-year's manufacturer)."),
    side: z.enum(["bsc", "sportlots"]),
    action: z.enum(["accept", "decline"]).describe("accept renames NB's row to the label; decline keeps NB's name."),
    label: text("The marketplace's name as nb_attention showed it; refused if it has changed since."),
  })
  .strict();

/** Card answers per `nb_fix` / `setbuild fix` call: one confirm phrase covers a batch a person can read. */
export const MAX_FIX_CARDS = 100;
/** Name answers per call: the suggestions mutation's own chunk (`MAX_SUGGESTION_DECISIONS`). */
export const MAX_FIX_NAMES = MAX_SUGGESTION_DECISIONS;

/** NEO-345: the header's "on card or sticker?" for one row, in the stored vocabulary. */
export const AutographFixAnswerSchema = z
  .object({
    row: rowRef.optional().describe("The row; omit for Base."),
    format: z.enum(AUTOGRAPH_FORMATS).describe('How the row\'s autographs are signed: "On Card" or "Sticker/Label".'),
  })
  .strict();

/** Autograph answers per call: each waits on the server's walk over its row, so a call stays short. */
export const MAX_FIX_AUTOGRAPHS = 50;

/** One marketplace link to detach from a row, as the Sources panel's × does (lib/detach-answers.ts). */
export const DetachFixAnswerSchema = z
  .object({
    row: rowRef.optional().describe("The row; omit for Base."),
    side: z.enum(["bsc", "sportlots"]),
    id: text("The marketplace set id attached to the row, as nb_inspect lists it."),
  })
  .strict();

export const FixAnswersSchema = z
  .object({
    cards: z
      .array(CardFixAnswerSchema)
      .max(MAX_FIX_CARDS, `At most ${MAX_FIX_CARDS} card answers per call; split the batch and confirm each part.`)
      .optional()
      .describe(`Card answers (set path only), at most ${MAX_FIX_CARDS} per call.`),
    names: z
      .array(NameFixAnswerSchema)
      .max(MAX_FIX_NAMES, `At most ${MAX_FIX_NAMES} name answers per call; split the batch and confirm each part.`)
      .optional()
      .describe(`Name-to-check answers, at most ${MAX_FIX_NAMES} per call.`),
    autographs: z
      .array(AutographFixAnswerSchema)
      .max(MAX_FIX_AUTOGRAPHS, `At most ${MAX_FIX_AUTOGRAPHS} autograph answers per call; split the batch and confirm each part.`)
      .optional()
      .describe(`Autograph format answers, one per row (set path only), at most ${MAX_FIX_AUTOGRAPHS} per call.`),
    detach: z
      .array(DetachFixAnswerSchema)
      .max(MAX_FIX_DETACH, `At most ${MAX_FIX_DETACH} detach answers per call; split the batch and confirm each part.`)
      .optional()
      .describe(
        `Marketplace links to detach from a row (set path only), at most ${MAX_FIX_DETACH} per call. ` +
          "Removes the link only: cards fetched from it stay on the row.",
      ),
  })
  .strict();

// Drift guards: the parsed shapes must be assignable to the libraries' own.
type Parsed = z.infer<typeof FixAnswersSchema>;
const _cards: CardFixAnswer[] | undefined = undefined as unknown as Parsed["cards"];
const _names: NameFixAnswer[] | undefined = undefined as unknown as Parsed["names"];
const _autographs: AutographFixAnswer[] | undefined = undefined as unknown as Parsed["autographs"];
const _detach: DetachFixAnswer[] | undefined = undefined as unknown as Parsed["detach"];
void _detach;
void _cards;
void _names;
void _autographs;

/** Parse an answers object (a file's JSON, or a tool input). Throws a readable error. */
export function parseFixAnswers(raw: unknown): FixAnswers {
  const r = FixAnswersSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "(answers)"}: ${i.message}`).join("; "));
  }
  return r.data as FixAnswers;
}
