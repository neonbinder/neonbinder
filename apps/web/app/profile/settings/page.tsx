import { useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import ModeRadioGroup from "@/components/primitives/ModeRadioGroup";
import DefaultConditionSection from "./DefaultConditionSection";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { useTheme } from "@/src/theme/ThemeProvider";
import type { ThemePreference } from "@/src/theme/theme-mode";

/**
 * Settings — NEO-356. The collector's own app preferences; Appearance (the
 * theme) is the first, then Collection (the default card condition, NEO-380,
 * `DefaultConditionSection`).
 *
 * A pick applies at once and is then saved to the profile, so it follows the
 * collector to every device:
 *   1. `setPreference` applies it and writes the localStorage mirror;
 *   2. `setProfilePreference` moves the provider's profile slot with it, since
 *      that slot outranks localStorage and still holds the old saved value
 *      until the save round-trips (ProfileThemeSync re-pushes only when the
 *      saved value changes, so it agrees once the save lands);
 *   3. the mutation saves it.
 * If the save fails, both go back to the last value a save CONFIRMED (not
 * merely the one before this pick, which may itself never have saved), focus
 * moves to that restored option, and an alert says so.
 *
 * System follows the OS live: the provider listens to `prefers-color-scheme`,
 * and the readout below names the mode the device is giving us right now.
 *
 * Appearance needs no entry in profile-layout's useWarmProfileQueries: it reads the
 * provider, not a query of its own (ProfileThemeSync holds getThemePreference
 * on every signed-in page, so it is always warm).
 */

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  {
    value: "light",
    label: "Light",
    description: "Bright as a brand-new Trapper Keeper",
  },
  { value: "dark", label: "Dark", description: "Lights down, neon up" },
  {
    value: "system",
    label: "System",
    description: "Matches your device, day or night",
  },
];

type SaveState = "idle" | "saving" | "saved" | "failed";

export default function SettingsPanel() {
  useDocumentTitle("Settings | Neon Binder");
  const { preference, setPreference, setProfilePreference, mode } = useTheme();
  const saveTheme = useMutation(api.userProfile.setThemePreference);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Arrow keys move the pick one option at a time, so saves overlap. Only the
  // latest pick may report or roll back; an older save settling late must not
  // undo a newer choice.
  const latestPick = useRef(0);
  // The value the profile is known to hold: the preference as it stood when
  // no save was in flight, then each confirmed save (newest pick wins, in
  // case two settle out of order). A rollback goes here, never to a pick
  // that was only ever optimistic.
  const confirmed = useRef<{ pick: number; value: ThemePreference }>({
    pick: 0,
    value: preference,
  });
  const inFlight = useRef(0);
  // Where focus goes after a rollback: the restored option, once it renders.
  const groupRef = useRef<HTMLDivElement>(null);
  const [rollbacks, setRollbacks] = useState(0);

  useLayoutEffect(() => {
    if (rollbacks === 0) return;
    const group = groupRef.current;
    // Only when focus is still in the group (the collector is arrowing or
    // just clicked); never pull it back from somewhere they have moved on to.
    if (!group || !group.contains(document.activeElement)) return;
    group
      .querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
      ?.focus();
  }, [rollbacks]);

  const choose = async (next: ThemePreference) => {
    if (next === preference) return;
    const pick = ++latestPick.current;
    if (inFlight.current === 0)
      confirmed.current = { pick: 0, value: preference };
    inFlight.current += 1;
    setPreference(next);
    setProfilePreference(next);
    setSaveState("saving");
    try {
      await saveTheme({ theme: next });
      if (pick > confirmed.current.pick)
        confirmed.current = { pick, value: next };
      if (pick === latestPick.current) setSaveState("saved");
    } catch {
      if (pick !== latestPick.current) return;
      const restored = confirmed.current.value;
      setPreference(restored);
      setProfilePreference(restored);
      setSaveState("failed");
      setRollbacks((n) => n + 1);
    } finally {
      inFlight.current -= 1;
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-6 p-6 border border-rule rounded-lg">
        <div>
          <h2 className="text-xl font-semibold text-ink">Appearance</h2>
          <p className="text-sm text-ink-3 mt-1">
            Pick your glow. It follows you to every device you sign in on.
          </p>
        </div>

        <div ref={groupRef} className="space-y-3">
          <ModeRadioGroup
            label="Theme"
            value={preference}
            options={THEME_OPTIONS}
            onChange={(next) => void choose(next)}
          />
          {preference === "system" && (
            <p className="text-sm text-ink-3">
              Your device is on {mode} right now.
            </p>
          )}
        </div>

        {/* A live region keyed on the outcome. Progress ("Saving…", "Saved.")
          is a polite status, always mounted so it exists before it speaks. A
          failure remounts it as an alert, which announces on insertion
          (an alert's text must not wait for a region that already exists).
          An empty one takes no room: `empty:-mt-6` cancels the section's
          24px gap, so the card ends at the last line of copy until there is
          something to say. */}
        <p
          key={saveState === "failed" ? "failed" : "ok"}
          role={saveState === "failed" ? "alert" : "status"}
          aria-live={saveState === "failed" ? undefined : "polite"}
          className={
            "text-sm empty:-mt-6 " +
            (saveState === "failed" ? "text-neon-pink-text" : "text-ink-3")
          }
        >
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved."}
          {saveState === "failed" &&
            "That didn't save, so your old theme is back. Give it another try."}
        </p>
      </section>
      <DefaultConditionSection />
    </div>
  );
}
