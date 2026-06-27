/**
 * Source-set filter chips (NEO-6 phase 1). Renders one row per marketplace
 * that has more than one attached source set. Each row gets an "All" chip
 * plus one chip per attached source ID with its operator-given label.
 *
 * Keyboard model: chips are <button>s, focusable via Tab; Enter / Space
 * activates. The currently-selected chip on each row gets the neon-green
 * outline.
 */
type Side = "bsc" | "sportlots";

export type SourceChips = {
  bsc?: { primaryId: string; chips: Array<{ id: string; label: string }> };
  sportlots?: { primaryId: string; chips: Array<{ id: string; label: string }> };
};

export type SourceFilter = {
  bsc: string | null;
  sportlots: string | null;
};

export default function ChecklistSourceFilter({
  chips,
  filter,
  onChange,
}: {
  chips: SourceChips;
  filter: SourceFilter;
  onChange: (filter: SourceFilter) => void;
}) {
  const sides: Array<{ side: Side; title: string }> = [
    { side: "bsc", title: "BSC source" },
    { side: "sportlots", title: "SL source" },
  ];

  const anyMulti =
    (chips.bsc?.chips.length ?? 0) > 1 ||
    (chips.sportlots?.chips.length ?? 0) > 1;
  if (!anyMulti) return null;

  return (
    <div
      className="flex flex-col gap-2 mb-3"
      role="region"
      aria-label="Filter checklist by source set"
    >
      {sides.map(({ side, title }) => {
        const cfg = chips[side];
        if (!cfg || cfg.chips.length <= 1) return null;
        const selected = filter[side];
        return (
          <div key={side} className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-24 shrink-0">
              {title}
            </span>
            <Chip
              label="All"
              active={selected === null}
              onClick={() => onChange({ ...filter, [side]: null })}
            />
            {cfg.chips.map((c) => (
              <Chip
                key={c.id}
                label={c.label}
                title={c.id === cfg.primaryId ? "Primary source" : undefined}
                active={selected === c.id}
                onClick={() => onChange({ ...filter, [side]: c.id })}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Chip({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      aria-label={`Filter source: ${label}${active ? " (selected)" : ""}`}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors focus:outline-none focus:ring-1 focus:ring-[#00D558] ${
        active
          ? "border-[#00D558] bg-[#00D558]/15 text-[#00D558]"
          : "border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500"
      }`}
    >
      {label}
    </button>
  );
}
