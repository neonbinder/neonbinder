/**
 * NEO-345 / NEO-339 — the checklist header's "on card or sticker?" rule, in
 * its one React-free home, and the parity it exists for: the Set Builder's
 * prompt (`CardChecklist`) and the set-build tool's attention listing
 * (`tools/setbuild/lib/attention.ts`) and answers
 * (`tools/setbuild/lib/attention-answers.ts`) all decide with these
 * functions, so the tool lists exactly the rows the header asks about.
 *
 * `.test.tsx` because the components project collects only that suffix.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_FORMATS,
  asAutographFormat,
  autographPromptAsks,
  autographPromptCount,
  autographPromptLine,
  autographPromptSaved,
  countUnformattedAutographs,
  isUnformattedAutograph,
} from "./autograph-prompt";
import * as stepModule from "./AutographFormatStep";
import * as stepsModule from "./entity-review-steps";

const au = (autographed?: string) => ({ attributes: ["AU"], ...(autographed ? { features: { autographed } } : {}) });

describe("the prompt's rule", () => {
  it("counts AU cards still marked None (absent counts as None); a formatted or plain card does not count", () => {
    expect(isUnformattedAutograph(["AU"], undefined)).toBe(true);
    expect(isUnformattedAutograph(["AU"], "On Card")).toBe(false);
    expect(isUnformattedAutograph(["RC"], "None")).toBe(false);
    expect(countUnformattedAutographs([au(), au("None"), au("On Card"), au("Sticker/Label"), { attributes: ["RC"] }, {}])).toBe(2);
    expect(countUnformattedAutographs([{ attributes: [" au "] }])).toBe(1);
    expect(countUnformattedAutographs([{ attributes: ["AUTO"] }])).toBe(0);
  });

  it("asks only while the row has no format and a card is waiting; a value outside the two answers is no format", () => {
    expect(autographPromptAsks(undefined, 1)).toBe(true);
    expect(autographPromptAsks(null, 1)).toBe(true);
    expect(autographPromptAsks("on card", 1)).toBe(true);
    expect(autographPromptAsks("On Card", 1)).toBe(false);
    expect(autographPromptAsks("Sticker/Label", 3)).toBe(false);
    expect(autographPromptAsks(undefined, 0)).toBe(false);
  });

  it("the count is the asked count, or 0 when it does not ask", () => {
    const cards = [au(), au(), au("On Card")];
    expect(autographPromptCount(undefined, cards)).toBe(2);
    expect(autographPromptCount("On Card", cards)).toBe(0);
    expect(autographPromptCount(undefined, [au("On Card")])).toBe(0);
  });

  it("the words: the line, the saved line, the two answers' names, in the stored vocabulary", () => {
    expect(autographPromptLine(1)).toBe("1 autographed card — on card or sticker?");
    expect(autographPromptLine(17)).toBe("17 autographed cards — on card or sticker?");
    expect(autographPromptSaved("On Card")).toBe("Autographs saved as on card.");
    expect(autographPromptSaved("Sticker/Label")).toBe("Autographs saved as sticker.");
    expect([...AUTOGRAPH_FORMATS]).toEqual(["On Card", "Sticker/Label"]);
    expect(AUTOGRAPH_CHOICE_LABEL).toEqual({ "On Card": "On card", "Sticker/Label": "Sticker" });
    expect(asAutographFormat("Sticker/Label")).toBe("Sticker/Label");
    expect(asAutographFormat("sticker")).toBeUndefined();
  });
});

describe("one copy: the UI modules re-export the pure module's own functions", () => {
  it("the step and the wizard's step module hand out the same objects", () => {
    expect(stepModule.autographPromptLine).toBe(autographPromptLine);
    expect(stepModule.autographPromptSaved).toBe(autographPromptSaved);
    expect(stepModule.AUTOGRAPH_CHOICE_LABEL).toBe(AUTOGRAPH_CHOICE_LABEL);
    expect(stepsModule.AUTOGRAPH_CHOICE_LABEL).toBe(AUTOGRAPH_CHOICE_LABEL);
    expect(stepsModule.asAutographFormat).toBe(asAutographFormat);
  });

  it("the header gates on the pure predicate, and the tool lists and answers with it (no copy on either side)", () => {
    const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
    const checklist = read("CardChecklist.tsx");
    expect(checklist).toMatch(/import \{ autographPromptAsks, isUnformattedAutograph \} from "\.\/autograph-prompt";/);
    expect(checklist).toContain("autographPromptAsks(variantRow.features?.autographFormat, unformattedAutographCount)");
    expect(checklist).toContain("isUnformattedAutograph(row.attributes, row.features?.autographed)");
    // The rule's own pieces are not re-derived in the component.
    expect(checklist).not.toMatch(/carriesAutograph\(/);

    const listing = read("../../tools/setbuild/lib/attention.ts");
    expect(listing).toMatch(/autographPromptCount,[\s\S]*?\} from "\.\.\/\.\.\/\.\.\/components\/SetSelector\/autograph-prompt";/);
    expect(listing).toContain("autographPromptCount(node.autographFormat, cards)");
    const answers = read("../../tools/setbuild/lib/attention-answers.ts");
    expect(answers).toMatch(/\} from "\.\.\/\.\.\/\.\.\/components\/SetSelector\/autograph-prompt";/);
    expect(answers).toContain("autographPromptCount(leaf.features?.autographFormat, cards)");
    for (const src of [listing, answers]) expect(src).not.toMatch(/carriesAutograph(Token)?\(/);
  });
});
