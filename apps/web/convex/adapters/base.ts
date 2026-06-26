"use node";

// Type definitions for the adapters
export interface CardSearchParams {
  cardName: string;
  year?: number;
  sport?: string;
  manufacturer?: string;
  condition?: string;
  maxPrice?: number;
  minPrice?: number;
}

export interface SetSearchParams {
  setName: string;
  year?: number;
  sport?: string;
  manufacturer?: string;
  maxPrice?: number;
  minPrice?: number;
}

export interface CardListing {
  id: string;
  title: string;
  price: number;
  condition?: string;
  quantity?: number;
  imageUrl?: string;
  platform: string;
  url: string;
  seller?: string;
  shipping?: number;
}

export interface SetListing {
  id: string;
  setName: string;
  year: number;
  sport: string;
  manufacturer: string;
  totalCards?: number;
  price: number;
  condition?: string;
  platform: string;
  url: string;
  seller?: string;
}

export interface CardListingsResponse {
  listings: CardListing[];
  totalCount: number;
  platform: string;
}

export interface SetListingsResponse {
  listings: SetListing[];
  totalCount: number;
  platform: string;
}

// Base adapter interface for ListByCard platforms
export interface CardAdapter {
  searchCards(params: CardSearchParams): Promise<CardListingsResponse>;
}

// Base adapter interface for ListBySet platforms  
// Note: searchSets functionality has been removed as we're focusing on available sets identification

// Base class with common HTTP functionality
export abstract class BaseAdapter {
  protected async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const defaultOptions: RequestInit = {
      headers: {
        'User-Agent': 'NeonBinder/1.0',
        'Accept': 'application/json',
        ...options.headers,
      },
      ...options,
    };

    return await fetch(url, defaultOptions);
  }

  protected async parseJsonResponse(response: Response): Promise<unknown> {
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  }

  protected buildQueryString(params: Record<string, unknown>): string {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    return searchParams.toString();
  }
}

export type VariantType = "base" | "insert" | "parallel" | "parallel_of_insert";

export interface SetParameters {
  sport: string;
  year: number;
  manufacturer: string;
  setName: string;
  variantType: VariantType;
  insertName?: string;    // required for insert, parallel_of_insert
  parallelName?: string;  // required for parallel, parallel_of_insert
}

export interface SetAdapter {
  buildSetParameters(partial: Partial<SetParameters>): Promise<Partial<SetParameters>>;
} 