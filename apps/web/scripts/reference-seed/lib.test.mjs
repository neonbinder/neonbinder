// NEO-330 — the reference-seed helpers: id codec, number notation, deployment
// guards, and the two parity checks that stop the script drifting from the
// places it must agree with. Pure; no Convex, no network.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROD_DEPLOYMENT_NAME,
  BUNDLE_TABLES,
  decodeId,
  encodeId,
  retableId,
  walkIds,
  convexJson,
  countIntegerLiterals,
  integralNumberPaths,
  toJsonl,
  parseJsonl,
  parseTableNumbers,
  tablesJsonl,
  deploymentNameProblem,
  deployKeyProblem,
  effectiveDeployKey,
} from "./lib.mjs";
import { FIXTURE_SOURCE_TABLE_NUMBERS, fixtureTables } from "./make-fixture.mjs";
import { REFERENCE_SEED_TABLES } from "../../convex/selectorOptions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..", "..");

const internalBytes = (seed) => Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i * 7) & 0xff);

describe("document id codec", () => {
  test.each([1, 127, 128, 10009, 16384, 2 ** 21])("round-trips table number %i", (table) => {
    const internal = internalBytes(table);
    const id = encodeId(table, internal);
    const d = decodeId(id);
    expect(d.table).toBe(table);
    expect([...d.internal]).toEqual([...internal]);
    expect(encodeId(d.table, d.internal)).toBe(id);
  });

  test("retableId keeps the 16-byte document part and changes only the table number", () => {
    const internal = internalBytes(3);
    const id = encodeId(10009, internal);

    const moved = retableId(id, 10025);

    expect(moved).not.toBe(id);
    const d = decodeId(moved);
    expect(d.table).toBe(10025);
    expect([...d.internal]).toEqual([...internal]);
  });

  test("retableId to the same number is the identity, and there-and-back restores the id", () => {
    const id = encodeId(10009, internalBytes(4));
    expect(retableId(id, 10009)).toBe(id);
    expect(retableId(retableId(id, 12345), 10009)).toBe(id);
  });

  test("retableId throws on a string that is not a Convex id", () => {
    expect(() => retableId("not-an-id", 10001)).toThrow(/not a Convex id/);
  });

  test("decodeId rejects a flipped character, a wrong length and non-strings", () => {
    const id = encodeId(10009, internalBytes(5));
    const flipped = id.slice(0, 10) + (id[10] === "0" ? "1" : "0") + id.slice(11);
    expect(decodeId(flipped)).toBeNull();
    expect(decodeId(id.slice(1))).toBeNull();
    expect(decodeId(`${id}0`)).toBeNull();
    expect(decodeId(id.toUpperCase())).toBeNull();
    expect(decodeId(undefined)).toBeNull();
    expect(decodeId(12345)).toBeNull();
  });

  test("the fixture's ids carry the source table number of their table", () => {
    const { tables } = fixtureTables();
    for (const t of BUNDLE_TABLES) {
      for (const row of tables[t]) expect(decodeId(row._id).table).toBe(FIXTURE_SOURCE_TABLE_NUMBERS[t]);
    }
  });
});

describe("walkIds", () => {
  const a = encodeId(10009, internalBytes(1));
  const b = encodeId(10010, internalBytes(2));
  const c = encodeId(10019, internalBytes(3));

  test("finds ids at any depth and reports shape paths, never values", () => {
    const row = { _id: a, teamYears: [{ teamId: b }], deep: { x: { y: [c] } }, name: "plain text", n: 5 };
    const seen = [];

    walkIds(row, (p, d) => seen.push([p, d.table]));

    expect(seen).toEqual([
      ["_id", 10009],
      ["teamYears[].teamId", 10010],
      ["deep.x.y[]", 10019],
    ]);
  });

  test("replace swaps the string in place, including inside arrays", () => {
    const row = { ids: [a, b], one: c };

    walkIds(row, (_p, d, set, str) => set(retableId(str, d.table + 1)));

    expect(decodeId(row.ids[0]).table).toBe(10010);
    expect(decodeId(row.ids[1]).table).toBe(10011);
    expect(decodeId(row.one).table).toBe(10020);
  });

  test("top-level skipKeys are not walked; nested keys of the same name are", () => {
    const row = { sportId: a, nested: { sportId: b } };
    const seen = [];

    walkIds(row, (p) => seen.push(p), new Set(["sportId"]));

    expect(seen).toEqual(["nested.sportId"]);
  });
});

