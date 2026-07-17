/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adapters_base from "../adapters/base.js";
import type * as adapters_buysportscards from "../adapters/buysportscards.js";
import type * as adapters_ebay from "../adapters/ebay.js";
import type * as adapters_gcs from "../adapters/gcs.js";
import type * as adapters_index from "../adapters/index.js";
import type * as adapters_mycardpost from "../adapters/mycardpost.js";
import type * as adapters_myslabs from "../adapters/myslabs.js";
import type * as adapters_sportlots from "../adapters/sportlots.js";
import type * as adapters_testBscSetParameters from "../adapters/testBscSetParameters.js";
import type * as adapters_types from "../adapters/types.js";
import type * as adapters_wikidata from "../adapters/wikidata.js";
import type * as auth from "../auth.js";
import type * as backfillCardFeatures from "../backfillCardFeatures.js";
import type * as browserAudience from "../browserAudience.js";
import type * as cardChecklist from "../cardChecklist.js";
import type * as credentials from "../credentials.js";
import type * as e2eQueue from "../e2eQueue.js";
import type * as features_deriveCardFeatures from "../features/deriveCardFeatures.js";
import type * as features_expectedFeatures from "../features/expectedFeatures.js";
import type * as features_generateListing from "../features/generateListing.js";
import type * as http from "../http.js";
import type * as myFunctions from "../myFunctions.js";
import type * as observability from "../observability.js";
import type * as players from "../players.js";
import type * as posthog from "../posthog.js";
import type * as publicProfile from "../publicProfile.js";
import type * as resolveRedirect from "../resolveRedirect.js";
import type * as selectorOptions from "../selectorOptions.js";
import type * as setReconciliation from "../setReconciliation.js";
import type * as teams from "../teams.js";
import type * as testing from "../testing.js";
import type * as userProfile from "../userProfile.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/base": typeof adapters_base;
  "adapters/buysportscards": typeof adapters_buysportscards;
  "adapters/ebay": typeof adapters_ebay;
  "adapters/gcs": typeof adapters_gcs;
  "adapters/index": typeof adapters_index;
  "adapters/mycardpost": typeof adapters_mycardpost;
  "adapters/myslabs": typeof adapters_myslabs;
  "adapters/sportlots": typeof adapters_sportlots;
  "adapters/testBscSetParameters": typeof adapters_testBscSetParameters;
  "adapters/types": typeof adapters_types;
  "adapters/wikidata": typeof adapters_wikidata;
  auth: typeof auth;
  backfillCardFeatures: typeof backfillCardFeatures;
  browserAudience: typeof browserAudience;
  cardChecklist: typeof cardChecklist;
  credentials: typeof credentials;
  e2eQueue: typeof e2eQueue;
  "features/deriveCardFeatures": typeof features_deriveCardFeatures;
  "features/expectedFeatures": typeof features_expectedFeatures;
  "features/generateListing": typeof features_generateListing;
  http: typeof http;
  myFunctions: typeof myFunctions;
  observability: typeof observability;
  players: typeof players;
  posthog: typeof posthog;
  publicProfile: typeof publicProfile;
  resolveRedirect: typeof resolveRedirect;
  selectorOptions: typeof selectorOptions;
  setReconciliation: typeof setReconciliation;
  teams: typeof teams;
  testing: typeof testing;
  userProfile: typeof userProfile;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
