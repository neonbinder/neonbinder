# Sales Page Implementation Plan

## Overview
Build a public sales page at `/u/{username}/sale?amt=123` that accumulates sale amounts in localStorage and displays payment links to the seller's configured payment methods.

## Key Requirements
- **Route**: `/u/{username}/sale` with query parameter `amt`
- **Data Persistence**: localStorage with per-seller isolation (key: `sale_total_{username}`)
- **Amount Accumulation**: Add incoming amounts to existing total
- **Payment Links**: Pull from seller's existing public profile (PayPal, Venmo, Cash App)
- **Payment Link Structures**:
  - PayPal: `https://paypal.me/{username}/{amount}`
  - Venmo: `https://venmo.com/{username}?txn=pay&amount={amount}&note=Card+purchase`
  - Cash App: `https://cash.app/$cashtag/{amount}`

## Implementation Approach

### 1. Add Route to React Router (src/main.tsx)
- Insert new route `/u/:username/sale` element before the generic `/u/:username` route (React Router evaluates routes in order)
- Create `SalePage` component to handle this route

### 2. Create SalePage Component (app/u/[username]/sale/page.tsx)
The component will:
- Extract `username` from URL params
- Extract `amt` from query string
- Fetch seller's public profile using existing Convex query (`api.publicProfile.getPublicProfileByUsername`)
- Manage accumulated total in localStorage:
  - Read current total from `sale_total_{username}` or start at 0
  - Add new amount to total
  - Write back to localStorage
- Build payment links using seller's payment handles from profile:
  - Filter to only included payment methods (where username exists)
  - Append accumulated amount to each link
- Display:
  - Large prominent total amount
  - Payment option links with icons (using existing favicon pattern)
  - Handle edge cases (missing profile, no payment methods, invalid amount)

### 3. Styling
- Follow existing neon theme and component patterns
- Use Tailwind utilities + custom neon colors
- Ensure responsive design (mobile/desktop)
- Use existing Button/Link primitives from `components/primitives/`

### 4. Data Flow
1. User arrives at `/u/edvedafi/sale?amt=123`
2. Component fetches seller profile
3. Reads localStorage: `sale_total_edvedafi` = 0
4. Adds amount: 0 + 123 = 123
5. Writes back: `sale_total_edvedafi` = 123
6. User clicks another QR code: `/u/edvedafi/sale?amt=456`
7. Reads localStorage: `sale_total_edvedafi` = 123
8. Adds amount: 123 + 456 = 579
9. Writes back: `sale_total_edvedafi` = 579

## Files to Create/Modify
- **Create**: `app/u/[username]/sale/page.tsx` - New sales page component
- **Modify**: `src/main.tsx` - Add new route for `/u/:username/sale`

## Edge Cases to Handle
- Invalid or missing `amt` query parameter (treat as 0 or skip)
- Seller profile not found (show error message)
- Seller has no payment methods configured (show message)
- Invalid payment handles (filter them out)
- localStorage may be unavailable in some browsers (graceful degradation)
