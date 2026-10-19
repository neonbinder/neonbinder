/**
 * NEO-345 — the "Autographed cards" wizard step and the stored-leaf prompt.
 *
 * Every string is a placeholder for Jason's wording, so the tests read the
 * exported copy rather than restating it.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    autographFormat: { setAutographFormat: "autographFormat.setAutographFormat" },
  },
}));

const mockSetAutographFormat = vi.fn();
vi.mock("convex/react", () => ({
  useMutation: (ref: string) =>
    ref === "autographFormat.setAutographFormat" ? mockSetAutographFormat : vi.fn(),
}));

import AutographFormatStep, {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_NEXT_BLOCKED,
  AUTOGRAPH_PROMPT_SAVING,
  AutographFormatPrompt,
  autographPromptLine,
  autographPromptParallels,
  autographPromptSaved,
  autographStepQuestion,
} from "./AutographFormatStep";
import type { AutographFormat } from "./entity-review-steps";

const LEAF = "leaf-1" as unknown as Id<"selectorOptions">;

beforeEach(() => {
  vi.clearAllMocks();
  mockSetAutographFormat.mockResolvedValue(null);
});

/** The step with its value held the way the wizard holds it. */
function StepHost({
  initial,
  onEnter,
  disabled,
}: {
  initial?: AutographFormat;
  onEnter?: (value: AutographFormat) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<AutographFormat | undefined>(initial);
  return (
    <>
      <AutographFormatStep
        count={12}
        value={value}
        onChange={setValue}
        onEnter={onEnter}
        disabled={disabled}
        headingId="autograph-q"
      />
      <output data-testid="value">{value ?? ""}</output>
    </>
  );
}

const radio = (format: AutographFormat) =>
  screen.getByRole("radio", { name: AUTOGRAPH_CHOICE_LABEL[format] });
const value = () => screen.getByTestId("value").textContent;

describe("AutographFormatStep — the question", () => {
  it("labels the radio group with the question, which counts the cards", () => {
    render(<StepHost />);
    const group = screen.getByRole("radiogroup", { name: autographStepQuestion(12) });
    expect(group.getAttribute("aria-required")).toBe("true");
    expect(screen.getByRole("heading", { name: autographStepQuestion(12) }).id).toBe("autograph-q");
  });

  it("says one card in the singular", () => {
    expect(autographStepQuestion(1)).not.toBe(autographStepQuestion(2));
    expect(autographStepQuestion(2)).toContain("2");
  });

  it("offers exactly two choices, neither picked", () => {
    render(<StepHost />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });
});

describe("AutographFormatStep — keyboard", () => {
  it("is one Tab stop: the first choice while nothing is picked", () => {
    render(<StepHost />);
    expect(radio("On Card").tabIndex).toBe(0);
    expect(radio("Sticker/Label").tabIndex).toBe(-1);
  });

  it("the checked choice is the Tab stop once picked", () => {
    render(<StepHost initial="Sticker/Label" />);
    expect(radio("On Card").tabIndex).toBe(-1);
    expect(radio("Sticker/Label").tabIndex).toBe(0);
    expect(radio("Sticker/Label").getAttribute("aria-checked")).toBe("true");
  });

  it("arrow keys move focus WITH the selection, wrapping", () => {
    render(<StepHost />);
    act(() => radio("On Card").focus());
    fireEvent.keyDown(radio("On Card"), { key: "ArrowRight" });
    expect(value()).toBe("Sticker/Label");
    expect(document.activeElement).toBe(radio("Sticker/Label"));
    fireEvent.keyDown(radio("Sticker/Label"), { key: "ArrowDown" });
    expect(value()).toBe("On Card");
    expect(document.activeElement).toBe(radio("On Card"));
    fireEvent.keyDown(radio("On Card"), { key: "ArrowLeft" });
    expect(value()).toBe("Sticker/Label");
  });

  it("a click picks without moving on", () => {
    const onEnter = vi.fn();
    render(<StepHost onEnter={onEnter} />);
    fireEvent.click(radio("Sticker/Label"));
    expect(value()).toBe("Sticker/Label");
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("Enter picks AND moves on", () => {
    const onEnter = vi.fn();
    render(<StepHost onEnter={onEnter} />);
    fireEvent.keyDown(radio("Sticker/Label"), { key: "Enter" });
    expect(value()).toBe("Sticker/Label");
    expect(onEnter).toHaveBeenCalledWith("Sticker/Label");
  });

  it("an auto-repeated Enter does nothing, so a held key cannot run on into Save", () => {
    const onEnter = vi.fn();
    render(<StepHost onEnter={onEnter} />);
    fireEvent.keyDown(radio("On Card"), { key: "Enter", repeat: true });
    expect(value()).toBe("");
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("Enter never reaches the host", () => {
    const hostKeys = vi.fn();
    render(
      <div onKeyDown={(e) => hostKeys(e.key)}>
        <StepHost onEnter={vi.fn()} />
      </div>,
    );
    fireEvent.keyDown(radio("On Card"), { key: "Enter" });
    expect(hostKeys).not.toHaveBeenCalled();
  });

  it("does nothing while disabled (aria-disabled, still focusable)", () => {
    const onEnter = vi.fn();
    render(<StepHost onEnter={onEnter} disabled />);
    expect(radio("On Card").getAttribute("aria-disabled")).toBe("true");
    expect((radio("On Card") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(radio("On Card"));
    fireEvent.keyDown(radio("On Card"), { key: "Enter" });
    fireEvent.keyDown(radio("On Card"), { key: "ArrowRight" });
    expect(value()).toBe("");
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("hands the tab-stop choice to the host's ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <AutographFormatStep
        count={2}
        value={undefined}
        onChange={vi.fn()}
        headingId="q"
        choiceRef={ref}
      />,
    );
    expect(ref.current).toBe(radio("On Card"));
  });
});

describe("AutographFormatPrompt — a stored leaf", () => {
  function PromptHost({ count = 3 }: { count?: number }) {
    const [saved, setSaved] = useState<{ value: AutographFormat; parallels: number } | undefined>(undefined);
    return (
      <AutographFormatPrompt
        selectorOptionId={LEAF}
        count={count}
        saved={saved?.value}
        savedParallels={saved?.parallels}
        onSaved={(value, parallels) => setSaved({ value, parallels })}
      />
    );
  }

  it("says how many cards and offers the two answers as buttons", () => {
    render(<PromptHost count={3} />);
    expect(screen.getByText(autographPromptLine(3))).toBeTruthy();
    expect(screen.getByRole("group", { name: autographPromptLine(3) })).toBeTruthy();
    expect(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] })).toBeTruthy();
    expect(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["Sticker/Label"] })).toBeTruthy();
  });

  it("writes the leaf's format, then says so in place with focus on the line", async () => {
    render(<PromptHost />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["Sticker/Label"] }));
    });
    expect(mockSetAutographFormat).toHaveBeenCalledWith({
      selectorOptionId: LEAF,
      value: "Sticker/Label",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(autographPromptSaved("Sticker/Label"));
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] })).toBeNull();
  });

  it("names the parallels the answer also reached, and says nothing of none", async () => {
    mockSetAutographFormat.mockResolvedValueOnce({ parallelIds: ["p1"] });
    const { unmount } = render(<PromptHost />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] }));
    });
    expect((await screen.findByRole("status")).textContent).toBe(
      `${autographPromptSaved("On Card")} ${autographPromptParallels(1)}`,
    );
    expect(autographPromptParallels(1)).toBe("Its parallel takes the same answer.");
    expect(autographPromptParallels(4)).toBe("Its 4 parallels take the same answer.");
    unmount();

    mockSetAutographFormat.mockResolvedValueOnce({ parallelIds: [] });
    render(<PromptHost />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] }));
    });
    expect((await screen.findByRole("status")).textContent).toBe(autographPromptSaved("On Card"));
  });

  it("a refusal shows the server's sentence and keeps both answers", async () => {
    mockSetAutographFormat.mockRejectedValueOnce(new ConvexError("That leaf has no cards."));
    render(<PromptHost />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That leaf has no cards."));
    expect(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] })).toBeTruthy();
  });

  it("refuses a second press while the first is in flight", async () => {
    let resolve: () => void = () => {};
    mockSetAutographFormat.mockReturnValueOnce(new Promise<void>((r) => (resolve = r)));
    render(<PromptHost />);
    const onCard = screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] });
    const sticker = screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["Sticker/Label"] });
    await act(async () => {
      fireEvent.click(onCard);
    });
    expect(onCard.getAttribute("aria-busy")).toBe("true");
    expect(sticker.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(sticker);
    });
    expect(mockSetAutographFormat).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });
});