describe("convexJson", () => {
  test("writes integral numbers as N.0", () => {
    expect(convexJson({ a: 2005 })).toBe('{"a":2005.0}');
    expect(convexJson({ a: 1759999999999 })).toBe('{"a":1759999999999.0}');
    expect(convexJson({ a: -3 })).toBe('{"a":-3.0}');
    expect(convexJson({ a: -0 })).toBe('{"a":-0.0}');
  });

  test("keeps fractions and exponent notation as they are", () => {
    expect(convexJson({ a: 1700000000000.5 })).toBe('{"a":1700000000000.5}');
    expect(convexJson({ a: 1e21, b: 1.5e-7 })).toBe('{"a":1e+21,"b":1.5e-7}');
  });

  test("reaches numbers in nested arrays and objects", () => {
    expect(convexJson({ t: [{ f: 1990, x: [1, 2.5] }] })).toBe('{"t":[{"f":1990.0,"x":[1.0,2.5]}]}');
  });

  test("leaves $integer and $bytes wrappers and strings with digits untouched", () => {
    expect(convexJson({ n: { $integer: "AQAAAAAAAAA=" } })).toBe('{"n":{"$integer":"AQAAAAAAAAA="}}');
    expect(convexJson({ b: { $bytes: "AAE=" } })).toBe('{"b":{"$bytes":"AAE="}}');
    expect(convexJson({ s: '12 "3" 4' })).toBe('{"s":"12 \\"3\\" 4"}');
  });

  test("drops undefined properties and round-trips a float value", () => {
    expect(convexJson({ a: 1, u: undefined })).toBe('{"a":1.0}');
    expect(JSON.parse(convexJson({ a: 0.1 + 0.2 })).a).toBe(0.1 + 0.2);
  });

  test("refuses NaN and Infinity (they would need a $float wrapper)", () => {
    expect(() => convexJson({ a: NaN })).toThrow(/non-finite/);
    expect(() => convexJson({ a: Infinity })).toThrow(/non-finite/);
  });
});

describe("countIntegerLiterals", () => {
  test("counts bare integers, not floats, exponents or digits inside strings", () => {
    expect(countIntegerLiterals('{"a":1,"b":-2,"c":[3,4.0],"d":5e3}')).toBe(3);
    expect(countIntegerLiterals('{"a":"123","$integer":"MTIz","b":"x\\"9"}')).toBe(0);
  });

  test("is zero for anything convexJson wrote", () => {
    expect(countIntegerLiterals(convexJson({ a: 1, b: [2, { c: -0 }], d: 2.5 }))).toBe(0);
  });

  test("toJsonl refuses a line that would carry a bare integer", () => {
    expect(toJsonl([{ a: 1 }, { a: 2.5 }])).toBe('{"a":1.0}\n{"a":2.5}\n');
  });
});

describe("integralNumberPaths", () => {
  test("reports field paths of integral numbers only", () => {
    const paths = [];
    integralNumberPaths({ a: 1, b: 2.5, c: [{ d: 3 }] }, (p) => paths.push(p));
    expect(paths).toEqual(["a", "c[].d"]);
  });
});

describe("JSONL helpers", () => {
  test("parseJsonl names the line, never the content, on bad input", () => {
    expect(() => parseJsonl('{"a":1.0}\nSECRET-ROW\n', "x/documents.jsonl")).toThrow(/line 2 is not valid JSON/);
    try {
      parseJsonl("SECRET-ROW\n", "x");
    } catch (e) {
      expect(e.message).not.toContain("SECRET-ROW");
    }
  });

  test("tablesJsonl and parseTableNumbers round-trip", () => {
    const text = tablesJsonl(["players", "teams"], { players: 7, teams: 9 });
    expect([...parseTableNumbers(text)]).toEqual([
      ["players", 7],
      ["teams", 9],
    ]);
  });
});

describe("deploymentNameProblem", () => {
  test.each([
    [PROD_DEPLOYMENT_NAME],
    [`${PROD_DEPLOYMENT_NAME}-x`],
    [`x${PROD_DEPLOYMENT_NAME}`],
    ["prod"],
    ["production"],
    ["PROD"],
    ["prod:happy-animal-123"],
    ["dev:happy-animal-123"],
    ["project:ref"],
    ["Happy-Animal-123"],
    ["happy-animal"],
    ["happy_animal_123"],
    ["happy animal 123"],
    [""],
    [undefined],
    [null],
  ])("refuses %j", (name) => {
    expect(deploymentNameProblem(name)).toEqual(expect.any(String));
  });

  test.each([["happy-animal-123"], ["cheerful-snow-leopard-456"]])("accepts plain name %s", (name) => {
    expect(deploymentNameProblem(name)).toBeNull();
  });
});

