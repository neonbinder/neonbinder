/**
 * NEO-359 — the reads My Binders shares between its pieces, over the store
 * hooks (`../data/store`), so the demo and the real collection answer the
 * same way. Every hook takes `null` to skip its read.
 */

import { useMemo } from "react";
import { useCards, useContainerCopies, useEntityCards, useTeam } from "../data/store";
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
 * A team's colours, read off its own row (so a team no card shows still has
 * them). `null` when NB has no colours for it (or it left the catalog),
 * `undefined` while loading.
 */
export function useTeamColors(teamId: TeamId | null): TeamColors | null | undefined {
  const team = useTeam(teamId);
  return useMemo(() => {
    if (!teamId) return null;
    if (team === undefined) return undefined;
    return team ? teamColorsOf(team) : null;
  }, [teamId, team]);
}

/** The colours a team suggestion carries, when NB has both. */
export function suggestionColors(s: Suggestion): { primary: string; secondary: string } | null {
  if (s.kind !== "team" || !s.primary || !s.secondary) return null;
  return { primary: s.primary, secondary: s.secondary };
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
