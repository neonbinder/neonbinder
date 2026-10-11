/**
 * Port of .maestro/flows/admin/util-add-player-by-hand.yaml — makes ONE player
 * through the Players admin screen, filed under SPORT. Caller is ON
 * /admin/players with the list loaded.
 */
import type { Maestro } from "../../maestro";
import { pickNativeOption } from "../native-select";

export interface AddPlayerByHandOptions {
  /** ONE search token, minted from the caller's ATTEMPT_TOKEN. */
  PLAYER_NAME: string;
  /** A sport row that exists on the deployment ("Football"). */
  SPORT: string;
}

export async function utilAddPlayerByHand(m: Maestro, o: AddPlayerByHandOptions): Promise<void> {
  const { PLAYER_NAME, SPORT } = o;

  await m.tapOn("Filter players");
  await m.inputText("zzzznotaplayer");
  await m.assertVisible("No players match that filter.");
  await m.assertVisible("0 matches");

  // Maestro: tapOn "All sports" then tapOn ${SPORT} (native select option tap).
  await pickNativeOption(m, SPORT);
  await m.assertVisible(SPORT);

  await m.waitVisible("0 matches", 7000);
  await m.scrollUntilVisible("Add player", { centerElement: true, timeout: 7000 });
  await m.tapOn("Add player");
  await m.waitVisible("Add a player", 7000);

  await m.tapOn("New player name");
  await m.inputText(PLAYER_NAME);

  await m.scrollUntilVisible(m.id(`Create player ${PLAYER_NAME}`), { centerElement: true, timeout: 7000 });
  await m.tapOn(m.id(`Create player ${PLAYER_NAME}`));

  await m.waitVisible(m.above(PLAYER_NAME, "Player name"), 7000);
  await m.assertVisible(`.*Added ${PLAYER_NAME}.*`);
  await m.assertVisible(`.*Sport: ${SPORT}.*`);
}
