---
name: reference-userprofile-fields-go-top-level
description: A new per-user field on userProfiles goes at the top level, not under `preferences` — getUserProfile returns preferences through a fixed validator and updateUserProfile replaces the object whole
metadata:
  type: reference
---

Put a new per-user stamp or setting on `userProfiles` as its own top-level
optional field, not inside `preferences`, unless it is a real Profile →
Settings preference you are also adding to every reader.

**Why:** `userProfile.getUserProfile` returns `profile.preferences` as-is
through a `returns` validator that lists each preferences field by hand, so a
new field stored there makes that query throw a return-validation error for
every collector who has it. `updateUserProfile` also REPLACES `preferences`
whole, silently dropping anything it does not send. A top-level field is
never returned by `getUserProfile` (it builds its result field by field).
Found building the dashboard visit stamp (NEO-464, `dashboardVisit`).

**How to apply:** a top-level `v.optional(...)` on `userProfiles` needs no
migration; write it with a targeted `patch`, insert the row with `{ userId,
<field> }` when none exists (as `setThemePreference` does for preferences).
If it truly belongs under `preferences`, add it to the `getUserProfile`
returns validator and to `updateUserProfile`'s args in the same change.
Related: [[reference-convex-codegen-only-blocks-types]].
