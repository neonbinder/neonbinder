import { describe, expect, test } from "vitest";
import { encodeId } from "./convexIdCodec";
import {
  EBAY_ASPECT_VALUE_MAX,
  EBAY_DESCRIPTOR_VALUE,
  EBAY_DEFAULT_CARD_WEIGHT_OZ,
  EBAY_ENVELOPE_PACKAGE,
  EBAY_ESE_CARRIER,
  EBAY_ESE_SERVICE_CODE,
  EBAY_MAX_CARD_WEIGHT_OZ,
  EBAY_MAILER_PACKAGE,
  EBAY_MAILER_WEIGHT_OZ,
  EBAY_ORDER_STATUSES,
  EBAY_SKU_MAX,
  buildEbayAspects,
  buildEbaySku,
  centsToEbayValue,
  contentFingerprint,
  ebayBucketOf,
  ebayGroundAdvantageService,
  ebayOrderDisposition,
  ebayOrderStatus,
  ebayEnvelopePackage,
  ebayPackageFor,
  ebayServiceNames,
  ebayServiceTakesCalculated,
  ebayServiceCarrier,
  EBAY_USPS_CARRIER_FALLBACK,
  ebaySetupMissing,
  ebayStatusDisposition,
  ebayValueToCents,
  foldEbayTargets,
  fulfillmentSlotFor,
  isFinalEbayStatus,
  isValidCardWeightOz,
  missingRequiredAspects,
  nbConditionsOfBucket,
  ordersModifiedSinceFilter,
  parseEbaySku,
  policyFitness,
  projectEbayOrder,
  readCategoryAspects,
  readFulfillmentPolicies,
  readReturnPolicies,
  ebayListingText,
  type EbayListingCopy,
} from "./ebayListing";
import type { NbCondition } from "./bscConditions";

const bytes = (seed: number) => Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i * 7) & 0xff);
const cardId = (seed: number) => encodeId(10005, bytes(seed));

const ALL_CONDITIONS: NbCondition[] = ["Mint", "Near Mint", "Excellent", "Very Good", "Good", "Poor"];

describe("eBay SKU (NEO-415)", () => {
  test("build then parse round-trips the card id and bucket", () => {
    const id = cardId(1);
    const sku = buildEbaySku(id, "VG");
    expect(sku).toBe(`NB2-${id}-VG`);
    expect(parseEbaySku(sku)).toEqual({ cardId: id, conditionCode: "VG" });
  });

  test("a SKU stays inside eBay's 50 character cap", () => {
    expect(buildEbaySku(cardId(2), "NM").length).toBeLessThanOrEqual(EBAY_SKU_MAX);
  });

  test("build throws on a string that is not a Convex id", () => {
    expect(() => buildEbaySku("not-an-id", "NM")).toThrow(/not a Convex id/);
  });

  test("parse trims surrounding whitespace", () => {
    const id = cardId(3);
    expect(parseEbaySku(`  NB2-${id}-PR \n`)?.conditionCode).toBe("PR");
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["BSC NB1 SKU", `NB1-${cardId(4)}-NM`],
    ["seller typed", "MY-CARD-001"],
    ["unknown bucket", `NB2-${cardId(4)}-XX`],
    ["lowercase bucket", `NB2-${cardId(4)}-nm`],
    ["too long", `NB2-${cardId(4)}-NM-${"x".repeat(40)}`],
    ["right shape but not a real id", `NB2-${"a".repeat(32)}-NM`],
  ])("parse rejects a foreign SKU: %s", (_label, sku) => {
    expect(parseEbaySku(sku as string | null | undefined)).toBeNull();
  });
});

describe("condition buckets (NEO-415)", () => {
  test.each([
    ["Mint", "NM"],
    ["Near Mint", "NM"],
    ["Excellent", "EX"],
    ["Very Good", "VG"],
    ["Good", "VG"],
    ["Poor", "PR"],
  ] as const)("%s lists in bucket %s", (condition, bucket) => {
    expect(ebayBucketOf(condition)).toBe(bucket);
  });

  test("every bucket has a Card Condition descriptor id", () => {
    expect(EBAY_DESCRIPTOR_VALUE).toEqual({ NM: "400010", EX: "400011", VG: "400012", PR: "400013" });
    for (const c of ALL_CONDITIONS) expect(EBAY_DESCRIPTOR_VALUE[ebayBucketOf(c)]).toMatch(/^40001\d$/);
  });

  test("nbConditionsOfBucket lists every condition folded into the bucket and nothing else", () => {
    expect(nbConditionsOfBucket("NM").sort()).toEqual(["Mint", "Near Mint"]);
    expect(nbConditionsOfBucket("VG").sort()).toEqual(["Good", "Very Good"]);
    expect(nbConditionsOfBucket("EX")).toEqual(["Excellent"]);
    expect(nbConditionsOfBucket("PR")).toEqual(["Poor"]);
    expect(nbConditionsOfBucket("ZZ")).toEqual([]);
  });
});

