import type { ComponentType, ReactNode, Ref, SVGProps } from "react";
import { ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";

/**
 * NEO-306 — the one button every action on a set row wears.
 *
 * ## Why a component and not a class string
 *
 * Before this, five triggers ("Fill teams", "Move to another brand", "Make
 * parallel of…", "Promote to set", "Mark as base set") each copied one class
 * string — grey text with no boundary, which does not read as a control — and
 * each spelled out its own `aria-disabled`, `aria-busy`, `inert`, Enter
 * handling and focus ring. They had already drifted apart (green rings on
 * some, none on others). A component owns all of it, so no trigger can drift
 * again: the icon slot, the tone, the busy and disabled states, `inert`, the
 * Enter activation and the ring.
 *
 * ## Tones
 *
 * - `quiet` (default): an outlined chip — `slate-500` boundary (≈4:1 on the
 *   attributes panel's `gray-900/60`-over-black surface, past SC 1.4.11's
 *   3:1), `gray-200` text, neon green on hover. Every set-row action.
 * - `attention`: the house "needs a human" amber pill, the same classes as
 *   `CardAttentionBadge` and `EntityColumn`'s suggestions pill (7.36:1 text,
 *   4.90:1 border in dark mode per the badge's own measurement), with a
 *   leading exclamation icon. Amber, not green: green is "go", amber is "a
 *   person should look at this" everywhere in this codebase. Used where it
 *   answers a count the screen is already showing (the checklist's "Fill N
 *   missing teams"). It sits on the checklist card, which has a light-mode
 *   surface too, so its ring offset follows the theme.
 *
 * ## One focus ring
 *
 * 2px `#00B7FF` with a 2px offset on both tones — the codebase's most-used
 * arbitrary ring, and deliberately not the hover colour, so a chip that is
 * focused AND hovered is still legibly both.
 *
 * ## Name, state and activation
 *
 * The visible text IS the accessible name: there is no `aria-label` prop, so
 * SC 2.5.3 holds by construction and a flow's `text:` and `id:` finds agree.
 * The icon is `aria-hidden`.
 *
 * `disabled` and `busy` are `aria-disabled` (and `aria-busy`), never native
 * `disabled`: these are buttons the operator has just pressed, and disabling
 * the focused element blurs it to `<body>`. While either is set, activation
 * is swallowed here — callers never need a second guard for it.
 *
 * `onActivate` runs on click AND on Enter (`activateOnEnter`): maestro-web's
 * `pressKey: Enter` is a synthetic event with no default action, so a focused
 * button is never clicked by it unless the handler spells the activation out.
 */

type HeroIcon = ComponentType<
  SVGProps<SVGSVGElement> & { title?: string; titleId?: string }
>;

export type SetRowActionTone = "quiet" | "attention";

type CommonProps = {
  /** The visible text, which is also the accessible name. */
  children: ReactNode;
  onActivate: () => void;
  /** `aria-disabled`: focusable, announced, and does nothing when pressed. */
  disabled?: boolean;
  /** `aria-busy` + `aria-disabled`: the press is in flight. */
  busy?: boolean;
  /** Out of reach (focus AND a screen reader's virtual cursor) — e.g. while the dialog it opened is up. */
  inert?: boolean;
  id?: string;
  title?: string;
  ref?: Ref<HTMLButtonElement>;
  "aria-haspopup"?: "dialog" | "listbox" | "menu" | true;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "aria-describedby"?: string;
};

type Props = CommonProps &
  (
    | { tone?: "quiet"; icon: HeroIcon }
    // The attention pill always leads with the exclamation: the icon is part
    // of what the tone means, not a per-caller choice.
    | { tone: "attention"; icon?: never }
  );

const BASE =
  "shrink-0 inline-flex items-center gap-1.5 min-h-8 px-3 border text-xs whitespace-nowrap " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-2 " +
  "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";

export const SET_ROW_ACTION_TONE_CLASSES: Record<SetRowActionTone, string> = {
  quiet:
    "rounded-md border-slate-500 font-medium text-gray-200 " +
    "hover:border-[#00D558] hover:text-[#00D558] " +
    "aria-disabled:hover:border-slate-500 aria-disabled:hover:text-gray-200 " +
    // The attributes panel is dark in both themes.
    "focus-visible:ring-offset-gray-900",
  attention:
    "rounded-full border-amber-700 dark:border-amber-400/70 bg-amber-400/15 font-semibold " +
    "text-amber-800 dark:text-amber-300 hover:bg-amber-400/25 aria-disabled:hover:bg-amber-400/15 " +
    // The checklist card is `bg-white dark:bg-gray-800`, so the offset follows it.
    "focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800",
};

export default function SetRowActionButton(props: Props) {
  const {
    children,
    onActivate,
    disabled,
    busy,
    inert,
    id,
    title,
    ref,
    tone = "quiet",
  } = props;
  const Icon: HeroIcon =
    props.tone === "attention" ? ExclamationCircleIcon : props.icon;
  const blocked = Boolean(disabled || busy);

  const activate = () => {
    if (blocked) return;
    onActivate();
  };

  return (
    <button
      ref={ref}
      id={id}
      type="button"
      onClick={activate}
      onKeyDown={(event) => activateOnEnter(event, activate, blocked)}
      aria-disabled={blocked || undefined}
      aria-busy={busy || undefined}
      aria-haspopup={props["aria-haspopup"]}
      aria-expanded={props["aria-expanded"]}
      aria-controls={props["aria-controls"]}
      aria-describedby={props["aria-describedby"]}
      inert={inert || undefined}
      title={title}
      className={`${BASE} ${SET_ROW_ACTION_TONE_CLASSES[tone]}`}
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      {children}
    </button>
  );
}
