"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./auth";

/**
 * Resolve Clerk user IDs to human labels for admin surfaces (NEO-170).
 *
 * The admin Pipeline Runs page stores a job's owner as the Clerk `user_...`
 * subject — that is the ownership key, and the only thing the reactive query
 * has. A person triaging runs wants a name, not a 32-char id. Clerk owns the
 * name, so this is the one place that has to leave Convex to fetch it.
 *
 * WHY AN ACTION, RESOLVING A DISTINCT SET, NOT A JOIN ON THE QUERY:
 * the reactive query polls; a per-render Clerk call — and a per-row one at
 * that — would hammer the Backend API and its rate limit. The page collects
 * the DISTINCT owner ids it is showing (a handful even across 100 rows, since
 * a run belongs to one user) and calls this ONCE, then caches. Clerk's
 * `GET /v1/users?user_id[]=` takes the whole set in a single request, so the
 * cost is one round-trip regardless of row count.
 *
 * `requireAdmin`-gated: this returns other users' identifiers, which is the
 * point on an admin screen, but nowhere else. `CLERK_SECRET_KEY` is read from
 * the Convex env, same custody as the machine-token exchange; it never leaves
 * the server.
 *
 * The label prefers a human email, then username, then a name, and falls back
 * to the id itself so an unresolvable or deleted user still renders as
 * *something* rather than blank. A lookup failure degrades to ids, never an
 * error — a name is a nicety and must not take the page down.
 */
export const adminResolveOwnerLabels = action({
  args: { userIds: v.array(v.string()) },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    // De-dupe and bound: the page sends its distinct set, but never trust the
    // caller not to send a pathological list — cap it so one request can't be
    // turned into an unbounded upstream fan-out.
    const ids = Array.from(new Set(args.userIds)).slice(0, 200);
    // Every id maps to SOMETHING; start each at itself so an id Clerk cannot
    // resolve still renders.
    const labels: Record<string, string> = Object.fromEntries(
      ids.map((id) => [id, id]),
    );
    if (ids.length === 0) return labels;

    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret) return labels; // unconfigured → ids, never an error

    try {
      const params = new URLSearchParams();
      for (const id of ids) params.append("user_id", id);
      params.set("limit", String(ids.length));
      const res = await fetch(`https://api.clerk.com/v1/users?${params.toString()}`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return labels; // rate-limited / upstream error → ids

      const users = (await res.json()) as Array<{
        id: string;
        username?: string | null;
        first_name?: string | null;
        last_name?: string | null;
        email_addresses?: Array<{ id: string; email_address: string }>;
        primary_email_address_id?: string | null;
      }>;
      for (const u of users) {
        if (!u || typeof u.id !== "string") continue;
        const primaryEmail =
          u.email_addresses?.find((e) => e.id === u.primary_email_address_id)
            ?.email_address ?? u.email_addresses?.[0]?.email_address;
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        labels[u.id] = primaryEmail || u.username || name || u.id;
      }
    } catch {
      // network/timeout → ids. Never surfaces to the page as a failure.
    }
    return labels;
  },
});
