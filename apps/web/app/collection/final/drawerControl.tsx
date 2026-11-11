import { startTransition, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import CardDrawer from "./CardDrawer";
import type { Card, CardId, CopyId } from "./data/types";
import { DRAWER_MODE_PARAM, DRAWER_PARAM } from "./drawerParams";
import { usePushParams, useReplaceParams } from "./mode";
import type { OpenCardOptions } from "./pageApi";
import type { StatusLine } from "./statusLine";

/**
 * NEO-358 / NEO-464 — the card drawer on the page URL: `detail=<id>` (plus
 * `mode=add`) opens it, so Back closes it and a refresh or a shared link
 * reopens it. The collection page (`./FinalCollectionPage`) drives it from
 * every tab; the dashboard opens the same drawer over itself
 * (`app/dashboard/screen/CardPanelHost`).
 *
 * Opening a card pushes `detail=<id>` (Back closes it); ↑ ↓ replace it (Back
 * never walks the cards one by one); Close steps Back off an entry the
 * drawer pushed, and otherwise (a shared link, a refresh in a new tab)
 * takes the params off in place.
 *
 * Needs `CollectionModeProvider` above it (the push and replace build on the
 * newest entry the page asked for).
 */

/**
 * What the opener knew that the URL does not carry: the list the drawer's
 * ↑ ↓ step through, the card as drawn, the copy to ring. Kept for the card
 * it was set for; a drawer reopened from the URL alone steps through the
 * list on its history entry (`DrawerHistoryState.list`), else just its card.
 */
interface DrawerExtras {
  cardId: CardId;
  listIds: CardId[];
  seed?: Card;
  copyId?: CopyId;
  /** The home the add form picks instead of the page's scope. */
  binderId?: string;
  /** Open `copyId`'s Edit form when it is the card's one line (a row click). */
  edit?: boolean;
  key: number;
}

/**
 * The history state on an entry the drawer pushed: Close steps Back off it.
 * A link that opens the drawer from outside it (the dashboard's card links)
 * puts the same state on its push.
 */
export interface DrawerHistoryState {
  drawer?: boolean;
  /**
   * The list ↑ ↓ step through, for a drawer opened by a plain link (the
   * dashboard's card links), which hands the drawer no extras. It rides on
   * the entry, so ↑ ↓ (a replace keeps it), a refresh and Forward keep it; a
   * link opened in a new tab carries none and steps through just its card.
   */
  list?: CardId[];
}

/** The history state's list, when it is one and holds the card. */
function stateList(state: unknown, cardId: CardId): CardId[] | null {
  const list = (state as DrawerHistoryState | null)?.list;
  if (!Array.isArray(list) || !list.every((id) => typeof id === "string")) return null;
  return list.includes(cardId) ? list : null;
}

/** The drawer as the URL (and the opener) has it: null while closed. */
export interface OpenDrawer {
  cardId: CardId;
  listIds: CardId[];
  seed?: Card;
  mode: "view" | "add";
  copyId?: CopyId;
  binderId?: string;
  edit?: boolean;
  key: number;
}

export interface CardDrawerControl {
  drawer: OpenDrawer | null;
  /** Where the open card sits in `drawer.listIds`; -1 while closed. */
  drawerIndex: number;
  openCard: (cardId: CardId, opts?: OpenCardOptions) => void;
  closeDrawer: () => void;
  /** ↑ (-1) or ↓ (1): the step, or null at that end of the list. */
  step: (delta: 1 | -1) => (() => void) | null;
}

export function useCardDrawer(
  params: URLSearchParams,
  {
    beforeOpen,
    closeParams = [],
  }: {
    /** Runs before a card opens (the collection page settles its search box). */
    beforeOpen?: () => void;
    /** More params the drawer owns, taken off with it when it closes in place. */
    closeParams?: readonly string[];
  } = {},
): CardDrawerControl {
  const location = useLocation();
  const navigate = useNavigate();
  const pushParams = usePushParams();
  const replaceParams = useReplaceParams();
  const [extras, setExtras] = useState<DrawerExtras | null>(null);
  const drawerId = params.get(DRAWER_PARAM);
  const ours = extras && extras.cardId === drawerId ? extras : null;
  const drawer: OpenDrawer | null = drawerId
    ? {
        cardId: drawerId,
        listIds:
          extras && extras.listIds.includes(drawerId)
            ? extras.listIds
            : (stateList(location.state, drawerId) ?? [drawerId]),
        seed: ours?.seed,
        mode:
          params.get(DRAWER_MODE_PARAM) === "add"
            ? ("add" as const)
            : ("view" as const),
        copyId: ours?.copyId,
        binderId: ours?.binderId,
        edit: ours?.edit,
        key: extras?.key ?? 0,
      }
    : null;
  const pushedDrawer =
    (location.state as DrawerHistoryState | null)?.drawer === true;
  const openCard = (cardId: CardId, opts: OpenCardOptions = {}) => {
    beforeOpen?.();
    // The URL commits in a transition: let the opener's extras land with it.
    startTransition(() =>
      setExtras((prev) => ({
        cardId,
        listIds: opts.list && opts.list.includes(cardId) ? opts.list : [cardId],
        seed: opts.seed,
        copyId: opts.copyId,
        binderId: opts.binderId,
        edit: opts.edit,
        key: (prev?.key ?? 0) + 1,
      })),
    );
    const write = (p: URLSearchParams) => {
      p.set(DRAWER_PARAM, cardId);
      if (opts.mode === "add") p.set(DRAWER_MODE_PARAM, "add");
      else p.delete(DRAWER_MODE_PARAM);
    };
    // Already open (a card picked from inside it): swap the card in place.
    if (drawerId) replaceParams(write);
    else pushParams(write, { drawer: true } satisfies DrawerHistoryState);
  };
  const closeDrawer = () => {
    if (pushedDrawer) void navigate(-1);
    else
      replaceParams((p) => {
        p.delete(DRAWER_PARAM);
        p.delete(DRAWER_MODE_PARAM);
        for (const key of closeParams) p.delete(key);
      });
  };
  const drawerIndex = drawer ? drawer.listIds.indexOf(drawer.cardId) : -1;
  const step = (delta: 1 | -1) =>
    drawer &&
    drawerIndex + delta >= 0 &&
    drawerIndex + delta < drawer.listIds.length
      ? () => {
          const next = drawer.listIds[drawerIndex + delta];
          startTransition(() =>
            setExtras((prev) => ({
              cardId: next,
              listIds: drawer.listIds,
              key: (prev?.key ?? 0) + 1,
            })),
          );
          replaceParams((p) => {
            p.set(DRAWER_PARAM, next);
            p.delete(DRAWER_MODE_PARAM);
          });
        }
      : null;
  return { drawer, drawerIndex, openCard, closeDrawer, step };
}

/** The open drawer, drawn: the card, its ↑ ↓ ×, and the page's status line inside it. */
export function OpenCardDrawer({
  control,
  line,
}: {
  control: CardDrawerControl & { drawer: OpenDrawer };
  line: StatusLine;
}) {
  const { drawer, drawerIndex, closeDrawer, step } = control;
  return (
    <CardDrawer
      cardId={drawer.cardId}
      seed={drawer.seed}
      mode={drawer.mode}
      focusCopyId={drawer.copyId}
      editCopyId={drawer.edit ? drawer.copyId : undefined}
      addBinderId={drawer.binderId}
      openKey={drawer.key}
      notice={line.notice}
      onUndo={line.undo}
      onDismissNotice={line.dismiss}
      onClose={closeDrawer}
      onPrev={step(-1)}
      onNext={step(1)}
      position={
        drawer.listIds.length > 1
          ? { index: drawerIndex, total: drawer.listIds.length }
          : null
      }
    />
  );
}

/** Whether the drawer is open, as a type guard for `OpenCardDrawer`. */
export function isOpen(control: CardDrawerControl): control is CardDrawerControl & { drawer: OpenDrawer } {
  return control.drawer !== null;
}
