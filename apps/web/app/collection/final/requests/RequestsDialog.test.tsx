/**
 * NEO-361 — the real "Can't find it?" dialog: the card form says what is
 * missing instead of sending, sends what was asked with the checklist picked
 * or typed, and My requests puts a confirm that counts the copies in front of
 * withdraw. The server half is collectionRequests.test.ts; E2E proves it live.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect((await within(form).findByRole("status")).textContent).toContain("Sent #41 Reggie White.");
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
