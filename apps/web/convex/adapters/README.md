# Platform Adapters

This directory contains adapters for different sports card platforms. The adapters are organized into two categories:

## ListBySet Platforms
These platforms primarily deal with complete sets (currently being refactored for available sets identification):
- **BuySportsCards** (`buysportscards.ts`) - Authentication and login functionality available
- **Sportlots** (`sportlots.ts`) - Authentication and login functionality available

## ListByCard Platforms  
These platforms primarily deal with individual cards:
- **eBay** (`ebay.ts`)
- **MySlabs** (`myslabs.ts`)
- **MyCardPost** (`mycardpost.ts`)

## Architecture

### Base Classes and Interfaces
- `base.ts` - Contains base adapter class and CardAdapter interface (SetAdapter removed for refactoring)
- `types.ts` - Contains common type definitions and validators

### Individual Platform Adapters
Each platform has its own adapter file that implements either `CardAdapter` or `SetAdapter` interface.

### Unified Search Functions
- `index.ts` - Contains unified search functions that can search across multiple platforms

## Usage

### Individual Platform Searches

#### Search for Sets (Currently Disabled)
```typescript
// Note: Set search functionality has been removed as we're focusing on available sets identification
// This functionality will be replaced with new available sets identification features
```

#### Search for Cards (eBay, MySlabs, MyCardPost)
```typescript
// Search eBay (requires App ID)
const ebayResults = await convex.runAction(
  api.adapters.ebay.searchEbay,
  {
    cardName: "Mike Trout",
    year: 2023,
    sport: "baseball",
    manufacturer: "Topps",
    condition: "mint",
    maxPrice: 50,
    appId: "your-ebay-app-id",
  }
);

// Search MySlabs
const mySlabsResults = await convex.runAction(
  api.adapters.myslabs.searchMySlabs,
  {
    cardName: "LeBron James",
    year: 2022,
    sport: "basketball",
    manufacturer: "Panini",
    condition: "gem mint",
  }
);

// Search MyCardPost
const myCardPostResults = await convex.runAction(
  api.adapters.mycardpost.searchMyCardPost,
  {
    cardName: "Tom Brady",
    year: 2021,
    sport: "football",
    manufacturer: "Panini",
  }
);
```

### Unified Multi-Platform Searches

#### Search All Card Platforms
```typescript
const allCardResults = await convex.runAction(
  api.adapters.index.searchAllCardPlatforms,
  {
    cardName: "Aaron Judge",
    year: 2023,
    sport: "baseball",
    manufacturer: "Topps",
    condition: "mint",
    maxPrice: 100,
    platforms: ["ebay", "myslabs", "mycardpost"], // Optional: specify platforms
    ebayAppId: "your-ebay-app-id", // Required for eBay searches
  }
);
```

#### Search All Set Platforms (Currently Disabled)
```typescript
// Note: Set search functionality has been removed as we're focusing on available sets identification
// This functionality will be replaced with new available sets identification features
```

## Response Format

### Card Listing Response
```typescript
{
  listings: [
    {
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
  ];
  totalCount: number;
  platform: string;
}
```

### Set Listing Response
```typescript
{
  listings: [
    {
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
  ];
  totalCount: number;
  platform: string;
}
```

### Multi-Platform Response
```typescript
{
  results: [
    {
      platform: string;
      listings: CardListing[] | SetListing[];
      totalCount: number;
    }
  ];
  totalResults: number;
}
```

## Configuration

### eBay Configuration
eBay requires an App ID for API access. You'll need to:
1. Register as an eBay developer
2. Create an application
3. Get your App ID
4. Pass the App ID when calling eBay searches

### Error Handling
All adapters include error handling and will return empty results if a platform is unavailable or returns an error. Check the console logs for detailed error information.

## Adding New Platforms

To add a new platform:

1. Create a new adapter file (e.g., `newplatform.ts`)
2. Implement the `CardAdapter` interface (SetAdapter removed for refactoring)
3. Extend the `BaseAdapter` class for common HTTP functionality
4. Add the platform to the appropriate unified search function in `index.ts`
5. Update this README with usage examples

## Notes

- All adapters use Convex actions since they need to make HTTP requests
- The base adapter provides common HTTP functionality and error handling
- Each platform may have different API structures, so adapters normalize the responses
- Some platforms may require authentication (like eBay)
- Rate limiting and API quotas should be considered for production use 