/**
 * Port of .maestro/flows/set-selector/util-drill-to-custom-set.yaml — thin
 * wrapper over util-drill-to-custom with the per-worker synthetic
 * Sport/Year/Manufacturer.
 */
import type { Maestro } from "../../maestro";
import { utilDrillToCustom } from "./util-drill-to-custom";

export interface DrillToCustomSetOptions {
  /** Per-flow unique set basename, e.g. "pg-move-0". */
  SET_NAME: string;
  /** Variant type to land on; default "Insert". */
  VARIANT_TYPE?: string;
}

export async function utilDrillToCustomSet(m: Maestro, o: DrillToCustomSetOptions): Promise<void> {
  await utilDrillToCustom(m, {
    SPORT: `E2E Test Sport ${m.env.WORKER_INDEX || 0}`,
    YEAR: "2026",
    MANUFACTURER: "Topps",
    SET_NAME: o.SET_NAME,
    VARIANT_TYPE: o.VARIANT_TYPE || "Insert",
  });
}
