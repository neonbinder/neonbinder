import { type FunctionReference, anyApi } from "convex/server";
import { type GenericId as Id } from "convex/values";

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
  adapters: {
    testBscSetParameters: {
      testBscSetParameters: FunctionReference<
        "action",
        "public",
        {
          partialParams: {
            manufacturer?: string;
            setName?: string;
            sport?: string;
            variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
            year?: number;
          };
        },
        { message: string; result?: any; success: boolean }
      >;
    };
    buysportscards: {
      getAvailableSetParameters: FunctionReference<
        "action",
        "public",
        {
          partialParams?: {
            manufacturer?: string;
            setName?: string;
            sport?: string;
            variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
            year?: number;
          };
        },
        {
          availableOptions: {
            manufacturers?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            setNames?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            sports?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            variantNames?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            years?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
          };
          currentParams?: {
            manufacturer?: string;
            setName?: string;
            sport?: string;
            variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
            year?: number;
          };
        }
      >;
      getBscToken: FunctionReference<
        "action",
        "public",
        Record<string, never>,
        { error?: string; success: boolean; token?: string }
      >;
    };
    ebay: {
      searchEbay: FunctionReference<
        "action",
        "public",
        {
          appId: string;
          cardName: string;
          condition?: string;
          manufacturer?: string;
          maxPrice?: number;
          minPrice?: number;
          sport?: string;
          year?: number;
        },
        {
          listings: Array<{
            condition?: string;
            id: string;
            imageUrl?: string;
            platform: string;
            price: number;
            quantity?: number;
            seller?: string;
            shipping?: number;
            title: string;
            url: string;
          }>;
          platform: string;
          totalCount: number;
        }
      >;
      testCredentials: FunctionReference<
        "action",
        "public",
        Record<string, never>,
        { details?: string; message: string; success: boolean }
      >;
    };
    index: {
      getAvailableSetParameters: FunctionReference<
        "action",
        "public",
        {
          partialParams: {
            insertName?: string;
            manufacturer?: string;
            parallelName?: string;
            setName?: string;
            sport?: string;
            variantType?: "base" | "insert" | "parallel" | "parallel_of_insert";
            year?: number;
          };
        },
        {
          availableOptions: {
            manufacturers?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            setNames?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            sports?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            variantNames?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
            years?: Array<{
              site: string;
              values: Array<{ label: string; value: string }>;
            }>;
          };
          currentParams: {
            insertName?: string;
            manufacturer?: string;
            parallelName?: string;
            setName?: string;
            sport?: string;
            variantType?: "base" | "insert" | "parallel" | "parallel_of_insert";
            year?: number;
          };
        }
      >;
      searchAllCardPlatforms: FunctionReference<
        "action",
        "public",
        {
          cardName: string;
          condition?: string;
          ebayAppId?: string;
          manufacturer?: string;
          maxPrice?: number;
          minPrice?: number;
          platforms?: Array<"ebay" | "myslabs" | "mycardpost">;
          sport?: string;
          year?: number;
        },
        {
          results: Array<{
            listings: Array<{
              condition?: string;
              id: string;
              imageUrl?: string;
              platform: string;
              price: number;
              quantity?: number;
              seller?: string;
              shipping?: number;
              title: string;
              url: string;
            }>;
            platform: string;
            totalCount: number;
          }>;
          totalResults: number;
        }
      >;
    };
    mycardpost: {
      searchMyCardPost: FunctionReference<
        "action",
        "public",
        {
          cardName: string;
          condition?: string;
          manufacturer?: string;
          maxPrice?: number;
          minPrice?: number;
          sport?: string;
          year?: number;
        },
        {
          listings: Array<{
            condition?: string;
            id: string;
            imageUrl?: string;
            platform: string;
            price: number;
            quantity?: number;
            seller?: string;
            shipping?: number;
            title: string;
            url: string;
          }>;
          platform: string;
          totalCount: number;
        }
      >;
    };
    myslabs: {
      searchMySlabs: FunctionReference<
        "action",
        "public",
        {
          cardName: string;
          condition?: string;
          manufacturer?: string;
          maxPrice?: number;
          minPrice?: number;
          sport?: string;
          year?: number;
        },
        {
          listings: Array<{
            condition?: string;
            id: string;
            imageUrl?: string;
            platform: string;
            price: number;
            quantity?: number;
            seller?: string;
            shipping?: number;
            title: string;
            url: string;
          }>;
          platform: string;
          totalCount: number;
        }
      >;
    };
    secret_manager: {
      deleteSiteCredentials: FunctionReference<
        "action",
        "public",
        { site: string },
        { message: string; success: boolean }
      >;
      getSiteCredentials: FunctionReference<
        "action",
        "public",
        { site: string },
        {
          createdAt: string;
          expiresAt?: number;
          password: string;
          site: string;
          token?: string;
          userId: string;
          username: string;
        } | null
      >;
      listUserSites: FunctionReference<
        "action",
        "public",
        Record<string, never>,
        Array<{ hasCredentials: boolean; site: string }>
      >;
      storeSiteCredentials: FunctionReference<
        "action",
        "public",
        { password: string; site: string; username: string },
        { message: string; secretId?: string; success: boolean }
      >;
      testSiteCredentials: FunctionReference<
        "action",
        "public",
        { site: string },
        { details?: string; message: string; success: boolean }
      >;
    };
    sportlots: {
      testCredentials: FunctionReference<
        "action",
        "public",
        Record<string, never>,
        { details?: string; message: string; success: boolean }
      >;
    };
  };
  auth: {
    isAuthenticated: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      any
    >;
    signIn: FunctionReference<
      "action",
      "public",
      {
        calledBy?: string;
        params?: any;
        provider?: string;
        refreshToken?: string;
        verifier?: string;
      },
      any
    >;
    signOut: FunctionReference<"action", "public", Record<string, never>, any>;
  };
  myFunctions: {
    listNumbers: FunctionReference<"query", "public", { count: number }, any>;
    addNumber: FunctionReference<"mutation", "public", { value: number }, any>;
    myAction: FunctionReference<
      "action",
      "public",
      { first: number; second: string },
      null
    >;
    createSetSelection: FunctionReference<
      "mutation",
      "public",
      {
        description: string;
        insert?: Array<{ site: string; value: string }>;
        manufacturer?: Array<{ site: string; value: string }>;
        name: string;
        parallel?: Array<{ site: string; value: string }>;
        setName?: Array<{ site: string; value: string }>;
        sport?: Array<{ site: string; value: string }>;
        variantType?: Array<{ site: string; value: string }>;
        year?: Array<{ site: string; value: string }>;
      },
      Id<"setSelections">
    >;
    updateSetSelection: FunctionReference<
      "mutation",
      "public",
      {
        description?: string;
        id: Id<"setSelections">;
        insert?: Array<{ site: string; value: string }>;
        manufacturer?: Array<{ site: string; value: string }>;
        name?: string;
        parallel?: Array<{ site: string; value: string }>;
        setName?: Array<{ site: string; value: string }>;
        sport?: Array<{ site: string; value: string }>;
        variantType?: Array<{ site: string; value: string }>;
        year?: Array<{ site: string; value: string }>;
      },
      any
    >;
    getSetSelection: FunctionReference<
      "query",
      "public",
      { id: Id<"setSelections"> },
      null | {
        _creationTime: number;
        _id: Id<"setSelections">;
        createdAt: number;
        description: string;
        insert?: Array<{ site: string; value: string }>;
        manufacturer?: Array<{ site: string; value: string }>;
        name: string;
        parallel?: Array<{ site: string; value: string }>;
        setName?: Array<{ site: string; value: string }>;
        sport?: Array<{ site: string; value: string }>;
        updatedAt: number;
        variantType?: Array<{ site: string; value: string }>;
        year?: Array<{ site: string; value: string }>;
      }
    >;
    listSetSelections: FunctionReference<"query", "public", any, any>;
    getEntityById: FunctionReference<
      "query",
      "public",
      {
        id: any;
        table: "sports" | "years" | "manufacturers" | "sets" | "setVariants";
      },
      any
    >;
    updateSelectorOptions: FunctionReference<
      "action",
      "public",
      {
        level:
          | "sport"
          | "year"
          | "manufacturer"
          | "setName"
          | "variantType"
          | "insert"
          | "parallel";
        parentFilters?: {
          manufacturer?: string | Id<"manufacturers">;
          setName?: string | Id<"sets">;
          sport?: string | Id<"sports">;
          variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
          year?: number | Id<"years">;
        };
      },
      { message: string; optionsCount: number; success: boolean }
    >;
    storeSelectorOptions: FunctionReference<
      "mutation",
      "public",
      {
        level:
          | "sport"
          | "year"
          | "manufacturer"
          | "setName"
          | "variantType"
          | "insert"
          | "parallel";
        options: Array<{
          platformData: { bsc?: string | Array<string>; sportlots?: string };
          value: string;
        }>;
        parentFilters: {
          manufacturer?: string | Id<"manufacturers">;
          setName?: string | Id<"sets">;
          sport?: string | Id<"sports">;
          variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
          year?: number | Id<"years">;
        };
      },
      { message: string; optionsCount: number; success: boolean }
    >;
    getSelectorOptions: FunctionReference<
      "query",
      "public",
      {
        level:
          | "sport"
          | "year"
          | "manufacturer"
          | "setName"
          | "variantType"
          | "insert"
          | "parallel";
        parentId?: Id<"selectorOptions">;
      },
      Array<{
        _creationTime: number;
        _id: Id<"selectorOptions">;
        children?: Array<Id<"selectorOptions">>;
        lastUpdated: number;
        level:
          | "sport"
          | "year"
          | "manufacturer"
          | "setName"
          | "variantType"
          | "insert"
          | "parallel";
        parentId?: Id<"selectorOptions">;
        platformData: { bsc?: string | Array<string>; sportlots?: string };
        value: string;
      }>
    >;
    createCard: FunctionReference<
      "mutation",
      "public",
      {
        cardNumber: string;
        description?: string;
        imageUrl?: string;
        playerName?: string;
        position?: string;
        setVariantId: Id<"setVariants">;
        team?: string;
      },
      Id<"cards">
    >;
    getAggregatedSelectorOptions: FunctionReference<
      "action",
      "public",
      {
        level:
          | "sport"
          | "year"
          | "manufacturer"
          | "setName"
          | "variantType"
          | "insert"
          | "parallel";
        loginKey: string;
        parentFilters?: {
          manufacturer?: string;
          setName?: string;
          sport?: string;
          variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
          year?: number;
        };
      },
      {
        message: string;
        options: Array<{
          platformData: { bsc?: Array<string>; sportlots?: string };
          value: string;
        }>;
        optionsCount: number;
        success: boolean;
      }
    >;
  };
  userProfile: {
    getUserProfile: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      {
        preferences?: {
          defaultSport?: string;
          defaultYear?: number;
          theme?: "light" | "dark";
        };
        siteCredentials?: Array<{
          hasCredentials: boolean;
          lastUpdated?: string;
          site: string;
        }>;
        userId: Id<"users">;
      } | null
    >;
    updateUserProfile: FunctionReference<
      "mutation",
      "public",
      {
        preferences?: {
          defaultSport?: string;
          defaultYear?: number;
          theme?: "light" | "dark";
        };
        siteCredentials?: Array<{
          hasCredentials: boolean;
          lastUpdated?: string;
          site: string;
        }>;
      },
      boolean
    >;
    updateSiteCredentialStatus: FunctionReference<
      "mutation",
      "public",
      { hasCredentials: boolean; site: string },
      boolean
    >;
    removeSiteCredentialStatus: FunctionReference<
      "mutation",
      "public",
      { site: string },
      boolean
    >;
  };
};
export type InternalApiType = {};
