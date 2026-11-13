import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  BATCH_NOT_COLLECTING,
  batchNotCollecting,
  isBatchNotCollecting,
} from "./placeholderRefusals";

describe("isBatchNotCollecting", () => {
  it.each([
    ["null", null, false],
    ["undefined", undefined, false],
    ["a string", "BATCH_NOT_COLLECTING", false],
    ["a plain object with no data", { code: BATCH_NOT_COLLECTING }, false],
    ["data that is null", { data: null }, false],
    ["data that is a string", { data: BATCH_NOT_COLLECTING }, false],
    ["data with another code", { data: { code: "SOMETHING_ELSE" } }, false],
    ["a ConvexError with another code", new ConvexError({ code: "SOMETHING_ELSE" }), false],
    ["a plain Error with the same words", new Error("job is processing, not collecting"), false],
    ["the coded ConvexError", batchNotCollecting("processing"), true],
    ["a look-alike object carrying the code", { data: { code: BATCH_NOT_COLLECTING } }, true],
  ])("%s", (_name, value, expected) => {
    expect(isBatchNotCollecting(value)).toBe(expected);
  });

  it("keeps the wording the scanner CLI and logs show, with the status", () => {
    const error = batchNotCollecting("succeeded");
    expect(error.data).toMatchObject({
      code: BATCH_NOT_COLLECTING,
      status: "succeeded",
      message: "job is succeeded, not collecting",
    });
  });
});
