/**
 * Test helpers: press the Reconcile dialog's Save, and when the dialog asks
 * about the set's own sets still in Pending (NEO-339's "Leave N sets
 * unpaired?" step), leave them on purpose. For tests whose subject is not
 * that step; its own tests drive it directly.
 */
import { act, fireEvent, screen } from "@testing-library/react";

const leaveButton = () => screen.queryByRole("button", { name: /^Leave them, save/ });

/** Outside an `act` scope. */
export function pressSave(save: HTMLElement): void {
  fireEvent.click(save);
  const leave = leaveButton();
  if (leave) fireEvent.click(leave);
}

/** Where the test awaited the press in `act` (the save it starts is async). */
export async function pressSaveAsync(save: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(save);
  });
  const leave = leaveButton();
  if (leave) {
    await act(async () => {
      fireEvent.click(leave);
    });
  }
}
