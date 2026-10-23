import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import ModeRadioGroup from "@/components/primitives/ModeRadioGroup";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { useTheme } from "@/src/theme/ThemeProvider";
import type { ThemePreference } from "@/src/theme/theme-mode";

/**
 * Settings — NEO-356. The collector's own app preferences; Appearance (the
 * theme) is the first.
 *
 * A pick applies at once and is then saved to the profile, so it follows the
 * collector to every device:
 *   1. `setPreference` applies it and writes the localStorage mirror;
 *   2. `setProfilePreference` moves the provider's profile slot with it, since
 *      that slot outranks localStorage and still holds the old saved value
 *      until the save round-trips (ProfileThemeSync re-pushes only when the
 *      saved value changes, so it agrees once the save lands);
 *   3. the mutation saves it.
 * If the save fails, both are put back and the collector is told.
 *
 * System follows the OS live: the provider listens to `prefers-color-scheme`,
 * and the readout below names the mode the device is giving us right now.
 *
 * No entry in profile-layout's useWarmProfileQueries: the panel reads the
 * provider, not a query of its own (ProfileThemeSync holds getUserProfile, and
 * the layout already keeps that one warm).
 */

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  { value: "light", label: "Light", description: "Bright as a brand-new Trapper Keeper" },
  { value: "dark", label: "Dark", description: "Lights down, neon up" },
  { value: "system", label: "System", description: "Matches your device, day or night" },
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

  const choose = async (next: ThemePreference) => {
    if (next === preference) return;
    const pick = ++latestPick.current;
    const previous = preference;
    setPreference(next);
    setProfilePreference(next);
    setSaveState("saving");
    try {
      await saveTheme({ theme: next });
      if (pick === latestPick.current) setSaveState("saved");
    } catch {
      if (pick !== latestPick.current) return;
      setPreference(previous);
      setProfilePreference(previous);
      setSaveState("failed");
    }
  };

  return (
    <section className="space-y-6 p-6 border border-rule rounded-lg">
      <div>
        <h2 className="text-xl font-semibold text-ink">
          Appearance
        </h2>
        <p className="text-sm text-ink-3 mt-1">
          Pick your glow. It follows you to every device you sign in on.
        </p>
      </div>

      <div className="space-y-3">
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

      {/* Always mounted (a live region must exist before it speaks), but an
          empty one takes no room: `empty:-mt-6` cancels the section's 24px
          gap, so the card ends at the last line of copy until there is
          something to say. */}
      <p
        role="status"
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
  );
}