describe("AutographFormatStep — the blocked-Next line (a11y)", () => {
  const hint = () => document.getElementById("autograph-hint");
  const step = (props: { value?: AutographFormat; showBlockedHint?: boolean }) => (
    <AutographFormatStep
      count={2}
      value={props.value}
      onChange={vi.fn()}
      headingId="q"
      hintId="autograph-hint"
      showBlockedHint={props.showBlockedHint}
    />
  );

  it("is a status region mounted from the start, empty", () => {
    render(step({}));
    expect(hint()?.getAttribute("role")).toBe("status");
    expect(hint()?.textContent).toBe("");
  });

  it("says why once Next has been pressed with nothing picked", () => {
    const { rerender } = render(step({}));
    rerender(step({ showBlockedHint: true }));
    expect(hint()?.textContent).toBe(AUTOGRAPH_NEXT_BLOCKED);
  });

  it("is empty again once a choice is made", () => {
    render(step({ showBlockedHint: true, value: "On Card" }));
    expect(hint()?.textContent).toBe("");
  });
});

describe("AutographFormatPrompt — live regions and focus (a11y)", () => {
  function Host({ saved }: { saved?: AutographFormat }) {
    return (
      <AutographFormatPrompt selectorOptionId={LEAF} count={2} saved={saved} onSaved={vi.fn()} />
    );
  }

  it("the alert and the saving status are mounted before anything is pressed, empty", () => {
    render(<Host />);
    expect(screen.getByRole("alert").textContent).toBe("");
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0].textContent).toBe("");
  });

  it("says Saving… politely while the write is in flight", async () => {
    let resolve: () => void = () => {};
    mockSetAutographFormat.mockReturnValueOnce(new Promise<void>((r) => (resolve = r)));
    render(<Host />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] }));
    });
    expect(screen.getByRole("status").textContent).toBe(AUTOGRAPH_PROMPT_SAVING);
    await act(async () => resolve());
  });

  it("the buttons are described by the error while it shows, and only then", async () => {
    mockSetAutographFormat.mockRejectedValueOnce(new ConvexError("That leaf has no cards."));
    render(<Host />);
    const onCard = () => screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL["On Card"] });
    expect(onCard().getAttribute("aria-describedby")).toBeNull();
    await act(async () => {
      fireEvent.click(onCard());
    });
    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert.textContent).toBe("That leaf has no cards."));
    for (const format of ["On Card", "Sticker/Label"] as const) {
      const button = screen.getByRole("button", { name: AUTOGRAPH_CHOICE_LABEL[format] });
      expect(button.getAttribute("aria-describedby")).toBe(alert.id);
    }
  });

  it("the saved line takes focus when focus fell to the page", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    render(<Host saved="On Card" />);
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });

  it("the saved line never takes focus from a control the operator is on", () => {
    render(
      <>
        <button type="button">Somewhere else</button>
        <Host />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Somewhere else" });
    act(() => elsewhere.focus());
    // A remount of the saved line (another render of the host, a return to
    // the leaf) must leave focus where the operator put it.
    render(<Host saved="Sticker/Label" />);
    expect(document.activeElement).toBe(elsewhere);
  });
});
