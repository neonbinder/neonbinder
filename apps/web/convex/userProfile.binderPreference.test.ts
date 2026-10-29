// NEO-374 — where My Collection opens: userProfile.getBinderPreference,
// setBinderOpenPreference({ open }) and setLastBinder({ binderId }).
//
// Pinned here:
//   1. the default (no row, no key) is "all", with nothing remembered;
//   2. saving the setting carries every other preference across;
//   3. the last binder is kept only while the setting is "last", and choosing
//      "all" drops it;
//   4. only the caller's own binder may be remembered, and a signed-out
//      caller writes nothing.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// convex-test v0.0.53 requires import.meta.glob to discover all modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = "user_binder_aaaa1111";
const OTHER = "user_binder_bbbb2222";

async function rawProfile(t: TestConvex<typeof schema>, userId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
}

async function binder(t: TestConvex<typeof schema>, ownerId: string, name: string): Promise<Id<"collectionContainers">> {
  return t.run(async (ctx) => ctx.db.insert("collectionContainers", { ownerId, kind: "binder", name, lastUpdated: Date.now() }));
}

describe("userProfile binder preference (NEO-374)", () => {
  test("opens on All by default, for a collector with no profile and for a signed-out caller", async () => {
    const t = convexTest(schema, modules);
    expect(await t.withIdentity({ subject: USER }).query(api.userProfile.getBinderPreference, {})).toEqual({
      open: "all",
      lastBinder: null,
    });
    expect(await t.query(api.userProfile.getBinderPreference, {})).toEqual({ open: "all", lastBinder: null });
  });

  test("saving the setting keeps the theme and defaultYear", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", { userId: USER, preferences: { defaultYear: 1996, theme: "dark" } });
    });
    await t.withIdentity({ subject: USER }).mutation(api.userProfile.setBinderOpenPreference, { open: "last" });
    const row = await rawProfile(t, USER);
    expect(row!.preferences).toEqual({ defaultYear: 1996, theme: "dark", binderOpen: "last" });
  });

  test("creates the profile row when there is none", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity({ subject: USER }).mutation(api.userProfile.setBinderOpenPreference, { open: "last" });
    expect((await rawProfile(t, USER))!.preferences).toEqual({ binderOpen: "last" });
  });

  test("remembers the last binder only while the setting is 'last', and All clears it", async () => {
    const t = convexTest(schema, modules);
    const me = t.withIdentity({ subject: USER });
    const judge = await binder(t, USER, "Aaron Judge");

    // Setting is "all": a pick is not kept.
    await me.mutation(api.userProfile.setBinderOpenPreference, { open: "all" });
    await me.mutation(api.userProfile.setLastBinder, { binderId: judge });
    expect((await rawProfile(t, USER))!.preferences).toEqual({ binderOpen: "all" });

    await me.mutation(api.userProfile.setBinderOpenPreference, { open: "last" });
    await me.mutation(api.userProfile.setLastBinder, { binderId: judge });
    expect(await me.query(api.userProfile.getBinderPreference, {})).toEqual({ open: "last", lastBinder: judge });

    // Picking All is remembered as All.
    await me.mutation(api.userProfile.setLastBinder, { binderId: null });
    expect(await me.query(api.userProfile.getBinderPreference, {})).toEqual({ open: "last", lastBinder: null });

    // Switching back to "all" drops a remembered binder.
    await me.mutation(api.userProfile.setLastBinder, { binderId: judge });
    await me.mutation(api.userProfile.setBinderOpenPreference, { open: "all" });
    expect((await rawProfile(t, USER))!.preferences).toEqual({ binderOpen: "all" });
  });

  test("refuses another collector's binder and a signed-out caller", async () => {
    const t = convexTest(schema, modules);
    const me = t.withIdentity({ subject: USER });
    await me.mutation(api.userProfile.setBinderOpenPreference, { open: "last" });
    const theirs = await binder(t, OTHER, "Not yours");
    await expect(me.mutation(api.userProfile.setLastBinder, { binderId: theirs })).rejects.toThrow(/Binder not found/);
    await expect(t.mutation(api.userProfile.setLastBinder, { binderId: null })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.userProfile.setBinderOpenPreference, { open: "last" })).rejects.toThrow(
      /Not authenticated/,
    );
    expect((await rawProfile(t, USER))!.preferences).toEqual({ binderOpen: "last" });
  });
});
