import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { savedKey, saveKey } from "./config.js";
import { KeyRejectedError, NeonBinder } from "./neonbinder.js";
import { scanSignedIn, signIn, type SignInDeps } from "./sign-in.js";

/**
 * Which key the app signs in with and what becomes of it, with fetch stubbed,
 * the Convex client faked and a real key file in a temp folder.
 */
const convex = vi.hoisted(() => ({
  setAuth: vi.fn(),
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
  close: vi.fn(),
  onUpdate: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexClient: vi.fn(function () {
    return convex;
  }),
}));

const CONVEX_URL = "https://happy-otter-123.convex.cloud";
const CLIPBOARD = "Your clipboard still has that key. Go back to NeonBinder and copy the scanner code before you paste.";
const REFUSED = new KeyRejectedError().message;
const NO_KEY = "No API key, so nothing to do. Make one under Profile → API Keys and run this again.";

const fetchMock = vi.fn<typeof fetch>();
/** Only these keys are accepted by the fake key exchange. */
let goodKeys: Set<string>;
let keyFile: string;

beforeEach(async () => {
  keyFile = path.join(await mkdtemp(path.join(tmpdir(), "sign-in-")), "scanner.json");
  goodKeys = new Set(["ak_good", "ak_new"]);
  for (const f of Object.values(convex)) f.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const { key } = JSON.parse(String(init?.body)) as { key: string };
    return goodKeys.has(key) ? new Response(JSON.stringify({ token: "t", sessionId: "s" }), { status: 200 }) : new Response(null, { status: 401 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function rig(typed: Array<string | undefined> = [], over: Partial<SignInDeps> = {}) {
  const lines: string[] = [];
  const askKey = vi.fn<SignInDeps["askKey"]>(async () => typed.shift());
  const deps: SignInDeps = { convexUrl: CONVEX_URL, keyFile, log: (line) => lines.push(line), askKey, ...over };
  return { deps, lines, askKey };
}

describe("signIn", () => {
  test("a key typed in is saved, and only then the clipboard warning shows", async () => {
    const r = rig(["ak_good"]);
    const seenWhenWarned: Array<string | undefined> = [];
    const log = r.deps.log;
    r.deps.log = (line) => {
      log(line);
      if (line === CLIPBOARD) void savedKey(keyFile, CONVEX_URL).then((k) => seenWhenWarned.push(k));
    };
    await expect(signIn(r.deps)).resolves.toMatchObject({ keyIsSaved: true });
    await expect(savedKey(keyFile, CONVEX_URL)).resolves.toBe("ak_good");
    await vi.waitFor(() => expect(seenWhenWarned).toEqual(["ak_good"]));
    expect(r.lines.filter((l) => l === CLIPBOARD)).toHaveLength(1);
    expect(r.lines.at(-1)).toBe(CLIPBOARD);
  });

  test("the warning never carries the key", async () => {
    const r = rig(["ak_good"]);
    await signIn(r.deps);
    expect(r.lines.join("\n")).not.toContain("ak_good");
  });

  test("a saved key asks nothing and warns about nothing", async () => {
    await saveKey(keyFile, CONVEX_URL, "ak_good");
    const r = rig();
    await expect(signIn(r.deps)).resolves.toMatchObject({ keyIsSaved: true });
    expect(r.askKey).not.toHaveBeenCalled();
    expect(r.lines).not.toContain(CLIPBOARD);
  });

  test("a key from the environment isn't saved and warns about nothing", async () => {
    const r = rig([], { envKey: "ak_good" });
    await expect(signIn(r.deps)).resolves.toMatchObject({ keyIsSaved: false });
    await expect(savedKey(keyFile, CONVEX_URL)).resolves.toBeUndefined();
    expect(r.lines).not.toContain(CLIPBOARD);
  });

  test("a refused key typed in gets no warning; the one that works does", async () => {
    const r = rig(["ak_bad", "ak_good"]);
    await signIn(r.deps);
    expect(r.lines.filter((l) => l === REFUSED)).toHaveLength(1);
    expect(r.lines.indexOf(CLIPBOARD)).toBeGreaterThan(r.lines.indexOf(REFUSED));
    expect(r.lines.filter((l) => l === CLIPBOARD)).toHaveLength(1);
  });
});

describe("scanSignedIn: the key refused partway through", () => {
  test("a saved key is forgotten, the app asks again, and scanning carries on with the new key", async () => {
    await saveKey(keyFile, CONVEX_URL, "ak_good");
    const r = rig(["ak_new"]);
    const clients: NeonBinder[] = [];
    const scan = vi.fn(async (nb: NeonBinder, _first?: string) => {
      clients.push(nb);
      if (clients.length > 1) return 0;
      // What the asking sees is the old key already gone.
      goodKeys.delete("ak_good");
      throw new KeyRejectedError();
    });
    await expect(scanSignedIn(r.deps, scan, "ABC123")).resolves.toBe(0);
    expect(r.lines).toContain(REFUSED);
    expect(r.askKey).toHaveBeenCalledTimes(1);
    await expect(savedKey(keyFile, CONVEX_URL)).resolves.toBe("ak_new");
    expect(scan.mock.calls.map(([, first]) => first)).toEqual(["ABC123", undefined]);
    expect(convex.close).toHaveBeenCalledTimes(2);
    expect(r.lines.indexOf(CLIPBOARD)).toBeGreaterThan(r.lines.indexOf(REFUSED));
  });

  test("the saved key is gone before anyone is asked", async () => {
    await saveKey(keyFile, CONVEX_URL, "ak_good");
    const r = rig();
    let savedWhenAsked: string | undefined = "not asked";
    r.askKey.mockImplementation(async () => {
      savedWhenAsked = await savedKey(keyFile, CONVEX_URL);
      return undefined;
    });
    await expect(
      scanSignedIn(r.deps, async () => {
        throw new KeyRejectedError();
      }),
    ).resolves.toBe(1);
    expect(savedWhenAsked).toBeUndefined();
    expect(r.lines.slice(-1)).toEqual([NO_KEY]);
  });

  test("a key from the environment isn't ours to forget: the message, then exit, with no asking", async () => {
    await saveKey(keyFile, CONVEX_URL, "ak_other");
    const r = rig([], { envKey: "ak_good" });
    await expect(
      scanSignedIn(r.deps, async () => {
        throw new KeyRejectedError();
      }),
    ).resolves.toBe(1);
    expect(r.lines).toEqual([REFUSED]);
    expect(r.askKey).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(keyFile, "utf8")).keys[CONVEX_URL]).toBe("ak_other");
    expect(convex.close).toHaveBeenCalledTimes(1);
  });

  test("any other failure passes straight through and forgets nothing", async () => {
    await saveKey(keyFile, CONVEX_URL, "ak_good");
    const r = rig();
    await expect(
      scanSignedIn(r.deps, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(savedKey(keyFile, CONVEX_URL)).resolves.toBe("ak_good");
    expect(convex.close).toHaveBeenCalledTimes(1);
  });

  test("the scan's exit code is the app's", async () => {
    const r = rig(["ak_good"]);
    await expect(scanSignedIn(r.deps, async () => 7)).resolves.toBe(7);
  });

  test("no key at all says so", async () => {
    const r = rig([undefined]);
    const scan = vi.fn(async () => 0);
    await expect(scanSignedIn(r.deps, scan)).resolves.toBe(1);
    expect(scan).not.toHaveBeenCalled();
    expect(r.lines.at(-1)).toBe(NO_KEY);
  });
});
