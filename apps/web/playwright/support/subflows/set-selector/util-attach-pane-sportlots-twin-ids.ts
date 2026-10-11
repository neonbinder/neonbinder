/**
 * Port of .maestro/flows/set-selector/util-attach-pane-sportlots-twin-ids.yaml
 * — open a saved insert row's Attach sets dialog and read which SportLots twin
 * it holds (NEO-325). READ-ONLY: Cancel writes nothing.
 */
import type { Maestro } from "../../maestro";
import { utilDrillTo2024ToppsChrome } from "./util-drill-to-2024-topps-chrome";

export interface AttachPaneTwinIdsOptions {
  /** The NB set under Baseball > 2024 > Topps. */
  SET: string;
  /** Plain text typed into `Search inserts`. */
  INSERT_QUERY: string;
  /** The row's full title as a REGEX (parentheses escaped). */
  INSERT_ROW: string;
  /** The twins' shared SportLots name. */
  TWIN: string;
  /** The SportLots id this row must hold. */
  ATTACHED_ID: string;
  /** The other twin's id, which must still be offered. */
  OTHER_ID: string;
}

export async function utilAttachPaneSportlotsTwinIds(m: Maestro, o: AttachPaneTwinIdsOptions): Promise<void> {
  await utilDrillTo2024ToppsChrome(m, { SET: o.SET });

  await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7000 });
  await m.tapOn("Insert");

  await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7000 });
  await m.tapOn(".*Search inserts.*"); // waitToSettleTimeoutMs: 250 dropped
  await m.inputText(o.INSERT_QUERY);
  await m.waitVisible(m.below(o.INSERT_ROW, m.id("Search inserts")), 7000);
  await m.tapOn(m.below(o.INSERT_ROW, m.id("Search inserts")));

  await m.scrollUntilVisible("Multi-source sets", { centerElement: true, timeout: 7000 });
  await m.tapOn(m.id("Attach more source sets"));
  await m.waitVisible(m.id("Search SportLots sets"), 7000);

  // Live SportLots round-trip started when the dialog opened: the flow's own 30000.
  await m.waitVisible(m.within(m.id("SportLots candidates"), "id: [0-9]+"), 30000);

  await m.tapOn(m.id("Search SportLots sets")); // waitToSettleTimeoutMs: 250 dropped
  await m.inputText(o.OTHER_ID);
  await m.waitVisible(m.within(m.id("SportLots candidates"), `id: ${o.OTHER_ID}`), 7000);
  await m.assertVisible(m.id(`Toggle ${o.TWIN}`));

  await m.eraseText(10);
  await m.inputText(o.ATTACHED_ID);
  // Curly quotes in the empty line, hence the dots.
  await m.waitVisible(m.within(m.id("SportLots candidates"), `No matches for .${o.ATTACHED_ID}.\\.`), 7000);
  await m.assertNotVisible(`id: ${o.ATTACHED_ID}`);

  await m.tapOn(m.id("Cancel attach sets"));
  await m.waitNotVisible(m.id("Search SportLots sets"), 7000);
}