describe("buildEbayAspects (NEO-415)", () => {
  const base = { cardNumber: "12", sport: "Baseball", playerNames: ["Ken Griffey Jr."], teamNames: ["Mariners"] };

  test("maps NB facts to eBay's aspect names", () => {
    const a = buildEbayAspects({
      ...base,
      season: "1989",
      manufacturer: "Upper Deck",
      setName: "Baseball",
      insertName: "Star Rookies",
      parallelName: "Gold",
    });
    expect(a).toMatchObject({
      Sport: ["Baseball"],
      "Player/Athlete": ["Ken Griffey Jr."],
      Team: ["Mariners"],
      Manufacturer: ["Upper Deck"],
      Set: ["1989 Baseball"],
      Season: ["1989"],
      "Year Manufactured": ["1989"],
      "Card Number": ["12"],
      "Parallel/Variety": ["Gold"],
      "Insert Set": ["Star Rookies"],
      Type: ["Sports Trading Card"],
      Graded: ["No"],
      Autographed: ["No"],
    });
  });

  test("a two-year season is a Season but not a Year Manufactured", () => {
    const a = buildEbayAspects({ ...base, season: "2021-22" });
    expect(a.Season).toEqual(["2021-22"]);
    expect(a["Year Manufactured"]).toBeUndefined();
  });

  test("missing data leaves the aspect out rather than empty", () => {
    const a = buildEbayAspects({ cardNumber: "7" });
    expect(Object.keys(a).sort()).toEqual(["Autographed", "Card Number", "Graded", "Type"]);
  });

  test("a value over 65 characters is dropped, not cut", () => {
    const long = "x".repeat(EBAY_ASPECT_VALUE_MAX + 1);
    const exact = "y".repeat(EBAY_ASPECT_VALUE_MAX);
    const a = buildEbayAspects({ ...base, playerNames: [long, exact] });
    expect(a["Player/Athlete"]).toEqual([exact]);
    expect(buildEbayAspects({ ...base, playerNames: [long] })["Player/Athlete"]).toBeUndefined();
  });

  test("the category's own aspect maxLength lowers the cap", () => {
    const a = buildEbayAspects({ ...base, teamNames: ["Mariners"] }, new Map([["Team", 5]]));
    expect(a.Team).toBeUndefined();
  });

  test("duplicate values collapse and a list is capped at 30", () => {
    const names = Array.from({ length: 40 }, (_, i) => `P${i}`);
    expect(buildEbayAspects({ ...base, playerNames: [...names, "P0"] })["Player/Athlete"]).toHaveLength(30);
    expect(buildEbayAspects({ ...base, playerNames: ["A", "A", " A "] })["Player/Athlete"]).toEqual(["A"]);
  });

  test("a base parallel is not sent as a Parallel/Variety", () => {
    expect(buildEbayAspects({ ...base, parallelName: "Base" })["Parallel/Variety"]).toBeUndefined();
  });

  test("an all-brands manufacturer is not sent as a Manufacturer", () => {
    expect(buildEbayAspects({ ...base, manufacturer: "All Brands", manufacturerBrandUnknown: true }).Manufacturer).toBeUndefined();
  });

  test("rookie and short print become Features", () => {
    expect(buildEbayAspects({ ...base, isRookie: true, shortPrint: "SSP" }).Features).toEqual(["Rookie", "Short Print"]);
    expect(buildEbayAspects({ ...base, shortPrint: "None" }).Features).toBeUndefined();
  });

  test("an on-card autograph sends Yes and On Card; a sticker sends Sticker; None sends No", () => {
    const onCard = buildEbayAspects({ ...base, autographed: "On Card" });
    expect(onCard.Autographed).toEqual(["Yes"]);
    expect(onCard["Autograph Format"]).toEqual(["On Card"]);
    const sticker = buildEbayAspects({ ...base, autographed: "Sticker/Label" });
    expect(sticker["Autograph Format"]).toEqual(["Sticker"]);
    const none = buildEbayAspects({ ...base, autographed: "None" });
    expect(none.Autographed).toEqual(["No"]);
    expect(none["Autograph Format"]).toBeUndefined();
  });

  test("print run is sent only as a positive integer", () => {
    expect(buildEbayAspects({ ...base, printRun: 99 })["Print Run"]).toEqual(["99"]);
    expect(buildEbayAspects({ ...base, printRun: 0 })["Print Run"]).toBeUndefined();
    expect(buildEbayAspects({ ...base, printRun: 2.5 })["Print Run"]).toBeUndefined();
  });
});

