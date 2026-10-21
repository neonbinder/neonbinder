import type { Ref } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { LayoutMode, PageModel, PileFilters, SlotRef, SortKey } from "../../prototypes/p2/model";
import BinderDesk, { whereLabel } from "./BinderDesk";
import type { OpenView } from "./openView";
import { Cover, MobileSummary, ModeToggle, PileTools, ScopeLine } from "./parts";
import type { PocketHandlers } from "./Pocket";
import ShareLink from "./ShareLink";

/**
 * NEO-350 — the one open-binder view of My Binders: the header (back, title,
 * badge, where you are, Share, the layout toggle, the pile's tools), the
 * scope line, the cover and the spread of pockets. A binder, a smart
 * binder, the Want List, All my cards and a set you are browsing all render
 * here; what differs between them arrives in `open` (see `openView.ts`), so
 * a browsed set gets the same Share and layout toggle as a binder, and no
 * label controls because it has no label.
 */

export interface PileControls {
  sort: SortKey;
  onSort: (s: SortKey) => void;
  filters: PileFilters;
  onFilters: (f: PileFilters) => void;
}

interface BinderViewProps extends PocketHandlers {
  open: OpenView;
  pages: PageModel[];
  wide: boolean;
  at: number;
  onTurn: (to: number) => void;
  onBack: () => void;
  onLayout: (mode: LayoutMode) => void;
  onEditLabel: () => void;
  onGoChecklists: () => void;
  pile: PileControls;
  aimed: SlotRef | null;
  found: SlotRef | null;
  wholeBinderDrop: boolean;
  reducedMotion: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  deskRef: Ref<HTMLDivElement>;
}

export default function BinderView({
  open,
  pages,
  wide,
  at,
  onTurn,
  onBack,
  onLayout,
  onEditLabel,
  onGoChecklists,
  pile,
  aimed,
  found,
  wholeBinderDrop,
  reducedMotion,
  headingRef,
  deskRef,
  onOpen,
  onAdd,
  onAim,
}: BinderViewProps) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-600 px-3 text-sm font-medium text-slate-100 hover:border-neon-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
        >
          <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
          Back to the shelf
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-2xl font-bold text-white focus:outline-none sm:text-3xl"
          >
            {open.title}
          </h2>
          {open.badge && (
            <span
              className={
                open.badge.tone === "smart"
                  ? "rounded bg-neon-purple px-1.5 text-xs font-bold leading-5 text-black"
                  : "rounded border border-neon-blue px-1.5 text-xs font-bold leading-5 text-neon-blue"
              }
            >
              {open.badge.text}
            </span>
          )}
        </div>
        <p aria-live="polite" className="text-sm tabular-nums text-slate-300">
          {whereLabel(pages.length, wide, at)}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {open.share && <ShareLink key={open.key} target={open.share} />}
          {open.layout && <ModeToggle mode={open.layout} onChange={onLayout} />}
          {open.pileTools && <PileTools {...pile} />}
        </div>
      </div>

      {open.scopeLine && <ScopeLine text={open.scopeLine} onGo={onGoChecklists} />}

      {!wide && <MobileSummary open={open} onEditLabel={onEditLabel} />}

      <div ref={deskRef} className="scroll-mt-2">
        <BinderDesk
          pages={pages}
          wide={wide}
          at={at}
          onTurn={onTurn}
          vinyl={open.vinyl}
          cover={<Cover open={open} onEditLabel={onEditLabel} />}
          variant={open.pockets}
          aimed={aimed}
          found={found}
          wholeBinderDrop={wholeBinderDrop}
          reducedMotion={reducedMotion}
          name={open.title}
          onOpen={onOpen}
          onAdd={onAdd}
          onAim={onAim}
        />
      </div>
    </div>
  );
}
