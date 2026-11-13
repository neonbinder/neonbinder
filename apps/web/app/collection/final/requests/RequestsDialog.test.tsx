/**
 * NEO-361 — the real "Can't find it?" dialog: the card form says what is
 * missing instead of sending, sends what was asked with the checklist picked
 * or typed, and My requests puts a confirm that counts the copies in front of
 * withdraw. The server half is collectionRequests.test.ts; E2E proves it live.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeXhr } from "@/lib/testing/fake-xhr";
import { EMPTY_DRILL } from "../catalog/drill";

const calls = vi.hoisted(() => [] as { name: string; args: unknown }[]);
const answers = vi.hoisted(() => new Map<string, unknown>());

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : answers.get(getFunctionName(ref))),
    useMutation: (ref: never) => async (args: unknown) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const answer = answers.get(name);
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
});

const DRILL: Record<string, { id: string; name: string; hasChildren: boolean; variantId?: string }[]> = {
  sport: [{ id: "sp", name: "Football", hasChildren: true }],
  year: [{ id: "yr", name: "1996", hasChildren: true }],
  brand: [{ id: "br", name: "Playoff", hasChildren: true }],
  set: [{ id: "st", name: "Contenders", hasChildren: true }],
  variantType: [{ id: "base", name: "Base", hasChildren: false, variantId: "base" }],
};

vi.mock("../data/store", () => ({
  useDrill: (level: string | null) => (level ? DRILL[level] : undefined),
  useCard: () => undefined,
  writeErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));

import RequestsDialog from "./RequestsDialog";

function open(tab: "card" | "set" | "mine" = "card") {
  return render(
    <RequestsDialog
      searched="contenders white"
      drill={{ ...EMPTY_DRILL, sport: "sp", year: "yr", brand: "br", set: "st", type: "base" }}
      initialTab={tab}
      onHave={() => {}}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  answers.set("collectionRequests:mySets", []);
  answers.set("collectionRequests:requestCard", { requestId: "r1", privateCardId: "p1" });
});

describe("Request a card", () => {
  it("says what's missing rather than sending", async () => {
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    fireEvent.change(within(form).getByLabelText("Card number"), { target: { value: "41" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Add the player.");
    expect(calls).toEqual([]);
  });

  it("starts on the collector's checklist and sends it, with the search they ran", async () => {
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    expect((within(form).getByLabelText("Set") as HTMLSelectElement).value).toBe("st");
    expect((within(form).getByLabelText("Checklist") as HTMLSelectElement).value).toBe("base");
    fireEvent.change(within(form).getByLabelText("Card number"), { target: { value: "#41" } });
    fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "Reggie White" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() =>
      expect(within(form).getAllByRole("status").some((s) => s.textContent?.includes("Sent #41 Reggie White."))).toBe(true),
    );
    expect(calls).toEqual([
      {
        name: "collectionRequests:requestCard",
        args: { setId: "st", variantId: "base", searched: "contenders white", cardNumber: "#41", player: "Reggie White" },
      },
    ]);
  });

  it("sends a checklist the set doesn't list by its typed name", async () => {
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    fireEvent.change(within(form).getByLabelText("Checklist"), { target: { value: "__typed" } });
    fireEvent.change(within(form).getByLabelText("Which checklist?"), { target: { value: "Gold Foil" } });
    fireEvent.change(within(form).getByLabelText("Card number"), { target: { value: "41" } });
    fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "Reggie White" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args).toMatchObject({ setId: "st", variantName: "Gold Foil" });
    expect(calls[0].args).not.toHaveProperty("variantId");
  });
});

describe("Request a card's photos (NEO-431)", () => {
  const jpeg = (name = "card.jpg") => new File(["x"], name, { type: "image/jpeg" });
  const pick = (form: HTMLElement, side: "Front" | "Back", file: File) =>
    fireEvent.change(within(form).getByLabelText(`${side} photo file`), { target: { files: [file] } });
  const fill = (form: HTMLElement) => {
    fireEvent.change(within(form).getByLabelText("Card number"), { target: { value: "41" } });
    fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "Reggie White" } });
  };
  let n = 0;
  beforeEach(() => {
    n = 0;
    URL.createObjectURL = vi.fn(() => `blob:request-${++n}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("holds them, uploads nothing until Send, then sends both and clears the box", async () => {
    const xhrs = installFakeXhr((xhr) =>
      queueMicrotask(() => xhr.respond(200, JSON.stringify({ storageId: `st${xhrs.all.length}` }))),
    );
    answers.set("collectionRequests:generateUploadUrl", "https://upload.example/1");
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    const box = within(form).getByRole("region", { name: /^Photos of / });
    expect(box.textContent).toContain("Stashed here until you send the request.");
    expect(box.textContent).not.toContain("Saved as soon as");
    pick(form, "Front", jpeg());
    pick(form, "Back", jpeg());
    await within(box).findByRole("img", { name: /^Back of this card/ });
    expect(xhrs.all).toHaveLength(0);
    expect(calls).toEqual([]);

    fill(form);
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls.some((c) => c.name === "collectionRequests:requestCard")).toBe(true));
    expect(xhrs.all).toHaveLength(2);
    expect(calls.find((c) => c.name === "collectionRequests:requestCard")?.args).toMatchObject({
      frontImageId: "st1",
      backImageId: "st2",
    });
    await waitFor(() => expect(within(form).getByText("No front photo yet")).toBeTruthy());
    expect(within(form).getByText("No back photo yet")).toBeTruthy();
    expect(within(form).getByRole("region", { name: /^Photos of / }).querySelector('[role="status"]')?.textContent).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:request-1");
  });

  it("turns away what photoProblem turns away, in the form's own alert, and a good pick clears it", async () => {
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    pick(form, "Front", new File(["x"], "list.pdf", { type: "application/pdf" }));
    expect(within(form).getByRole("alert").textContent).toMatch(/isn't a photo/);
    expect(within(form).getByText("No front photo yet")).toBeTruthy();

    pick(form, "Front", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.jpg", { type: "image/jpeg" }));
    expect(within(form).getByRole("alert").textContent).toMatch(/over 10 MB/);

    pick(form, "Front", jpeg());
    expect(within(form).getByRole("alert").textContent).toBe("");
    await within(form).findByRole("img", { name: /^Front of this card/ });
  });

  it("while it sends, the box only mentions photos when there are some", async () => {
    let answer: (value: unknown) => void = () => {};
    answers.set("collectionRequests:requestCard", () => new Promise((resolve) => (answer = resolve)));
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    const box = within(form).getByRole("region", { name: /^Photos of / });
    fill(form);
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Sending…"));
    await act(async () => answer({ requestId: "r1", privateCardId: "p1" }));
    // A sent request starts the box over, so this is a new one.
    await waitFor(() => expect(within(within(form).getByRole("region", { name: /^Photos of / })).getByRole("status").textContent).toBe(""));
  });

  it("while it sends with a photo, the box says the photos are going", async () => {
    installFakeXhr((xhr) => queueMicrotask(() => xhr.respond(200, JSON.stringify({ storageId: "st1" }))));
    answers.set("collectionRequests:generateUploadUrl", "https://upload.example/1");
    let answer: (value: unknown) => void = () => {};
    answers.set("collectionRequests:requestCard", () => new Promise((resolve) => (answer = resolve)));
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    const box = within(form).getByRole("region", { name: /^Photos of / });
    pick(form, "Front", jpeg());
    await within(box).findByRole("img", { name: /^Front of this card/ });
    fill(form);
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Sending your photos…"));
    await act(async () => answer({ requestId: "r1", privateCardId: "p1" }));
  });

  it("offers its own accepted types", () => {
    open();
    const form = screen.getByRole("form", { name: "Request a card" });
    const input = within(form).getByLabelText("Front photo file") as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png,image/webp,image/heic,image/heif");
  });
});

describe("Request a set", () => {
  it("sends the set, then opens Request a card on it", async () => {
    answers.set("collectionRequests:requestSet", { requestId: "r2", privateSetId: "ps9" });
    answers.set("collectionRequests:mySets", [
      { _id: "ps9", requestId: "r2", status: "waiting", sport: null, year: "1986", brand: "Topps", name: "Traded" },
    ]);
    open("set");
    const form = screen.getByRole("form", { name: "Request a set" });
    fireEvent.change(within(form).getByLabelText("Year"), { target: { value: "1986" } });
    fireEvent.change(within(form).getByLabelText("Brand"), { target: { value: "Topps" } });
    fireEvent.change(within(form).getByLabelText("Set"), { target: { value: "Traded" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: "collectionRequests:requestSet",
      args: { sportId: "sp", year: "1986", brand: "Topps", name: "Traded", searched: "contenders white" },
    });
    fireEvent.click(await within(form).findByRole("button", { name: "Add a card from it" }));
    const tab = screen.getByRole("tab", { name: "Request a card" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(tab));
    const cardForm = screen.getByRole("form", { name: "Request a card" });
    expect((within(cardForm).getByLabelText("Set you asked for") as HTMLSelectElement).value).toBe("ps9");
  });

  it("takes the keyboard to the first field left empty", () => {
    open("set");
    const form = screen.getByRole("form", { name: "Request a set" });
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    const year = within(form).getByLabelText("Year");
    expect(document.activeElement).toBe(year);
    expect(year.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByRole("alert").textContent).toBe("Add the year.");
  });
});

describe("My requests", () => {
  const row = {
    _id: "r1",
    kind: "card",
    status: "declined",
    label: "1996 Contenders #41 Reggie White",
    decisionNote: "Couldn't confirm it.",
    requestedAt: 1,
    copies: 2,
    cards: 1,
  };

  it("shows the crew's note, and confirms a remove with how many copies go", async () => {
    answers.set("collectionRequests:mine", [row]);
    answers.set("collectionRequests:withdraw", { copies: 2, cards: 1 });
    open("mine");
    const item = screen.getByRole("listitem");
    within(item).getByText("Not added");
    within(item).getByText(/Couldn't confirm it\./);
    fireEvent.click(within(item).getByRole("button", { name: `Remove ${row.label}` }));
    const confirm = within(item).getByRole("group", { name: `Remove ${row.label}?` });
    expect(confirm.textContent).toContain("Remove this request? Your 2 copies of it go too. This can't be undone.");
    // Focus starts on the safe answer, and the warning describes the group.
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(document.getElementById(confirm.getAttribute("aria-describedby")!)?.textContent).toContain("can't be undone");
    // Escape keeps it, and the keyboard goes back to the ask.
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(within(item).queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(within(item).getByRole("button", { name: `Remove ${row.label}` }));
    expect(calls).toEqual([]);

    fireEvent.click(within(item).getByRole("button", { name: `Remove ${row.label}` }));
    fireEvent.click(within(item).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls).toEqual([{ name: "collectionRequests:withdraw", args: { requestId: "r1" } }]));
  });

  it("lists an added set's leftovers to file, and files the one picked", async () => {
    answers.set("collectionRequests:mine", [
      { ...row, kind: "set", status: "added", label: "1986 Topps Traded", decisionNote: undefined, privateSetId: "ps1", cards: 1, copies: 1 },
    ]);
    answers.set("collectionRequests:privateSetCards", [{ _id: "pc1", cardNumber: "20T", player: "Jose Canseco", variantName: "Base" }]);
    answers.set("collectionRequests:fileCandidates", [
      { _id: "k1", cardNumber: "20T", cardName: "Jose Canseco", variant: { name: "Base" } },
      { _id: "k2", cardNumber: "20T", cardName: "Jose Canseco", variant: { name: "Tiffany" } },
    ]);
    answers.set("collectionRequests:fileAs", { moved: 1 });
    open("mine");
    screen.getByText(/One of your cards from it didn't match/);
    fireEvent.change(screen.getByLabelText("Base #20T Jose Canseco is"), { target: { value: "k2" } });
    fireEvent.click(screen.getByRole("button", { name: "File it: Base #20T Jose Canseco" }));
    await waitFor(() =>
      expect(calls).toEqual([{ name: "collectionRequests:fileAs", args: { privateCardId: "pc1", cardId: "k2" } }]),
    );
    expect((await screen.findByText("Filed Base #20T Jose Canseco.")).getAttribute("role")).toBe("status");
  });

  it("offers no withdraw on an added request", () => {
    answers.set("collectionRequests:mine", [{ ...row, status: "added", decisionNote: undefined }]);
    open("mine");
    const item = screen.getByRole("listitem");
    within(item).getByText("Added");
    expect(within(item).queryByRole("button")).toBeNull();
  });
});

describe("My requests: sync reports (NEO-536)", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    _id: "sr1",
    status: "open",
    label: "2024 Topps Chrome Base",
    platform: "bsc",
    variantId: "v1",
    heldBack: 3,
    note: "Ohtani never lists.",
    reportedAt: 1,
    ...over,
  });

  it("lists every report with where it stands and the crew's note", () => {
    answers.set("collectionRequests:mine", []);
    answers.set("syncReports:mine", [
      report(),
      report({ _id: "sr2", status: "fixed", label: "1996 Contenders Base", closedAt: 2, closeNote: "Relinked it." }),
      report({ _id: "sr3", status: "notABug", label: "1990 Score Base", platform: "ebay", closedAt: 3, closeNote: "eBay wants the team." }),
    ]);
    open("mine");
    screen.getByText("No card or set requests yet.");
    const items = within(screen.getByRole("list", { name: "My sync reports" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    within(items[0]).getByText("Waiting on our crew");
    expect(items[0].textContent).toContain("BuySportsCards: 2024 Topps Chrome Base");
    expect(items[0].textContent).toContain("3 cards held back");
    within(items[0]).getByText("Your note: Ohtani never lists.");
    within(items[1]).getByText("Fixed");
    within(items[1]).getByText(/Relinked it\./);
    within(items[2]).getByText("Not a bug");
    expect(items[2].textContent).toContain("eBay: 1990 Score Base");
    within(items[2]).getByText(/eBay wants the team\./);
    // Only an open report can be withdrawn.
    expect(within(items[1]).queryByRole("button")).toBeNull();
    expect(within(items[2]).queryByRole("button")).toBeNull();
  });

  it("withdraws an open report in one press, and the keyboard lands on the section", async () => {
    answers.set("collectionRequests:mine", []);
    answers.set("syncReports:mine", [report()]);
    answers.set("syncReports:withdraw", null);
    open("mine");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw the report on 2024 Topps Chrome Base (BuySportsCards)" }));
    await waitFor(() => expect(calls).toEqual([{ name: "syncReports:withdraw", args: { id: "sr1" } }]));
    const done = await screen.findByText("Withdrew the report on 2024 Topps Chrome Base (BuySportsCards).");
    expect(done.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Sets you reported" }));
  });

  it("shows the server's refusal on a withdraw", async () => {
    answers.set("collectionRequests:mine", []);
    answers.set("syncReports:mine", [report()]);
    // This file's store stub reads an error's message (the real one reads a ConvexError's data first).
    answers.set("syncReports:withdraw", () => {
      throw new Error("The crew closed that report already.");
    });
    open("mine");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw the report on 2024 Topps Chrome Base (BuySportsCards)" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The crew closed that report already.");
  });

  it("keeps the old empty line when there is nothing at all", () => {
    answers.set("collectionRequests:mine", []);
    answers.set("syncReports:mine", []);
    open("mine");
    screen.getByText("Nothing asked for yet. Your requests show up here.");
    expect(screen.queryByRole("heading", { name: "Sets you reported" })).toBeNull();
  });
});
