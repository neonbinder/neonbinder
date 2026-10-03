/**
 * NEO-312 — visible control labels that OTHER components' copy names.
 *
 * Operator copy that says "use Attach more…" goes stale silently the day the
 * button is renamed. So the label lives here once: the component that renders
 * the control and the copy that points at it both read it, and a rename moves
 * both.
 *
 * A module of its own, NOT an export from the components: several tests
 * `vi.mock("../SetSelector/MultiSourcePanel", () => ({ default: … }))`, and a
 * named import through a default-only mock throws. Pure strings, no imports.
 *
 * Changing a value here changes what the operator sees AND what Maestro
 * flows match by text (`Multi-source sets` is asserted by several). The
 * aria-labels beside these controls ("Add custom …", "Attach more source
 * sets") are separate and stay where they are.
 */

/** EntityColumn's idle-mode button that opens the custom-row form. */
export const CUSTOM_BUTTON_LABEL = "+ Custom";

/** MultiSourcePanel's heading. */
export const MULTI_SOURCE_HEADING = "Multi-source sets";

/** MultiSourcePanel's button that opens AttachSetsDialog. */
export const ATTACH_MORE_LABEL = "Attach more…";
