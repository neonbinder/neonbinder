/**
 * Port of .maestro/flows/util/util-paused-platforms.yaml.
 *
 * The flow turns PAUSED_PLATFORMS into `output.SL_PAUSED`. Here that boolean is
 * computed once per test and lives on the fixture: read `env.SL_PAUSED` (or
 * `m.env.SL_PAUSED`) wherever a flow branches on `${output.SL_PAUSED}`. This
 * function exists only so a port can keep the `runFlow` line visible.
 */
import type { Maestro } from "../../maestro";

export function utilPausedPlatforms(m: Maestro): boolean {
  return m.env.SL_PAUSED;
}
