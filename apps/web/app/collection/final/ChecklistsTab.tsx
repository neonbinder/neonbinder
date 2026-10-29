import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import { DRILL_ROW_ATTR } from "../prototypes/p1/StaticColumn";
import { FOCUS } from "../prototypes/p1/ui";
import BinderPicker from "./BinderPicker";
import { SearchHitRow, type RowActions } from "./CardRows";
import Cascade from "./catalog/Cascade";
import type { Drill } from "./catalog/drill";
import EntityResults from "./catalog/EntityResults";
import { useScopedName } from "./catalog/home";
import { useSearchText } from "./catalog/search";
import { LoadingNote, SkeletonBars } from "./catalog/Skeleton";
import Suggestions from "./catalog/Suggestions";
import type { DrillState } from "./catalog/useDrillState";
import type { EntityParam } from "./checklistParams";
import Checklist from "./Checklist";
import {
  searchable,
  systemContainer,
  useCapabilities,
  useCollectionStore,
  useContainers,
  useDemoExtension,
  useReadOnlyAll,
  useSearch,
  useSide,
} from "./data/store";
import type { Card, CardId, Suggestion } from "./data/types";
import { QuickEntryProvider } from "./inventory/QuickEntry";
import TargetBoxPicker from "./inventory/TargetBoxPicker";
import { useSetScope } from "./mode";
import RequestCardDialog from "./RequestCardDialog";
import RequestsDialog, { type RequestsTab } from "./requests/RequestsDialog";

const FIRST_PAGE = 8;

export interface ChecklistsTabProps {
  actions: RowActions;
  query: string;
  onQuery: (q: string) => void;
  drill: DrillState;
  /** Bumps when the drill is set from outside the cascade, to rebuild it. */
  cascadeKey: number;
  onDrill: (next: Drill) => void;
  /** Open a card's checklist and ring its row. */
  onJump: (card: Card) => void;
  highlightCardId: CardId | null;
  selectedCardId: CardId | null;
  /** A picked player or team, whose cards show in place of the search results. */
  entity: EntityParam | null;
  onPickSuggestion: (s: Suggestion) => void;
  onFranchise: (whole: boolean) => void;
  onClearEntity: () => void;
  /** A jump to a card the catalog no longer holds. */
  missingCard: boolean;
  /**
   * Where the keyboard goes once the URL catches up: a picked player or team
   * puts it on their cards' heading, "Back to the search" back in the box.
   * Set by the page (a pick from My Cards lands here too); taken once.
   */
  arrivalRef: MutableRefObject<"entity" | "search" | null>;
}

/**
 * The page's side picks what the rows do (NEO-364): on the inventory side
 * the tab gets the "Adding to" box picker on top, and every row (the
 * checklist's and the search's) is a quantity field for that box, sharing
 * one commit queue (`./inventory/QuickEntry`). The collection side is
 * unchanged.
 */
export default function ChecklistsTab(props: ChecklistsTabProps) {
  const side = useSide();
  if (side !== "inventory") return <ChecklistsView {...props} inventory={false} />;
  return (
    <QuickEntryProvider>
      <ChecklistsView {...props} inventory />
    </QuickEntryProvider>
  );
}

/**
 * Checklists: a search on top ("96 contenders reggie white"), which offers
 * players, teams and sets first and then the cards whose title holds every
 * word; the Set Builder's cascade underneath for browsing the long way; then
 * the checklist. A result's click opens its checklist with the row ringed.
 *
 * The drill (`drill`) is read and checked by the page (`useDrillState`),
 * which also titles the tab; this view draws it.
 */
