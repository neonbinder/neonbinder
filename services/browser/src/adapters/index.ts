export { BaseAdapter, LoginCredentials, AdapterResponse } from "./base-adapter";
export { BSCAdapter } from "./bsc-adapter";
export { SportlotsAdapter } from "./sportlots-adapter";

import { Page } from "puppeteer";
import { BSCAdapter } from "./bsc-adapter";
import { SportlotsAdapter } from "./sportlots-adapter";
import { BaseAdapter } from "./base-adapter";

export type SiteType = "bsc" | "sportlots";

export function createAdapter(siteType: SiteType, page: Page): BaseAdapter {
  switch (siteType) {
    case "bsc":
      return new BSCAdapter(page);
    case "sportlots":
      return new SportlotsAdapter(page);
    default:
      throw new Error(`Unknown site type: ${siteType}`);
  }
}

export const SUPPORTED_SITES: Record<SiteType, string> = {
  bsc: "BuySportsCards (BSC)",
  sportlots: "Sportlots",
};
