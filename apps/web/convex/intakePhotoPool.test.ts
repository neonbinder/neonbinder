/**
 * NEO-427 — `intakePhotoPool`'s width against the FAST ceiling. convex-test
 * cannot mount the workpool component, so the numbers are what is pinned.
 */

import { describe, expect, test } from "vitest";
import { intakePhotoParallelism } from "./intakePhotoPool";
import { PREPROCESS_CAPACITY } from "./preprocessCapacity";

describe("intakePhotoParallelism", () => {
  test("is a quarter of the prod ceiling and leaves processing the rest", () => {
    expect(intakePhotoParallelism(PREPROCESS_CAPACITY.fast.prod)).toBe(5);
  });

  test("always stays under the FAST ceiling of every environment", () => {
    for (const ceiling of Object.values(PREPROCESS_CAPACITY.fast)) {
      expect(intakePhotoParallelism(ceiling)).toBeLessThan(ceiling);
    }
  });

  test("keeps two lanes where the ceiling is small", () => {
    expect(intakePhotoParallelism(PREPROCESS_CAPACITY.fast.preview)).toBe(2);
    expect(intakePhotoParallelism(PREPROCESS_CAPACITY.fast.dev)).toBe(2);
  });
});
