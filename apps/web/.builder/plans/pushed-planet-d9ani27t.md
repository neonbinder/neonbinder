# User Profile Page Redesign - NeonBinder Aesthetic

## Goal
Transform the user profile page (http://localhost:3000/u/[username]) to match NeonBinder's brand identity with a subtle gradient, proper typography, company icons, NeonBinder green button shadows, and logo placement.

## Current Issues
- The background gradient is too aggressive/bright (135-degree linear gradient with full color separation)
- Buttons lack NeonBinder-specific styling (no green drop shadows)
- Missing company icons on marketplace/payment buttons
- Typography doesn't consistently use NeonBinder fonts (Lexend for body, "Neon" custom font for headers)
- No NeonBinder logo in footer

## Key Design System Elements
- **Primary Color**: Neon Green (#00D558)
- **Font (Headers)**: "Neon" (custom TTF at /Neon.ttf)
- **Font (Body)**: Lexend (Google Fonts)
- **Card Background**: Semi-transparent black with backdrop blur (keep existing)
- **Logo**: Available at /public/logo.png

## Implementation Plan

### 1. Update Page Background Gradient
- **File**: `app/u/[username]/page.tsx` (around line 308)
- **Change**: Replace aggressive 135-degree gradient with a gently noticeable, more subtle gradient
  - Reduce angle steepness (e.g., 135deg to 180deg or less aggressive)
  - Apply ONLY to the page background (not to buttons)
  - Keep profile-driven colors but tone down the intensity
  - Ensure gradient is soft and gently visible rather than the current bold, in-your-face appearance

### 2. Add Company Icons to Buttons
- **File**: `app/u/[username]/page.tsx`
- **Location**: The `ProfileLinkButton` component and button rendering loops
- **Companies to icon**:
  - eBay - Find/create SVG icon
  - BuySportsCards - Find/create SVG icon
  - Sportlots - Find/create SVG icon
  - MySlabs - Find/create SVG icon
  - MyCardPost - Find/create SVG icon
  - PayPal - Find/create SVG icon
  - Venmo - Find/create SVG icon
  - Cash App - Find/create SVG icon
- **Implementation**: 
  - Create icon components or import SVG icons
  - Add icon to the left side of button labels
  - Use flex layout to align icon + label

### 3. Update Button Styling with NeonBinder Green Shadow
- **File**: `app/u/[username]/page.tsx` (ProfileLinkButton component)
- **Changes**:
  - Add box-shadow using Neon Green (#00D558) instead of color1
  - Replace current `boxShadow: '0 0 12px ${color1}55'` with `boxShadow: '0 0 12px #00D55899'` or similar
  - Optionally add a subtle drop shadow for depth

### 4. Update Typography to NeonBinder Fonts
- **File**: `app/u/[username]/page.tsx`
- **Changes**:
  - Profile name (h1): Apply "Neon" font (already available via globals.css)
  - Tagline and body text: Already using Lexend via Tailwind, ensure consistent
  - Footer text: Keep as is (already styled)
- **Classes to add**: Use `font-['Neon']` or create a utility class in globals.css if needed

### 5. Add NeonBinder Logo to Footer
- **File**: `app/u/[username]/page.tsx` (footer section, around line 390)
- **Changes**:
  - Import Next.js Image component (already done)
  - Add NeonBinder logo image above or next to "Powered by NeonBinder" text
  - Use `/public/logo.png` with appropriate sizing (e.g., 40px width)
  - Maintain proper spacing and alignment

### 6. Subtle Styling Refinements
- Ensure all colors contrast properly with the new subtle gradient
- Verify icon sizing (suggest 20px for button icons)
- Confirm logo sizing (suggest 40-50px width for footer)
- Test hover states on buttons remain visible

## Files to Modify
1. **app/u/[username]/page.tsx** - Main changes (gradient, buttons, typography, footer)

## Optional Assets to Source
- Company SVG icons (8 companies total: eBay, BuySportsCards, Sportlots, MySlabs, MyCardPost, PayPal, Venmo, Cash App)

## Testing Checklist
- [ ] Background gradient appears subtle and non-aggressive
- [ ] All buttons display company icons on the left
- [ ] Button drop shadows are NeonBinder green
- [ ] Typography uses correct NeonBinder fonts
- [ ] NeonBinder logo visible in footer
- [ ] Page remains responsive on mobile
- [ ] Colors contrast properly for accessibility
- [ ] Hover states work on all interactive elements
