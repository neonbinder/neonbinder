---
name: one-search-per-index-per-query
description: Never run two withSearchIndex reads on the same index with the same text in one Convex query — the subscription is invalidated only by docs matching the narrower filter; read the narrow leg through a plain index range instead
metadata:
  type: reference
---

A query that ran `search_name` twice with the SAME text (leg A filtered by
sport + league, leg B by sport only) went stale: inserts outside leg A's
filter never invalidated the subscribed answer (NEO-331, measured on a PR
preview, minutes stale). convex-test has no subscriptions, so no unit test
can catch it; only an E2E that types a query, creates a row, then re-types.

**How to apply:** one search per (index, text) per query. A "guarantee this
subset is in the pool" leg reads a plain index (`by_league_id` +
`.take(N)`), then gets the same JS text filter as the search rows. The
NEO-322 retry (a second search with DIFFERENT text, only when the first
found nothing) was kept and is believed safe, though not separately measured.

Second half of the same fix: a search is any-term, so a picker that shows the
server's rows as-is needs a server-side all-terms filter
(`pickerRowMatchesQuery` in convex/teams.ts) — see
[[search-index-is-or-so-longest-token-fallback-is-dead]].

Mechanism and the CDP/HTTP proof recipe: [[convex-same-text-search-legs-go-stale]]
(maestro-e2e-author memory).