describe("required aspects (NEO-415)", () => {
  test("missingRequiredAspects names the required aspects that are empty or absent", () => {
    expect(missingRequiredAspects({ Sport: ["Baseball"], Team: [] }, ["Sport", "Team", "Set"])).toEqual(["Team", "Set"]);
    expect(missingRequiredAspects({ Sport: ["Baseball"] }, ["Sport"])).toEqual([]);
  });

  test("readCategoryAspects reads required names and max lengths, skipping junk", () => {
    const out = readCategoryAspects({
      aspects: [
        { localizedAspectName: "Sport", aspectConstraint: { aspectRequired: true, aspectMaxLength: 30 } },
        { localizedAspectName: "Team", aspectConstraint: {} },
        { localizedAspectName: "x".repeat(101), aspectConstraint: { aspectRequired: true } },
        "junk",
        { aspectConstraint: { aspectRequired: true } },
      ],
    });
    expect(out.required).toEqual(["Sport"]);
    expect([...out.maxLengths]).toEqual([["Sport", 30]]);
  });

  test("readCategoryAspects survives a body that is not an object", () => {
    expect(readCategoryAspects(null)).toEqual({ required: [], maxLengths: new Map() });
    expect(readCategoryAspects({ aspects: "no" }).required).toEqual([]);
  });
});

describe("policy fitness (NEO-415)", () => {
  const policy = (domestic: Array<{ code: string; costCents: number | null; free: boolean }>) => ({ id: "p", name: "n", domestic });

  test("ESE-only fits under $20 and is flagged eseOnly", () => {
    const f = policyFitness(policy([{ code: "US_eBayStandardEnvelope", costCents: 100, free: false }]));
    expect(f).toMatchObject({ eseFit: true, eseOnly: true, freeShipping: false, summary: "Standard Envelope, $1.00" });
  });

  test("ESE plus a parcel service is a fit and not ESE-only", () => {
    const f = policyFitness(
      policy([
        { code: "US_eBayStandardEnvelope", costCents: 100, free: false },
        { code: "USPSGroundAdvantage", costCents: 450, free: false },
      ]),
    );
    expect(f).toMatchObject({ eseFit: true, eseOnly: false });
  });

  test("NB's own Envelope or Tracked policy (both calculated) fits under $20 and is allowed for $20+ too (not envelope-only)", () => {
    const f = policyFitness(
      policy([
        { code: "US_eBayStandardEnvelope", costCents: null, free: false },
        { code: "USPSParcel", costCents: null, free: false },
      ]),
      new Map([["USPSParcel", "USPS Ground Advantage"]]),
    );
    expect(f).toEqual({
      eseFit: true,
      eseOnly: false,
      freeShipping: false,
      summary: "Standard Envelope, eBay's rate by weight; USPS Ground Advantage, eBay's rate by weight",
    });
  });

  test("a free service marks the policy free, by flag or by a zero cost", () => {
    expect(policyFitness(policy([{ code: "USPSGroundAdvantage", costCents: null, free: true }])).freeShipping).toBe(true);
    expect(policyFitness(policy([{ code: "USPSGroundAdvantage", costCents: 0, free: false }])).freeShipping).toBe(true);
  });

  test("the summary names each service by eBay's own name, never its code; calculated reads as eBay's rate by weight", () => {
    const names = ebayServiceNames([
      { code: "USPSParcel", description: "USPS Ground Advantage" },
      { code: "USPSPriority", description: null },
      { code: "Blank", description: "   " },
    ]);
    const f = policyFitness(
      policy([
        { code: "US_eBayStandardEnvelope", costCents: null, free: false },
        { code: "USPSParcel", costCents: null, free: false },
        { code: "USPSPriority", costCents: 950, free: false },
        { code: "Blank", costCents: 0, free: false },
      ]),
      names,
    );
    expect(f.summary).toBe(
      "Standard Envelope, eBay's rate by weight; USPS Ground Advantage, eBay's rate by weight; eBay shipping, $9.50; eBay shipping, free",
    );
    expect(f.summary).not.toMatch(/USPSParcel|USPSPriority|Blank/);
    // No metadata at all: still no code.
    expect(policyFitness(policy([{ code: "USPSParcel", costCents: null, free: true }])).summary).toBe("eBay shipping, free");
  });

  test("a policy with no domestic service is neither ESE-fit nor ESE-only", () => {
    const f = policyFitness(policy([]));
    expect(f).toMatchObject({ eseFit: false, eseOnly: false, freeShipping: false, summary: "No domestic shipping" });
  });

  test("readFulfillmentPolicies keeps only DOMESTIC services and skips unreadable entries", () => {
    const out = readFulfillmentPolicies({
      fulfillmentPolicies: [
        {
          fulfillmentPolicyId: "1",
          name: "Cards",
          shippingOptions: [
            { optionType: "DOMESTIC", shippingServices: [{ shippingServiceCode: "A", shippingCost: { value: "1.5" } }] },
            { optionType: "INTERNATIONAL", shippingServices: [{ shippingServiceCode: "B" }] },
          ],
        },
        { name: "no id" },
      ],
    });
    expect(out).toEqual([{ id: "1", name: "Cards", domestic: [{ code: "A", costCents: 150, free: false }] }]);
  });

  test("readReturnPolicies summarises accepted and refused returns", () => {
    const out = readReturnPolicies({
      returnPolicies: [
        { returnPolicyId: "r1", name: "30", returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "SELLER" },
        { returnPolicyId: "r2", name: "None", returnsAccepted: false },
      ],
    });
    expect(out.map((p) => p.summary)).toEqual(["30 days, you pay return shipping", "No returns"]);
  });
});

