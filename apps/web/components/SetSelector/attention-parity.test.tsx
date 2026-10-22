/**
 * NEO-339 — the set-build tool lists a set's cards in the walker's order and
 * names the question it will ask, without importing the walker: `walkRank` and
 * `askedQuestion` (tools/setbuild/lib/attention.ts) are the tool's copies of
 * the registry's `attentionWalkRank` and `pickAttentionFixer`. They agree on
 * every kind and every ordered combination of kinds, or this fails.
 *
 * It lives here, not in tools/setbuild/lib, on purpose: the registry imports
 * the fixers (React, `@/` paths), and the tool's tsconfig has no `@/` alias, so
 * a test there would break `npm run typecheck`. The tool's functions are
 * plain relative imports and load fine under this project.
 */

import { describe, expect, test } from "vitest";
import { askedQuestion, walkRank } from "../../tools/setbuild/lib/attention";
import { ATTENTION_LABELS, type AttentionItem, type AttentionKind } from "./card-attention";
import { WALK_RANK } from "./attention-rules";
import { attentionFixers, attentionWalkRank, pickAttentionFixer } from "./cardAttentionRegistry";
import MissingPlayerFixer from "./MissingPlayerFixer";
import MissingTeamFixer from "./MissingTeamFixer";
import TitleFixer from "./TitleFixer";
import UnreviewedNameFixer from "./UnreviewedNameFixer";

/** One item per kind, carrying the payload its type asks for. */
const ITEM: Record<AttentionKind, AttentionItem> = {
  missingPlayer: { kind: "missingPlayer" },
  missingTeam: { kind: "missingTeam" },
  unreviewedName: { kind: "unreviewedName", names: ["A. Player"] },
  titleOverLimit: { kind: "titleOverLimit", length: 90 },
  titleTruncated: { kind: "titleTruncated" },
  aspectValueOverLimit: { kind: "aspectValueOverLimit", field: "cardVariation", length: 70 },
};
const KINDS = Object.keys(ITEM) as AttentionKind[];

/** The question each fixer component asks, written down independently of the kinds. */
const QUESTION_OF = new Map<unknown, ReturnType<typeof askedQuestion>>([
  [MissingPlayerFixer, "missingPlayer"],
  [MissingTeamFixer, "missingTeam"],
  [UnreviewedNameFixer, "unreviewedName"],
  [TitleFixer, "title"],
]);

/** Every non-empty ordered selection of the kinds: 6 + 30 + 120 + 360 + 720 + 720. */
function orderedCombinations(kinds: AttentionKind[]): AttentionKind[][] {
  const out: AttentionKind[][] = [];
  const walk = (soFar: AttentionKind[]) => {
    if (soFar.length > 0) out.push(soFar);
    for (const k of kinds) if (!soFar.includes(k)) walk([...soFar, k]);
  };
  walk([]);
  return out;
}

describe("the tool's walk agrees with the registry's", () => {
  test("the registry has a fixer for every kind the rule can derive, and the tables list the same kinds", () => {
    expect(Object.keys(attentionFixers).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(WALK_RANK).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(ATTENTION_LABELS).sort()).toEqual([...KINDS].sort());
  });

  test("every fixer is one of the four the question table knows", () => {
    for (const k of KINDS) expect(QUESTION_OF.has(attentionFixers[k]), `${k} has an unknown fixer`).toBe(true);
  });

  test.each(KINDS)("%s alone: same rank, same question", (kind) => {
    const items = [ITEM[kind]];
    expect(walkRank(items)).toBe(attentionWalkRank(items));
    expect(askedQuestion(items)).toBe(QUESTION_OF.get(pickAttentionFixer(items).Fixer));
  });

  test("every ordered combination of kinds: same rank, same question", () => {
    const combos = orderedCombinations(KINDS);
    expect(combos).toHaveLength(1956);
    const disagreements: string[] = [];
    for (const combo of combos) {
      const items = combo.map((k) => ITEM[k]);
      const picked = pickAttentionFixer(items);
      const want = { rank: attentionWalkRank(items), question: QUESTION_OF.get(picked.Fixer) };
      const got = { rank: walkRank(items), question: askedQuestion(items) };
      if (got.rank !== want.rank || got.question !== want.question) {
        disagreements.push(`${combo.join(" + ")}: tool ${JSON.stringify(got)}, registry ${JSON.stringify(want)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