describe("deployKeyProblem", () => {
  test("no key is not a problem", () => {
    expect(deployKeyProblem("", "happy-animal-123")).toBeNull();
    expect(deployKeyProblem(undefined, undefined)).toBeNull();
  });

  test.each([["prod:happy-animal-123|tok"], ["project:acme:app|tok"], [`dev:${PROD_DEPLOYMENT_NAME}|tok`], [`preview:x|${PROD_DEPLOYMENT_NAME}`]])(
    "refuses production or project-wide key %j",
    (key) => {
      expect(deployKeyProblem(key, "happy-animal-123")).toMatch(/production or project-wide/);
    },
  );

  test("refuses a dev key that names another deployment", () => {
    expect(deployKeyProblem("dev:other-animal-9|tok", "happy-animal-123")).toMatch(/different dev deployment/);
  });

  test("accepts a dev key that names the same deployment", () => {
    expect(deployKeyProblem("dev:happy-animal-123|tok", "happy-animal-123")).toBeNull();
  });

  test("refuses any key when no deployment is given", () => {
    expect(deployKeyProblem("dev:happy-animal-123|tok", undefined)).toMatch(/pass --deployment/);
    expect(deployKeyProblem("dev:happy-animal-123|tok", "")).toMatch(/pass --deployment/);
  });

  test("never echoes the key in a refusal", () => {
    for (const [key, dep] of [
      ["prod:happy-animal-123|SECRETVALUE", "happy-animal-123"],
      ["dev:other-animal-9|SECRETVALUE", "happy-animal-123"],
      ["dev:happy-animal-123|SECRETVALUE", undefined],
    ]) {
      expect(deployKeyProblem(key, dep)).not.toContain("SECRETVALUE");
    }
  });
});

describe("effectiveDeployKey", () => {
  const withWebDir = (envLocal, fn) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nb-seed-envkey-"));
    try {
      if (envLocal !== null) writeFileSync(path.join(dir, ".env.local"), envLocal);
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("the environment wins over .env.local", () => {
    withWebDir("CONVEX_DEPLOY_KEY=from-file\n", (dir) => {
      expect(effectiveDeployKey({ CONVEX_DEPLOY_KEY: "from-env" }, dir)).toBe("from-env");
    });
  });

  test("falls back to .env.local, stripping quotes and trailing comments", () => {
    withWebDir('OTHER=1\nCONVEX_DEPLOY_KEY="dev:happy-animal-123|tok" # note\n', (dir) => {
      expect(effectiveDeployKey({}, dir)).toBe("dev:happy-animal-123|tok");
    });
  });

  test("is empty with no env key and no file, or no matching line", () => {
    withWebDir(null, (dir) => expect(effectiveDeployKey({}, dir)).toBe(""));
    withWebDir("NOT_THE_KEY=1\n", (dir) => expect(effectiveDeployKey({}, dir)).toBe(""));
  });
});

describe("parity with the places the script must agree with", () => {
  test("PROD_DEPLOYMENT_NAME equals the one in e2e-baseline.sh", () => {
    const sh = readFileSync(path.join(WEB_DIR, "e2e-baseline.sh"), "utf8");
    const m = /^PROD_DEPLOYMENT_NAME="([^"]+)"/m.exec(sh);
    expect(m, "e2e-baseline.sh no longer defines PROD_DEPLOYMENT_NAME").not.toBeNull();
    expect(PROD_DEPLOYMENT_NAME).toBe(m[1]);
  });

  test("BUNDLE_TABLES is the set the scoped reset skips (REFERENCE_SEED_TABLES)", () => {
    expect([...REFERENCE_SEED_TABLES].sort()).toEqual(BUNDLE_TABLES.map((t) => `${t}Deleted`).sort());
  });
});

describe("no bundle is tracked", () => {
  test("git ls-files finds no .zip or .jsonl under scripts/reference-seed", () => {
    const out = execFileSync("git", ["-C", WEB_DIR, "ls-files", "--", "scripts/reference-seed"], { encoding: "utf8" });
    const files = out.split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(0); // the scripts themselves, so the command is really listing
    expect(files.filter((f) => /\.(zip|jsonl)$/i.test(f))).toEqual([]);
  });
});