describe("price to shipping slot and floor (NEO-415)", () => {
  test.each([
    [1999, "under20"],
    [2000, "twentyPlus"],
    [2001, "twentyPlus"],
  ] as const)("%i cents uses the %s slot", (cents, slot) => {
    expect(fulfillmentSlotFor(cents)).toBe(slot);
  });

  test("the raw-card packages are Jason's: a 6 x 4 x 1 in letter at 1 oz by default, a 6 oz packaged bubble mailer", () => {
    expect(EBAY_DEFAULT_CARD_WEIGHT_OZ).toBe(1);
    expect(EBAY_MAILER_WEIGHT_OZ).toBe(6);
    // The letter his working production listings carry (Trading API: Letter, 6 x 4 x 1 in, whole-inch thickness).
    expect(EBAY_ENVELOPE_PACKAGE).toEqual({
      packageType: "LETTER",
      weight: { value: 1, unit: "OUNCE" },
      dimensions: { length: 6, width: 4, height: 1, unit: "INCH" },
    });
    expect(EBAY_MAILER_PACKAGE).toEqual({
      packageType: "PADDED_BAGS",
      weight: { value: 6, unit: "OUNCE" },
      dimensions: { length: 10, width: 6, height: 1, unit: "INCH" },
    });
  });

  test("a card weight is a whole 1, 2 or 3 oz: Standard Envelope tops out at 3 oz", () => {
    expect(EBAY_MAX_CARD_WEIGHT_OZ).toBe(3);
    for (const ok of [1, 2, 3]) expect(isValidCardWeightOz(ok)).toBe(true);
    for (const bad of [0, 4, 16, 1.5, 2.0001, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(isValidCardWeightOz(bad)).toBe(false);
  });

  test.each([
    [99, EBAY_ENVELOPE_PACKAGE],
    [1999, EBAY_ENVELOPE_PACKAGE],
    [2000, EBAY_MAILER_PACKAGE],
    [250000, EBAY_MAILER_PACKAGE],
  ] as const)("%i cents ships in the package of its slot", (cents, pkg) => {
    expect(ebayPackageFor(cents)).toEqual(pkg);
    expect(ebayPackageFor(cents).packageType === "PADDED_BAGS").toBe(fulfillmentSlotFor(cents) === "twentyPlus");
  });

  test("under $20 the letter weighs the collector's card weight; $20 and up the mailer stays 6 oz", () => {
    expect(ebayPackageFor(1999, 3)).toEqual({ ...EBAY_ENVELOPE_PACKAGE, weight: { value: 3, unit: "OUNCE" } });
    expect(ebayPackageFor(99, 2).weight).toEqual({ value: 2, unit: "OUNCE" });
    expect(ebayPackageFor(2000, 3)).toEqual(EBAY_MAILER_PACKAGE);
    // A weight NB would never store reads as the default rather than reaching eBay.
    for (const bad of [0, 4, 1.5, Number.NaN]) expect(ebayPackageFor(99, bad)).toEqual(EBAY_ENVELOPE_PACKAGE);
    expect(ebayEnvelopePackage(3).dimensions).toEqual(EBAY_ENVELOPE_PACKAGE.dimensions);
  });

  test("the item fingerprint changes when the card weight changes the package", () => {
    const content = (pkg: unknown) => contentFingerprint({ text: { title: "t", description: "d" }, package: pkg });
    expect(content(ebayPackageFor(99, 1))).not.toBe(content(ebayPackageFor(99, 3)));
    expect(content(ebayPackageFor(99, 2))).toBe(content(ebayPackageFor(99, 2)));
    // $20 and up ignores the card weight, so it changes nothing there.
    expect(content(ebayPackageFor(2500, 1))).toBe(content(ebayPackageFor(2500, 3)));
  });

  test("a calculated rate is refused when eBay does not list the service, or lists its cost types without CALCULATED", () => {
    const svc = (costTypes: string[]) => [{ code: EBAY_ESE_SERVICE_CODE, costTypes }];
    expect(ebayServiceTakesCalculated(svc(["CALCULATED", "FLAT"]), EBAY_ESE_SERVICE_CODE)).toBe(true);
    expect(ebayServiceTakesCalculated(svc(["flat_rate", "calculated"]), EBAY_ESE_SERVICE_CODE)).toBe(true);
    expect(ebayServiceTakesCalculated(svc(["FLAT_RATE"]), EBAY_ESE_SERVICE_CODE)).toBe(false);
    expect(ebayServiceTakesCalculated(svc(["FLAT_RATE", "FREIGHT"]), EBAY_ESE_SERVICE_CODE)).toBe(false);
    // Listed without cost types: eBay decides when the policy is made.
    expect(ebayServiceTakesCalculated(svc([]), EBAY_ESE_SERVICE_CODE)).toBe(true);
    // Not listed: NB cannot verify the service exists, so it is never asked for.
    expect(ebayServiceTakesCalculated([], EBAY_ESE_SERVICE_CODE)).toBe(false);
    expect(ebayServiceTakesCalculated(svc(["CALCULATED"]), "USPSGroundAdvantage")).toBe(false);
  });

  test("a service's carrier code is eBay's metadata value for that exact code, else the fallback", () => {
    const services = [
      { code: EBAY_ESE_SERVICE_CODE, carrier: "eBay Send" },
      { code: "USPSParcel", carrier: " USPS " },
      { code: "NoCarrier", carrier: null },
      { code: "Blank", carrier: "  " },
    ];
    expect(ebayServiceCarrier(services, EBAY_ESE_SERVICE_CODE, "FALLBACK")).toBe("eBay Send");
    expect(ebayServiceCarrier(services, "USPSParcel", "FALLBACK")).toBe("USPS");
    expect(ebayServiceCarrier(services, "NoCarrier", "FALLBACK")).toBe("FALLBACK");
    expect(ebayServiceCarrier(services, "Blank", "FALLBACK")).toBe("FALLBACK");
    expect(ebayServiceCarrier(services, "Missing", "FALLBACK")).toBe("FALLBACK");
    expect(ebayServiceCarrier(services, "usps_parcel", "FALLBACK")).toBe("FALLBACK");
    expect(EBAY_USPS_CARRIER_FALLBACK).toBe("USPS");
    // The envelope's carrier is fixed, as eBay documents it, never read from the metadata.
    expect(EBAY_ESE_CARRIER).toBe("USPS");
  });

  const copy = (over: Partial<EbayListingCopy> = {}): EbayListingCopy => ({
    copyId: "copy1" as never,
    homeId: "box1" as never,
    cardId: cardId(9) as never,
    homeIsBox: true,
    graded: false,
    quantity: 1,
    condition: "Near Mint",
    minPriceCents: 500,
    hasPhotos: true,
    creationTime: 1_000,
    ...over,
  });

  test("a price under the $0.99 floor is raised to it; zero too", () => {
    for (const p of [0, 50, 98]) {
      const { targets } = foldEbayTargets({ copies: [copy({ minPriceCents: p })], commonPriceCents: null });
      expect(targets[0].priceCents).toBe(99);
    }
  });

  test("$0.99 stays $0.99 and the highest floor wins", () => {
    const { targets } = foldEbayTargets({
      copies: [copy({ copyId: "a" as never, minPriceCents: 99 }), copy({ copyId: "b" as never, minPriceCents: 2000 })],
      commonPriceCents: null,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ quantity: 2, priceCents: 2000 });
  });

  test("copies with no own price fall back to the common price", () => {
    const { targets } = foldEbayTargets({ copies: [copy({ minPriceCents: undefined })], commonPriceCents: 750 });
    expect(targets[0].priceCents).toBe(750);
  });

  test("no price anywhere gives a target with a null price (the drain holds it noPrice)", () => {
    const { targets } = foldEbayTargets({ copies: [copy({ minPriceCents: undefined })], commonPriceCents: null });
    expect(targets[0].priceCents).toBeNull();
  });

  test("Mint and Near Mint fold into one listing; Good and Very Good fold into another", () => {
    const { targets } = foldEbayTargets({
      copies: [
        copy({ copyId: "a" as never, condition: "Mint" }),
        copy({ copyId: "b" as never, condition: "Near Mint", quantity: 2 }),
        copy({ copyId: "c" as never, condition: "Good" }),
        copy({ copyId: "d" as never, condition: "Very Good" }),
      ],
      commonPriceCents: null,
    });
    expect(targets.map((t) => [t.conditionCode, t.quantity]).sort()).toEqual([
      ["NM", 3],
      ["VG", 2],
    ]);
  });

  test("copies outside a listed box are ignored entirely", () => {
    const out = foldEbayTargets({ copies: [copy({ homeIsBox: false, graded: true })], commonPriceCents: null });
    expect(out).toEqual({ targets: [], holds: [] });
  });

  test("graded and condition-less copies are held back, once per card and reason", () => {
    const { targets, holds } = foldEbayTargets({
      copies: [
        copy({ copyId: "a" as never, graded: true }),
        copy({ copyId: "b" as never, graded: true }),
        copy({ copyId: "c" as never, condition: undefined }),
      ],
      commonPriceCents: null,
    });
    expect(targets).toEqual([]);
    expect(holds.map((h) => h.reason)).toEqual(["graded", "noCondition"]);
  });

  test("the oldest copy with photos supplies them, not the oldest copy", () => {
    const { targets } = foldEbayTargets({
      copies: [
        copy({ copyId: "newest" as never, creationTime: 9_000_000_000, hasPhotos: true }),
        copy({ copyId: "middle" as never, creationTime: 5_000_000_000, hasPhotos: true }),
        copy({ copyId: "old" as never, creationTime: 0, hasPhotos: false }),
      ],
      commonPriceCents: null,
    });
    expect(targets[0].photoCopyId).toBe("middle");
    expect(targets[0].quantity).toBe(3);
  });

  test("a group with no photo on any copy has no photo copy", () => {
    const { targets } = foldEbayTargets({
      copies: [copy({ copyId: "a" as never, hasPhotos: false }), copy({ copyId: "b" as never, hasPhotos: false })],
      commonPriceCents: null,
    });
    expect(targets[0].photoCopyId).toBeNull();
  });

  test("a photo on a copy in another condition doesn't count for this group", () => {
    const { targets } = foldEbayTargets({
      copies: [
        copy({ copyId: "nm" as never, condition: "Near Mint", hasPhotos: false }),
        copy({ copyId: "good" as never, condition: "Good", hasPhotos: true }),
      ],
      commonPriceCents: null,
    });
    expect(targets.map((t) => t.photoCopyId).sort()).toEqual(["good", null].sort());
  });

  test("zero or fractional quantities are skipped", () => {
    const { targets } = foldEbayTargets({
      copies: [copy({ quantity: 0 }), copy({ quantity: 1.5 })],
      commonPriceCents: null,
    });
    expect(targets).toEqual([]);
  });
});

describe("money helpers (NEO-415)", () => {
  test("centsToEbayValue pads cents", () => {
    expect(centsToEbayValue(99)).toBe("0.99");
    expect(centsToEbayValue(2000)).toBe("20.00");
    expect(centsToEbayValue(1205)).toBe("12.05");
  });

  test("ebayValueToCents reads decimals and refuses anything else", () => {
    expect(ebayValueToCents("12.5")).toBe(1250);
    expect(ebayValueToCents("0.99")).toBe(99);
    expect(ebayValueToCents("7")).toBe(700);
    expect(ebayValueToCents("-1.00")).toBe(-100);
    expect(ebayValueToCents("1.234")).toBeNull();
    expect(ebayValueToCents("abc")).toBeNull();
    expect(ebayValueToCents(12)).toBeNull();
  });

  test("ebayListingText caps the title at 80 and falls back to the title for a blank description", () => {
    const out = ebayListingText({ listingTitle: ` ${"t".repeat(100)} `, listingDescription: "  " });
    expect(out.title).toHaveLength(80);
    expect(out.description).toBe(out.title);
  });

  test("contentFingerprint ignores key order and changes with content", () => {
    expect(contentFingerprint({ a: 1, b: [1, 2] })).toBe(contentFingerprint({ b: [1, 2], a: 1 }));
    expect(contentFingerprint({ a: 1 })).not.toBe(contentFingerprint({ a: 2 }));
  });
});

describe("order disposition and status (NEO-415)", () => {
  test.each([
    [{ paymentStatus: "PAID" }, "sale"],
    [{ paymentStatus: "PARTIALLY_REFUNDED" }, "sale"],
    [{ paymentStatus: "FULLY_REFUNDED" }, "cancelled"],
    [{ paymentStatus: "PAID", cancelState: "CANCELED" }, "cancelled"],
    [{ paymentStatus: "PENDING" }, "unknown"],
    [{ paymentStatus: "FAILED" }, "unknown"],
    [{}, "unknown"],
  ] as const)("disposition %j is %s", (facts, expected) => {
    expect(ebayOrderDisposition(facts)).toBe(expected);
  });

  test("a cancellation still being decided is not a cancellation", () => {
    expect(ebayOrderDisposition({ paymentStatus: "PAID", cancelState: "IN_PROGRESS" })).toBe("sale");
  });

  test("status prefers cancel, then refund or unpaid, then fulfillment, then PAID, then PENDING", () => {
    expect(ebayOrderStatus({ cancelState: "CANCELED", paymentStatus: "PAID", fulfillmentStatus: "FULFILLED" })).toBe("CANCELED");
    expect(ebayOrderStatus({ paymentStatus: "FULLY_REFUNDED", fulfillmentStatus: "FULFILLED" })).toBe("FULLY_REFUNDED");
    expect(ebayOrderStatus({ paymentStatus: "PARTIALLY_REFUNDED" })).toBe("PARTIALLY_REFUNDED");
    expect(ebayOrderStatus({ paymentStatus: "PAID", fulfillmentStatus: "IN_PROGRESS" })).toBe("IN_PROGRESS");
    expect(ebayOrderStatus({ paymentStatus: "PAID", fulfillmentStatus: "WEIRD" })).toBe("PAID");
    expect(ebayOrderStatus({})).toBe("PENDING");
  });

  test("every status NB can store is a member of EBAY_ORDER_STATUSES and has a stored disposition", () => {
    const facts = [
      {},
      { paymentStatus: "PAID" },
      { paymentStatus: "PENDING" },
      { paymentStatus: "FAILED" },
      { paymentStatus: "PARTIALLY_REFUNDED" },
      { paymentStatus: "FULLY_REFUNDED" },
      { cancelState: "CANCELED" },
      { paymentStatus: "PAID", fulfillmentStatus: "NOT_STARTED" },
      { paymentStatus: "PAID", fulfillmentStatus: "FULFILLED" },
    ];
    for (const f of facts) {
      const status = ebayOrderStatus(f);
      expect(EBAY_ORDER_STATUSES).toContain(status);
      // Stored disposition must agree with the live one for every payment state.
      if (f.cancelState === "CANCELED" || f.paymentStatus === "FULLY_REFUNDED") {
        expect(ebayStatusDisposition(status)).toBe("cancelled");
      }
    }
  });

  test("ebayStatusDisposition: paid and fulfillment words sell; unknown words wait", () => {
    for (const s of ["PAID", "NOT_STARTED", "IN_PROGRESS", "FULFILLED", "PARTIALLY_REFUNDED"]) {
      expect(ebayStatusDisposition(s)).toBe("sale");
    }
    for (const s of ["CANCELED", "FULLY_REFUNDED"]) expect(ebayStatusDisposition(s)).toBe("cancelled");
    for (const s of ["PENDING", "FAILED", "SOMETHING"]) expect(ebayStatusDisposition(s)).toBe("unknown");
  });

  test("final statuses stop re-reads", () => {
    expect(["FULFILLED", "CANCELED", "FULLY_REFUNDED"].every(isFinalEbayStatus)).toBe(true);
    expect(["PAID", "PENDING", "IN_PROGRESS"].some(isFinalEbayStatus)).toBe(false);
  });
});

describe("projectEbayOrder (NEO-415)", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    orderId: "27-12345-67890",
    creationDate: "2026-10-30T15:01:06.541Z",
    lastModifiedDate: "2026-10-31T10:00:00.000Z",
    orderPaymentStatus: "PAID",
    orderFulfillmentStatus: "NOT_STARTED",
    pricingSummary: { priceSubtotal: { value: "30.00" }, deliveryCost: { value: "1.00" }, total: { value: "31.00" } },
    totalMarketplaceFee: { value: "4.00" },
    lineItems: [{ legacyItemId: "123456", sku: "NB2-x-NM", quantity: 2, lineItemCost: { value: "30.00" } }],
    buyer: { username: "secretbuyer" },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Hidden Person" } } }],
    ...over,
  });

  test("projects ids, dates, totals and lines with the unit price per copy", () => {
    const p = projectEbayOrder(order());
    expect(p).toMatchObject({
      orderId: "27-12345-67890",
      orderNo: "27-12345-67890",
      orderDate: Date.UTC(2026, 9, 30, 15, 1, 6, 541),
      lastModified: Date.UTC(2026, 9, 31, 10),
      status: "NOT_STARTED",
      disposition: "sale",
      totals: { subtotalCents: 3000, shippingCents: 100, feesCents: 400, totalCents: 3100 },
    });
    expect(p?.lines).toEqual([{ legacyItemId: "123456", sku: "NB2-x-NM", quantity: 2, unitPriceCents: 1500 }]);
  });

  test("never carries buyer or ship-to data", () => {
    const text = JSON.stringify(projectEbayOrder(order()));
    expect(text).not.toContain("secretbuyer");
    expect(text).not.toContain("Hidden Person");
  });

  test("a cancelled order projects as cancelled", () => {
    const p = projectEbayOrder(order({ cancelStatus: { cancelState: "CANCELED" } }));
    expect(p).toMatchObject({ status: "CANCELED", disposition: "cancelled" });
  });

  test("a refunded order projects as cancelled", () => {
    expect(projectEbayOrder(order({ orderPaymentStatus: "FULLY_REFUNDED" }))?.disposition).toBe("cancelled");
  });

  test("unit price rounds a cost that does not divide evenly", () => {
    const p = projectEbayOrder(order({ lineItems: [{ legacyItemId: "1", quantity: 3, lineItemCost: { value: "10.00" } }] }));
    expect(p?.lines[0].unitPriceCents).toBe(333);
  });

  test("lines with a bad quantity, cost or item id are dropped", () => {
    const p = projectEbayOrder(
      order({
        lineItems: [
          { legacyItemId: "1", quantity: 0, lineItemCost: { value: "1.00" } },
          { legacyItemId: "2", quantity: 1.5, lineItemCost: { value: "1.00" } },
          { legacyItemId: "3", quantity: 1, lineItemCost: { value: "x" } },
          { quantity: 1, lineItemCost: { value: "1.00" } },
          { legacyItemId: "ok", quantity: 1, lineItemCost: { value: "1.00" } },
        ],
      }),
    );
    expect(p?.lines.map((l) => l.legacyItemId)).toEqual(["ok"]);
  });

  test("an order without an id or a readable date is null", () => {
    expect(projectEbayOrder(order({ orderId: undefined }))).toBeNull();
    expect(projectEbayOrder(order({ creationDate: "yesterday" }))).toBeNull();
    expect(projectEbayOrder(null)).toBeNull();
    expect(projectEbayOrder([])).toBeNull();
  });

  test("a missing lastModifiedDate falls back to the creation date", () => {
    const p = projectEbayOrder(order({ lastModifiedDate: undefined }));
    expect(p?.lastModified).toBe(p?.orderDate);
  });

  test("ordersModifiedSinceFilter is eBay's lastmodifieddate range in UTC", () => {
    expect(ordersModifiedSinceFilter(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("lastmodifieddate:[2026-01-02T03:04:05.000Z..]");
  });
});

describe("ebaySetupMissing (NEO-415)", () => {
  test("null settings lack everything, in page order", () => {
    expect(ebaySetupMissing(null)).toEqual(["location", "shippingUnder20", "shipping20Plus", "payment", "returns"]);
  });

  test("a location without a merchant key still counts as missing", () => {
    expect(
      ebaySetupMissing({
        fulfillmentPolicyUnder20Id: "a",
        fulfillmentPolicy20PlusId: "b",
        paymentPolicyId: "c",
        returnPolicyId: "d",
        location: { postalCode: "1" },
      }),
    ).toEqual(["location"]);
  });

  test("complete settings lack nothing", () => {
    expect(
      ebaySetupMissing({
        fulfillmentPolicyUnder20Id: "a",
        fulfillmentPolicy20PlusId: "b",
        paymentPolicyId: "c",
        returnPolicyId: "d",
        merchantLocationKey: "k",
        location: {},
      }),
    ).toEqual([]);
  });
});

describe("ebayGroundAdvantageService: eBay's Ground Advantage code, read from its metadata (NEO-415)", () => {
  const svc = (code: string, description: string | null, over: Partial<{ carrier: string | null; international: boolean; validForSelling: boolean }> = {}) => ({
    code,
    description,
    carrier: "USPS" as string | null,
    international: false,
    validForSelling: true,
    ...over,
  });

  test("a code that names it wins (separators and case ignored)", () => {
    expect(ebayGroundAdvantageService([svc("USPSPriority", "USPS Priority Mail"), svc("USPSGroundAdvantage", null)])?.code).toBe("USPSGroundAdvantage");
    expect(ebayGroundAdvantageService([svc("US_USPS_Ground_Advantage", null)])?.code).toBe("US_USPS_Ground_Advantage");
  });

  test("no code names it: eBay's name for it decides (the code eBay kept from before the rename)", () => {
    const list = [svc("USPSPriority", "USPS Priority Mail"), svc("USPSParcel", "USPS Ground Advantage"), svc("USPSMedia", "USPS Media Mail")];
    expect(ebayGroundAdvantageService(list)?.code).toBe("USPSParcel");
  });

  test("the name match ignores case, trademark marks and a trailing note", () => {
    expect(ebayGroundAdvantageService([svc("USPSParcel", "USPS Ground Advantage™ (2 to 5 business days)")])?.code).toBe("USPSParcel");
    expect(ebayGroundAdvantageService([svc("USPSParcel", "usps ground advantage")])?.code).toBe("USPSParcel");
  });

  test("an exact name beats a longer one that also says it", () => {
    const list = [svc("USPSGACubic", "USPS Ground Advantage Cubic"), svc("USPSParcel", "USPS Ground Advantage")];
    expect(ebayGroundAdvantageService(list)?.code).toBe("USPSParcel");
  });

  test("only a longer name says it: taken when exactly one does and USPS is the carrier or in the name", () => {
    expect(ebayGroundAdvantageService([svc("X1", "Ground Advantage (USPS)", { carrier: null })])?.code).toBe("X1");
    expect(ebayGroundAdvantageService([svc("X1", "Ground Advantage Economy", { carrier: "USPS" })])?.code).toBe("X1");
    expect(ebayGroundAdvantageService([svc("X1", "Ground Advantage Economy", { carrier: "UPS" })])).toBeNull();
  });

  test("international and not-valid-for-selling services never count", () => {
    expect(ebayGroundAdvantageService([svc("USPSGroundAdvantage", null, { international: true })])).toBeNull();
    expect(ebayGroundAdvantageService([svc("USPSParcel", "USPS Ground Advantage", { validForSelling: false })])).toBeNull();
  });

  test("several codes name it: a USPS-prefixed one is preferred, then eBay's name decides among them", () => {
    expect(ebayGroundAdvantageService([svc("EBAYGroundAdvantage", null), svc("USPSGroundAdvantage", null)])?.code).toBe("USPSGroundAdvantage");
    const two = [svc("USPSGroundAdvantageCubic", "USPS Ground Advantage Cubic"), svc("USPSGroundAdvantage", "USPS Ground Advantage")];
    expect(ebayGroundAdvantageService(two)?.code).toBe("USPSGroundAdvantage");
  });

  test("a tie is never given to the first candidate", () => {
    expect(ebayGroundAdvantageService([svc("A", "USPS Ground Advantage"), svc("B", "USPS Ground Advantage")])).toBeNull();
    expect(ebayGroundAdvantageService([svc("USPSGroundAdvantage1", null), svc("USPSGroundAdvantage2", null)])).toBeNull();
    expect(ebayGroundAdvantageService([svc("A", "USPS Ground Advantage Plus"), svc("B", "USPS Ground Advantage Cubic")])).toBeNull();
  });

  test("nothing that says Ground Advantage: null", () => {
    expect(ebayGroundAdvantageService([svc("USPSPriority", "USPS Priority Mail"), svc("USPSFirstClass", "USPS First Class Mail")])).toBeNull();
    expect(ebayGroundAdvantageService([])).toBeNull();
  });
});
