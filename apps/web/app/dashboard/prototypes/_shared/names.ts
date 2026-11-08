/**
 * NEO-464 — the five dashboard prototypes: their numbers, names and paths.
 * Public, logged out, at `/dashboard-demo/1` … `/dashboard-demo/5`.
 */

export type DashboardNumber = 1 | 2 | 3 | 4 | 5;

export interface DashboardPrototype {
  n: DashboardNumber;
  /** The switcher's label and the page title. */
  name: string;
  /** One line on who it is for, for the prototype's own intro if it wants one. */
  idea: string;
  path: string;
}

export const DASHBOARD_BASE_PATH = "/dashboard-demo";

export const DASHBOARDS: readonly DashboardPrototype[] = [
  { n: 1, name: "To-do first", idea: "Ship list, then problems, then everything else. A dealer's morning.", path: `${DASHBOARD_BASE_PATH}/1` },
  { n: 2, name: "Scoreboard wall", idea: "Set boards up front, ranked by cards needed. For set builders.", path: `${DASHBOARD_BASE_PATH}/2` },
  { n: 3, name: "Feed", idea: "One timeline of sales, pulls and milestones. What changed since you left.", path: `${DASHBOARD_BASE_PATH}/3` },
  { n: 4, name: "Binder shelf", idea: "Binder spines and smart binders first. For player and team collectors.", path: `${DASHBOARD_BASE_PATH}/4` },
  { n: 5, name: "Split desk", idea: "Collection on the left, boxes and sales on the right. Both hats on.", path: `${DASHBOARD_BASE_PATH}/5` },
];

/** The `:n` route param as a prototype number, or null when it names none. */
export function parseDashboardNumber(value: string | undefined): DashboardNumber | null {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 ? n : null;
}

export function dashboardPrototype(n: DashboardNumber): DashboardPrototype {
  return DASHBOARDS[n - 1];
}
