/**
 * NEO-359 — the reads My Binders shares between its pieces, over the store
 * hooks (`../data/store`), so the demo and the real collection answer the
 * same way. Every hook takes `null` to skip its read.
 */

import { useMemo } from "react";
import { useCards, useContainerCopies, useEntityCards } from "../data/store";
import type { Card, CardId, Container, Suggestion, TeamId } from "../data/types";
import { ruleTeamId, teamColorsOf, teamsOnCards, type LabelHints, type TeamColors } from "./label";
import type { CardsById } from "./model";

/**
 * Cards by id for a list of ids (the cards behind a container's copies).
 * `undefined` while they load; a card no longer in the catalog is missing
 * from the map, never a crash.
 */
export function useCardMap(cardIds: readonly CardId[] | null): CardsById | undefined {
  const key = cardIds ? [...new Set(cardIds)].sort().join("\n") : null;
  const ids = useMemo(() => (key === null ? null : key === "" ? [] : key.split("\n")), [key]);
  const cards = useCards(ids);
  return useMemo(() => {
    if (!cards) return undefined;
    const map = new Map<CardId, Card>();
    for (const card of cards) if (card) map.set(card.id, card);
    return map;
  }, [cards]);
}

/**
 * A team's colours, as NB has them on the cards it is printed on. `null`
 * when no card shows the team (or NB has no colours for it), `undefined`
 * while loading.
 */
export function useTeamColors(teamId: TeamId | null): TeamColors | null | undefined {
  const pick = useMemo(() => (teamId ? { kind: "team" as const, id: teamId, wholeFranchise: false } : null), [teamId]);
  const result = useEntityCards(pick);
  return useMemo(() => {
    if (!teamId) return null;
    if (!result) return undefined;
    for (const card of result.cards) {
      const team = card.teams.find((t) => t.id === teamId);
      const colors = team ? teamColorsOf(team) : null;
      if (colors) return colors;
    }
    return null;
  }, [teamId, result]);
}

/**
 * The colours a team suggestion carries, when the store sends them. The
 * shared `Suggestion` has no livery yet (a requested store change); until it
 * does, this answers null and the caller reads `useTeamColors` instead.
 */
export function suggestionColors(s: Suggestion): { primary: string; secondary: string } | null {
  if (s.kind !== "team") return null;
  const { primary, secondary } = s as { primary?: unknown; secondary?: unknown };
  return typeof primary === "string" && typeof secondary === "string" ? { primary, secondary } : null;
}

/**
 * What a smart binder's default label follows: the team its rule names, and
 * the teams on its cards. Read only for a smart binder that wears its default
 * (a binder, box or system container needs nothing), so the shelf stays one
 * read per spine at most.
 */
export function useLabelHints(container: Pick<Container, "id" | "rule" | "label"> | null): LabelHints {
  const follows = !!container?.rule && !container.label;
  return useRuleHints(follows ? container : null);
}

/**
 * `useLabelHints` for the label editor: always read, so its quick picks show.
 * A rule that names a player or a team reads that player's or team's catalog
 * cards (owned or not, so the default never moves as copies come and go);
 * any other rule reads the copies it holds.
 */
export function useRuleHints(container: Pick<Container, "id" | "rule"> | null): LabelHints {
  const draft = useDraftRuleHints(container?.rule ?? null);
  const byCatalog = !!draft.teams && draft.teams.length > 0;
  const copies = useContainerCopies(container?.rule && !byCatalog ? container.id : null);
  const cards = useCardMap(copies ? copies.copies.map((c) => c.cardId) : null);
  return useMemo(() => {
    if (!container?.rule) return {};
    if (byCatalog) return draft;
    const list = copies && cards ? copies.copies.map((c) => cards.get(c.cardId)).filter((c): c is Card => !!c) : [];
    return { ruleTeam: draft.ruleTeam ?? null, teams: teamsOnCards(list) };
  }, [container?.rule, byCatalog, draft, copies, cards]);
}

/**
 * `LabelHints` for a rule not saved yet (the New binder dialog): the team it
 * names, and the teams on the catalog cards of the player or team it names,
 * so the default it shows is the default the new binder will wear.
 */
export function useDraftRuleHints(rule: Container["rule"] | null): LabelHints {
  const teamId = ruleTeamId(rule ?? undefined);
  const playerId = rule && rule.kind === "player" ? rule.playerId : null;
  const ruleTeam = useTeamColors(teamId);
  const pick = useMemo(
    () =>
      playerId
        ? { kind: "player" as const, id: playerId }
        : teamId
          ? { kind: "team" as const, id: teamId, wholeFranchise: false }
          : null,
    [playerId, teamId],
  );
  const cards = useEntityCards(pick);
  return useMemo(() => {
    if (!rule) return {};
    return { ruleTeam: ruleTeam ?? null, teams: teamsOnCards(cards?.cards ?? []) };
  }, [rule, ruleTeam, cards]);
}
