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
import type * as adapters_espn from "../adapters/espn.js";
import type * as adapters_gcs from "../adapters/gcs.js";
import type * as adapters_index from "../adapters/index.js";
import type * as adapters_mycardpost from "../adapters/mycardpost.js";
import type * as adapters_myslabs from "../adapters/myslabs.js";
import type * as adapters_placeholderUploads from "../adapters/placeholderUploads.js";
import type * as adapters_preprocess from "../adapters/preprocess.js";
import type * as adapters_selectorBudgets from "../adapters/selectorBudgets.js";
import type * as adapters_sportlots from "../adapters/sportlots.js";
import type * as adapters_teamColorCodes from "../adapters/teamColorCodes.js";
import type * as adapters_testBscSetParameters from "../adapters/testBscSetParameters.js";
import type * as adapters_types from "../adapters/types.js";
import type * as adapters_wikidata from "../adapters/wikidata.js";
import type * as adminUsers from "../adminUsers.js";
import type * as auth from "../auth.js";
import type * as backfillCardFeatures from "../backfillCardFeatures.js";
import type * as browserAudience from "../browserAudience.js";
import type * as bscFacets from "../bscFacets.js";
import type * as cardChecklist from "../cardChecklist.js";
import type * as checklistCandidates from "../checklistCandidates.js";
import type * as credentials from "../credentials.js";
import type * as crons from "../crons.js";
import type * as e2eQueue from "../e2eQueue.js";
import type * as entityReviewQueue from "../entityReviewQueue.js";
import type * as entityReviewSkips from "../entityReviewSkips.js";
import type * as features_cardAttention from "../features/cardAttention.js";
import type * as features_deriveCardFeatures from "../features/deriveCardFeatures.js";
import type * as features_expectedFeatures from "../features/expectedFeatures.js";
import type * as features_generateListing from "../features/generateListing.js";
import type * as features_listingLimits from "../features/listingLimits.js";
import type * as http from "../http.js";
import type * as leagues from "../leagues.js";
import type * as lib_cloudRunAuth from "../lib/cloudRunAuth.js";
import type * as lib_easypostWebhookSignature from "../lib/easypostWebhookSignature.js";
import type * as lib_entityNearMatch from "../lib/entityNearMatch.js";
import type * as lib_pairing_dhash from "../lib/pairing/dhash.js";
import type * as lib_pairing_names from "../lib/pairing/names.js";
import type * as lib_pairing_pairBatch from "../lib/pairing/pairBatch.js";
import type * as lib_pairing_pool from "../lib/pairing/pool.js";
import type * as lib_pairing_types from "../lib/pairing/types.js";
import type * as lib_placeholderObjects from "../lib/placeholderObjects.js";
import type * as machineAuth from "../machineAuth.js";
import type * as observability from "../observability.js";
import type * as placeholderBatch from "../placeholderBatch.js";
import type * as placeholderHeavyPool from "../placeholderHeavyPool.js";
import type * as placeholderJobs from "../placeholderJobs.js";
import type * as placeholderPairing from "../placeholderPairing.js";
import type * as placeholderPipeline from "../placeholderPipeline.js";
import type * as placeholderPool from "../placeholderPool.js";
import type * as placeholderStream from "../placeholderStream.js";
import type * as placeholderWatchdog from "../placeholderWatchdog.js";
import type * as platformSlots from "../platformSlots.js";
import type * as players from "../players.js";
import type * as postage from "../postage.js";
import type * as posthog from "../posthog.js";
import type * as preprocessAudience from "../preprocessAudience.js";
import type * as preprocessCapacity from "../preprocessCapacity.js";
import type * as publicProfile from "../publicProfile.js";
import type * as seedTeamColors from "../seedTeamColors.js";
import type * as selectorOptions from "../selectorOptions.js";
import type * as setReconciliation from "../setReconciliation.js";
import type * as shipmentTracking from "../shipmentTracking.js";
import type * as shipping from "../shipping.js";
import type * as sku from "../sku.js";
import type * as sportConfig from "../sportConfig.js";
import type * as teamColorSources from "../teamColorSources.js";
import type * as teams from "../teams.js";
import type * as testing from "../testing.js";
import type * as userProfile from "../userProfile.js";
import type * as wikidataPool from "../wikidataPool.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/base": typeof adapters_base;
  "adapters/buysportscards": typeof adapters_buysportscards;
  "adapters/ebay": typeof adapters_ebay;
  "adapters/espn": typeof adapters_espn;
  "adapters/gcs": typeof adapters_gcs;
  "adapters/index": typeof adapters_index;
  "adapters/mycardpost": typeof adapters_mycardpost;
  "adapters/myslabs": typeof adapters_myslabs;
  "adapters/placeholderUploads": typeof adapters_placeholderUploads;
  "adapters/preprocess": typeof adapters_preprocess;
  "adapters/selectorBudgets": typeof adapters_selectorBudgets;
  "adapters/sportlots": typeof adapters_sportlots;
  "adapters/teamColorCodes": typeof adapters_teamColorCodes;
  "adapters/testBscSetParameters": typeof adapters_testBscSetParameters;
  "adapters/types": typeof adapters_types;
  "adapters/wikidata": typeof adapters_wikidata;
  adminUsers: typeof adminUsers;
  auth: typeof auth;
  backfillCardFeatures: typeof backfillCardFeatures;
  browserAudience: typeof browserAudience;
  bscFacets: typeof bscFacets;
  cardChecklist: typeof cardChecklist;
  checklistCandidates: typeof checklistCandidates;
  credentials: typeof credentials;
  crons: typeof crons;
  e2eQueue: typeof e2eQueue;
  entityReviewQueue: typeof entityReviewQueue;
  entityReviewSkips: typeof entityReviewSkips;
  "features/cardAttention": typeof features_cardAttention;
  "features/deriveCardFeatures": typeof features_deriveCardFeatures;
  "features/expectedFeatures": typeof features_expectedFeatures;
  "features/generateListing": typeof features_generateListing;
  "features/listingLimits": typeof features_listingLimits;
  http: typeof http;
  leagues: typeof leagues;
  "lib/cloudRunAuth": typeof lib_cloudRunAuth;
  "lib/easypostWebhookSignature": typeof lib_easypostWebhookSignature;
  "lib/entityNearMatch": typeof lib_entityNearMatch;
  "lib/pairing/dhash": typeof lib_pairing_dhash;
  "lib/pairing/names": typeof lib_pairing_names;
  "lib/pairing/pairBatch": typeof lib_pairing_pairBatch;
  "lib/pairing/pool": typeof lib_pairing_pool;
  "lib/pairing/types": typeof lib_pairing_types;
  "lib/placeholderObjects": typeof lib_placeholderObjects;
  machineAuth: typeof machineAuth;
  observability: typeof observability;
  placeholderBatch: typeof placeholderBatch;
  placeholderHeavyPool: typeof placeholderHeavyPool;
  placeholderJobs: typeof placeholderJobs;
  placeholderPairing: typeof placeholderPairing;
  placeholderPipeline: typeof placeholderPipeline;
  placeholderPool: typeof placeholderPool;
  placeholderStream: typeof placeholderStream;
  placeholderWatchdog: typeof placeholderWatchdog;
  platformSlots: typeof platformSlots;
  players: typeof players;
  postage: typeof postage;
  posthog: typeof posthog;
  preprocessAudience: typeof preprocessAudience;
  preprocessCapacity: typeof preprocessCapacity;
  publicProfile: typeof publicProfile;
  seedTeamColors: typeof seedTeamColors;
  selectorOptions: typeof selectorOptions;
  setReconciliation: typeof setReconciliation;
  shipmentTracking: typeof shipmentTracking;
  shipping: typeof shipping;
  sku: typeof sku;
  sportConfig: typeof sportConfig;
  teamColorSources: typeof teamColorSources;
  teams: typeof teams;
  testing: typeof testing;
  userProfile: typeof userProfile;
  wikidataPool: typeof wikidataPool;
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

export declare const components: {
  fastPreprocessPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"fastPreprocessPool">;
  heavyPreprocessPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"heavyPreprocessPool">;
  wikidataPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"wikidataPool">;
};
