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
  AutographFormatPrompt,
  autographPromptLine,
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
    const [saved, setSaved] = useState<AutographFormat | undefined>(undefined);
    return (
      <AutographFormatPrompt
        selectorOptionId={LEAF}
        count={count}
        saved={saved}
        onSaved={setSaved}
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
