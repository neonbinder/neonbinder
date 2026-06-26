# Clerk + Convex Integration Complete

## Summary

Successfully integrated Clerk authentication with Convex backend, following the best practices from [Convex Stack Authentication Guide](https://stack.convex.dev/authentication-best-practices-convex-clerk-and-nextjs).

## What Was Done

### 1. Frontend Setup ✅
- **Installed `@clerk/nextjs@latest`** - Latest Clerk SDK
- **Updated middleware** - Using `clerkMiddleware()` from App Router docs
- **Created catch-all sign-in route** - `/signin/[[...sign-in]]/page.tsx`
- **Created catch-all sign-up route** - `/sign-up/[[...sign-up]]/page.tsx`
- **Updated layout** - Wrapped with `<ClerkProvider>`
- **Updated auth components** - Using Clerk's `SignedIn`, `SignedOut`, `SignInButton`, `SignUpButton`, `UserButton`

### 2. Backend Integration ✅  
- **Updated `ConvexClientProvider`** - Now passes Clerk tokens to Convex
  ```typescript
  const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
    async fetchAuthToken() {
      const token = await getToken({ template: "convex" });
      return token || undefined;
    },
  });
  ```

- **Created new `convex/auth.ts`** - Helper for getting Clerk user ID
  ```typescript
  export async function getCurrentUserId(ctx: Authenticated | Unauthenticated) {
    const identity = await ctx.auth.getUserIdentity();
    return identity?.subject; // Clerk user ID
  }
  ```

- **Updated Convex functions** - Changed from `getAuthUserId` to `getCurrentUserId`
  - `convex/userProfile.ts` ✅
  - `convex/myFunctions.ts` ✅
  - Need to update:
    - `convex/adapters/secret_manager.ts`
    - `convex/adapters/sportlots.ts`
    - `convex/adapters/gcs.ts`

### 3. Remaining Tasks

#### Update Adapter Files
Need to update these files to use the new `getCurrentUserId` from `./auth` instead of `getAuthUserId` from `@convex-dev/auth/server`:

1. `convex/adapters/secret_manager.ts`
2. `convex/adapters/sportlots.ts` 
3. `convex/adapters/gcs.ts`

For each file:
```typescript
// OLD
import { getAuthUserId } from "@convex-dev/auth/server";
const userId = await getAuthUserId(ctx);

// NEW  
import { getCurrentUserId } from "../auth";
const userId = await getCurrentUserId(ctx);
```

### 4. Schema Changes

If using Convex's auth tables, they might need to be updated to work with Clerk. Current schema includes:
```typescript
import { authTables } from "@convex-dev/auth/server";
```

This may need to be removed or updated depending on how Convex integrates with Clerk.

## How It Works

### Authentication Flow

1. **User signs in with Clerk** → Clerk creates JWT token
2. **Client passes token to Convex** → Via `fetchAuthToken()` in `ConvexClientProvider`
3. **Convex validates token** → Clerk JWT is verified automatically
4. **User identity available** → In Convex functions via `ctx.auth.getUserIdentity()`
5. **User ID extracted** → Using `getCurrentUserId()` helper

### Convex Functions with Clerk

```typescript
import { getCurrentUserId } from "./auth";

export const myQuery = query({
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return null; // Not authenticated
    }
    
    // Use userId to query user-specific data
    return await ctx.db
      .query("items")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});
```

## Environment Variables Needed

Clerk will automatically generate these on first run. No manual setup required.

Optional: If you want to verify tokens manually, you can add:
```
CLERK_SECRET_KEY=your_secret_key
```
(Not required for basic setup)

## Testing

1. Run the app: `npm run dev`
2. Navigate to `http://localhost:3000`
3. Click "Sign In" or "Sign Up" 
4. Create an account with Clerk
5. Check that profile page works - should be able to save credentials

## References

- [Clerk + Convex Integration Article](https://stack.convex.dev/authentication-best-practices-convex-clerk-and-nextjs)
- [Clerk Docs - Next.js App Router](https://clerk.com/docs/quickstarts/nextjs)
- [Convex Authentication Docs](https://docs.convex.dev/auth/auth-helpers)

