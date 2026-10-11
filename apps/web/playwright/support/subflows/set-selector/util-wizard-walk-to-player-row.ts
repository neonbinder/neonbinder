/**
 * Port of .maestro/flows/set-selector/util-wizard-walk-to-player-row.yaml — walk the entity review wizard
 * to a settled player row (skipping team steps). The wizard presents every settled team row
 * before any player row, so the batch is waited out, drained, given the
 * career-team staging dwell, then drained again.
 */
import type { Maestro } from "../../maestro";

export async function utilWizardWalkToPlayerRow(m: Maestro, _o: Record<string, never> = {}): Promise<void> {
  const PLAYER_ROW = m.id("Skip .* not a person");
  const TEAM_STEP = m.id("Skip .*(not a team|has no league)");

  // 1. wait out the batch's lookups (live Wikidata round-trips).
  await m.waitNotVisible(".*still looking up.*", 180000);

  // 2. answer every team/league step until a player row is presented.
  // The tap is optional: the target vanishing between guard and tap IS the drain finishing.
  for (let i = 0; i < 200; i++) {
    if (!(await m.isNotVisible(PLAYER_ROW))) break;
    if (await m.isVisible(TEAM_STEP)) {
      await m.tapOn(TEAM_STEP, { optional: true });
    }
  }
  await m.waitVisible(PLAYER_ROW, 30000);

  // 3. deliberate dwell: the guard is false by construction (sanctioned R10 exception).
  if (await m.isNotVisible("Confirm New Players & Teams")) {
    await m.assertVisible("Confirm New Players & Teams");
  }

  // 4. drain whatever the staging inserted, and settle on the player.
  await m.waitNotVisible(".*still looking up.*", 180000);
  for (let i = 0; i < 200; i++) {
    if (!(await m.isNotVisible(PLAYER_ROW))) break;
    if (await m.isVisible(TEAM_STEP)) {
      await m.tapOn(TEAM_STEP, { optional: true });
    }
  }
  await m.waitVisible(PLAYER_ROW, 30000);
}