function ChecklistsView({
  actions,
  query,
  onQuery,
  drill,
  cascadeKey,
  onDrill,
  onJump,
  highlightCardId,
  selectedCardId,
  entity,
  onPickSuggestion,
  onFranchise,
  onClearEntity,
  missingCard,
  arrivalRef,
  inventory,
}: ChecklistsTabProps & { inventory: boolean }) {
  const capabilities = useCapabilities();
  const demo = useDemoExtension();
  const real = useCollectionStore().kind === "convex";
  const setScope = useSetScope();
  const scopedName = useScopedName();
  const readOnly = useReadOnlyAll();
  const containers = useContainers();
  const [showAll, setShowAll] = useState(false);
  const [requesting, setRequesting] = useState<RequestsTab | null>(null);
  const text = useSearchText(query);
  const result = useSearch(text);
  const typed = query.trim();
  const hits = result?.cards ?? [];
  const shown = showAll ? hits : hits.slice(0, FIRST_PAGE);
  // Requests are a collection-side thing: "I have it" files the card in a binder.
  const canRequest = capabilities.cardRequests && (real ? !inventory : !!demo);

  const checklistHeading = useRef<HTMLHeadingElement>(null);
  const entityHeading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const entityKey = entity ? `${entity.kind}:${entity.id}` : "";
  useEffect(() => {
    const want = arrivalRef.current;
    if (want === "entity" && entityKey) {
      arrivalRef.current = null;
      entityHeading.current?.focus();
    } else if (want === "search" && !entityKey) {
      arrivalRef.current = null;
      searchInput.current?.focus();
    }
  }, [entityKey, arrivalRef]);
  const focusChecklist = useCallback(() => {
    const heading = checklistHeading.current;
    heading?.focus();
    return !!heading;
  }, []);

  // A cascade rebuilt from outside (a deep link, Back or Forward, a search
  // jump) starts scrolled to its first column; on a narrow row that leaves
  // the open column out of sight. Show the deepest one, as a pick would.
  const browseRef = useRef<HTMLElement>(null);
  const columnCount = drill.columns.length;
  useEffect(() => {
    const row = browseRef.current?.querySelector<HTMLElement>(`[${DRILL_ROW_ATTR}]`);
    if (row) row.scrollLeft = row.scrollWidth;
  }, [cascadeKey, columnCount]);

  const askLink = (label: string, tab: RequestsTab = "card") => (
    <button
      type="button"
      onClick={() => setRequesting(tab)}
      className={`rounded-sm text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
    >
      {label}
    </button>
  );

  // What the line under the box says. Short text is not searched yet.
  let status = "";
  if (entity) status = "";
  else if (typed && !searchable(typed)) status = "Keep going: two letters and we're off.";
  else if (searchable(typed) && (result === undefined || text !== typed)) status = "Flipping through the catalog…";
  else if (searchable(typed) && hits.length === 0) status = `Nothing matches “${typed}”.`;
  else if (hits.length > 0) {
    status = result?.truncated
      ? `The first ${hits.length} matches. Add a word to narrow it down.`
      : `${hits.length} ${hits.length === 1 ? "card matches" : "cards match"}. Pick yours.`;
  }
  const settled = searchable(typed) && result !== undefined && text === typed;

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Checklists</h2>
      {inventory && <TargetBoxPicker />}
      <section aria-label="Quick search" className="space-y-3">
        <div role="search" className="relative max-w-2xl">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-[2.65rem] h-5 w-5 text-ink-3"
          />
          <Input
            ref={searchInput}
            surface="dark"
            type="search"
            label="Search every card"
            placeholder="Try “96 contenders reggie white”"
            value={query}
            onChange={(e) => {
              onQuery(e.target.value);
              setShowAll(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                onQuery("");
              }
            }}
            autoComplete="off"
            spellCheck={false}
            className="pl-10"
          />
        </div>
        <p role="status" className="text-xs text-ink-3">
          {status}
        </p>
        {missingCard && (
          <p className="max-w-2xl rounded-lg border border-dashed border-rule-strong p-3 text-sm text-ink-2">
            That card is no longer in the catalog. Your copies of it are safe.
          </p>
        )}
        {/* The status line above speaks for the search; the suggestions keep quiet. */}
        {!entity && <Suggestions text={text} onPick={onPickSuggestion} silent />}

        {entity ? (
          <EntityResults
            ref={entityHeading}
            entity={entity}
            actions={actions}
            selectedCardId={selectedCardId}
            onJump={onJump}
            onFranchise={onFranchise}
            onClear={onClearEntity}
          />
        ) : settled && hits.length === 0 ? (
          <div className="max-w-2xl rounded-lg border border-dashed border-neon-blue/50 bg-raised p-4 text-sm text-ink-2 shadow-offset">
            <p className="font-semibold text-ink">Not in the catalog yet.</p>
            {canRequest ? (
              real ? (
                <p className="mt-1 text-ink-2">
                  {askLink("Request a card")} or {askLink("request a set", "set")}. It&apos;s yours to file while
                  our crew adds it.
                </p>
              ) : (
                <p className="mt-1 text-ink-2">
                  {askLink("Ask us to add it")}. It&apos;s a demo, so your request stays right here with you.
                </p>
              )
            ) : (
              <p className="mt-1 text-ink-2">
                We&apos;re still filling the long boxes. Try a year, a set or a last name, or browse below.
              </p>
            )}
          </div>
        ) : (
          canRequest &&
          (real ? (
            <p className="text-xs text-ink-3">
              Can&apos;t find it? {askLink("Request a card")} · {askLink("Request a set", "set")} ·{" "}
              {askLink("My requests", "mine")}
            </p>
          ) : (
            <p className="text-xs text-ink-3">{askLink("Can't find it? Ask us to add it")}</p>
          ))
        )}

        {!entity && searchable(typed) && !settled && result === undefined && (
          <div aria-hidden="true" className="max-w-2xl">
            <SkeletonBars rows={3} />
          </div>
        )}

        {!entity && shown.length > 0 && (
          <>
            {/* NEO-374 — under All the hits' Have is locked: the picker says why and unlocks it. */}
            {readOnly && <BinderPicker />}
            {scopedName && !inventory && (
              <p className="text-xs text-ink-2">
                Have, Want and Trade below are for <span className="text-neon-blue-text">{scopedName}</span>.{" "}
                <button
                  type="button"
                  onClick={() => setScope("all")}
                  className={`rounded-sm text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
                >
                  Show all binders
                </button>
              </p>
            )}
            <ul className="space-y-1.5 rounded-lg bg-raised p-3 shadow-offset sm:p-4">
              {shown.map((card) => (
                <SearchHitRow
                  key={card.id}
                  card={card}
                  actions={{ ...actions, open: (c, copyId) => actions.open(c, copyId, hits) }}
                  isSelected={card.id === selectedCardId}
                  showSet
                  onRowClick={() => onJump(card)}
                  onOpenChecklist={() => onJump(card)}
                />
              ))}
            </ul>
            {hits.length > FIRST_PAGE && !showAll && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className={`rounded px-2 py-1 text-sm text-neon-blue-text underline underline-offset-2 ${FOCUS}`}
              >
                Show all {hits.length} matches
              </button>
            )}
          </>
        )}
      </section>

      <section ref={browseRef} aria-label="Browse sets" className="space-y-4">
        <p className="text-sm text-ink-2">Or drill down: sport, year, brand, set, then base, an insert or a parallel.</p>
        <Cascade
          key={cascadeKey}
          state={drill}
          onDrill={onDrill}
          label="Sport, year, brand and set"
          onReachedChecklist={focusChecklist}
        />
        {drill.checklist?.variantId && drill.drill.set && (
          <Checklist
            key={`${drill.checklist.variantId}|${cascadeKey}`}
            ref={checklistHeading}
            setId={drill.drill.set}
            variantId={drill.checklist.variantId}
            title={drill.checklistTitle ?? drill.checklist.name}
            actions={actions}
            selectedCardId={selectedCardId}
            highlightCardId={highlightCardId}
          />
        )}
        {drill.pending && !drill.checklist && drill.drill.type && (
          <div aria-busy="true" className="rounded-lg bg-raised p-4 shadow-offset sm:p-6">
            <SkeletonBars rows={5} />
            <LoadingNote>Finding the checklist…</LoadingNote>
          </div>
        )}
      </section>

      {requesting && real && (
        <RequestsDialog
          searched={query}
          drill={drill.drill}
          initialTab={requesting}
          // NEO-374 — "I have it" is its own explicit add: under All it files into Main.
          onHave={(card) => actions.have(card, readOnly ? systemContainer(containers, "main")?.id : undefined)}
          onClose={() => setRequesting(null)}
        />
      )}
      {requesting && !real && demo && (
        <RequestCardDialog store={demo} searched={query} onClose={() => setRequesting(null)} />
      )}
    </div>
  );
}
