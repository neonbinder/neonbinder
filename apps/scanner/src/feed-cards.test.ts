import { mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, feedCards, type ScanEvent, type Timing } from "./scanimage.js";

/**
 * feedCards against a fake scanimage on PATH (./testing/fake-scanimage.sh):
 * whole cards come out as pairs in order, a lone last side is an orphan, a
 * page that stops arriving is a stall, only a run of jams is reported, and
 * the staging folder is gone afterwards.
 */
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-scanimage.sh");
const FAST: Timing = { stallMs: 300, firstPageMs: 2000, settleMs: 0, idleMs: 20, pollMs: 10 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fake-sane-"));
  await mkdir(path.join(dir, "bin"));
  await symlink(FAKE, path.join(dir, "bin", "scanimage"));
  process.env.PATH = `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_DIR = dir;
  await writeFile(path.join(dir, "paper"), "");
});

async function feed(scenario: string, until: (events: ScanEvent[]) => boolean): Promise<ScanEvent[]> {
  process.env.FAKE_SCENARIO = scenario;
  const events: ScanEvent[] = [];
  let stop = () => {};
  const stopRequested = new Promise<void>((r) => (stop = r));
  await feedCards({
    device: "fujitsu:fake",
    settings: DEFAULT_SETTINGS,
    timing: FAST,
    shouldStop: () => until(events),
    stopRequested,
    onEvent: async (e) => {
      events.push(e);
      if (until(events)) stop();
    },
    onScanStart: () => {},
    log: () => {},
  });
  return events;
}

const stagingLeft = async () => (await readdir(tmpdir())).filter((f) => f.startsWith("nb-scan-"));

describe("feedCards", () => {
  test("hands over whole cards in order, front then back", async () => {
    const before = await stagingLeft();
    const events = await feed("pairs:4", (e) => e.length >= 2);
    expect(events).toEqual([
      { kind: "card", front: Buffer.from("side-1"), back: Buffer.from("side-2") },
      { kind: "card", front: Buffer.from("side-3"), back: Buffer.from("side-4") },
    ]);
    expect(await stagingLeft()).toEqual(before);
  });

  test("a card that gave up one side comes out on its own", async () => {
    const events = await feed("pairs:3", (e) => e.length >= 2);
    expect(events.map((e) => e.kind)).toEqual(["card", "one-side"]);
  });

  test("a page that stops arriving is a stall, after the cards before it", async () => {
    const events = await feed("stall", (e) => e.some((x) => x.kind === "stalled"));
    const stalled = events.find((e) => e.kind === "stalled");
    expect(stalled).toMatchObject({ kind: "stalled", kept: 0 });
    expect(events.map((e) => e.kind)).toEqual(["one-side", "stalled"]);
  });

  test("a jam is only reported after four in a row", async () => {
    const events = await feed("jam", (e) => e.length >= 1);
    expect(events).toEqual([{ kind: "jammed", times: 4 }]);
  });
});
