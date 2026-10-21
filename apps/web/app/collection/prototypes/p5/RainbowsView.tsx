import {
  getCard,
  getSet,
  getTeam,
  playerNames,
  printRunLabel,
  setLabel,
  teamTextColor,
} from "../_shared/data";
import { useP5 } from "./context";
import CardStrip from "./CardStrip";
import CardTile from "./CardTile";
import { countOwned, parallelName, rainbowOf } from "./model";

/**
 * Rainbows: one card per row, every parallel across, the count up top. A
 * rainbow is keyed by its base card's id, never by "#13".
 */
export default function RainbowsView() {
  const p5 = useP5();
  const { chased, owned } = p5;

  return (
    <div>
      <p className="max-w-prose text-slate-300">
        One card, every colour it comes in. Open any card and hit Chase this
        rainbow to pin it here.
      </p>
      {chased.length === 0 && (
        <p className="mt-6 rounded-lg border border-dashed border-slate-600 p-6 text-slate-300">
          No rainbows on the go. Pick a card with parallels and start chasing.
        </p>
      )}
      <ol className="mt-6 flex flex-col gap-8">
        {chased.map((rootId) => {
          const root = getCard(rootId);
          const rainbow = rainbowOf(root);
          const have = countOwned(rainbow, owned);
          const team = getTeam(root.teamIds[0]);
          const title = `${playerNames(root)}, ${setLabel(getSet(root.setId))} #${root.cardNumber}${
            root.variation ? ` ${root.variation}` : ""
          }`;
          return (
            <li
              key={rootId}
              className="rounded-xl border border-slate-700 bg-slate-950 p-4 sm:p-5"
              style={{ borderTopColor: team.primary, borderTopWidth: 4 }}
            >
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold text-white">
                    {playerNames(root)}
                  </h2>
                  <p className="text-sm text-slate-300">
                    {setLabel(getSet(root.setId))} #{root.cardNumber},{" "}
                    <span
                      className="font-semibold"
                      style={{ color: teamTextColor(team) }}
                    >
                      {team.name}
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <p className="text-right">
                    <span className="text-3xl font-bold tabular-nums text-white">
                      {have}
                    </span>
                    <span className="text-slate-300"> of {rainbow.length}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      p5.toggleChase(rootId);
                      p5.announce(
                        `Stopped chasing the ${playerNames(root)} rainbow.`,
                        () => p5.toggleChase(rootId),
                      );
                    }}
                    aria-label={`Stop chasing ${title}`}
                    className="min-h-11 rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-neon-pink hover:text-neon-pink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
                  >
                    Stop chasing
                  </button>
                </div>
              </div>
              {/* The meter: one cell per parallel, lit when owned. */}
              <div aria-hidden="true" className="mb-4 flex gap-1">
                {rainbow.map((c) => (
                  <span
                    key={c.id}
                    className={`h-2 flex-1 rounded-sm ${owned.has(c.id) ? "" : "bg-slate-800"}`}
                    style={
                      owned.has(c.id)
                        ? {
                            background:
                              c.finish.kind === "gold" ||
                              c.finish.kind === "superfractor"
                                ? "#F5D77A"
                                : (c.finish.tint ?? "#00C2FF"),
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
              <CardStrip label={`${playerNames(root)} rainbow`}>
                {rainbow.map((c) => (
                  <CardTile
                    key={c.id}
                    card={c}
                    caption={
                      <>
                        <span className="block truncate font-medium text-slate-100">
                          {parallelName(c)}
                        </span>
                        <span className="block font-semibold tabular-nums text-[#F5D77A]">
                          {printRunLabel(c) ?? (
                            <span className="font-normal text-slate-400">
                              Unnumbered
                            </span>
                          )}
                        </span>
                      </>
                    }
                  />
                ))}
              </CardStrip>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
