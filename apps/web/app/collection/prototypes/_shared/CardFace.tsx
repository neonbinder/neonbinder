import type { CSSProperties, ReactNode } from "react";
import {
  cardLabel,
  getSet,
  inkOn,
  leadPlayer,
  leadTeam,
  playerInitials,
  type Card,
  type Finish,
} from "./data";
import type { Card as ModelCard } from "../../final/data/types";
import { cardLabel as modelLabel, playerInitials as initialsOf } from "../../final/data/labels";
import { useCardImage } from "../../final/data/cardImages";
import type { CopyPhotos } from "../../final/data/types";
import "./card-face.css";

/**
 * NEO-350 — a stand-in trading card for the prototypes (there are no real
 * images yet). It should read as a card at a glance: a team-colour frame, a
 * pinstriped photo window in the team's livery with the player's initials, a
 * slanted nameplate, the number in the corner, and the finish a collector
 * would recognise (refractor rainbow, gold, foil, the /99 stamp, the 1/1).
 *
 * Accessibility: the whole face is ONE `role="img"` named by `cardLabel`
 * (plus "need" when not owned, plus the copy's serial when given); every
 * piece of art inside is aria-hidden. Wrap it in a button or link and that
 * control takes the card's name from it.
 *
 * Everything inside scales with the card's own width (container query
 * units), so one component serves a 9-pocket thumbnail and a detail view.
 */

export type CardFaceSize = "sm" | "md" | "lg" | "fill";

const WIDTH: Record<CardFaceSize, string> = {
  sm: "5.5rem",
  md: "9rem",
  lg: "15rem",
  fill: "100%",
};

export interface CardFaceProps {
  /** A prototype fixture card. Pass this or `model`. */
  card?: Card;
  /**
   * NEO-358: a card from the collection's view model (the real catalog or
   * the demo store), drawn the same way. Its finish comes from its variant's
   * title (`final/data/finish`); a team NB has no colours for draws in slate.
   */
  model?: ModelCard;
  /** sm 88px, md 144px, lg 240px, fill = the parent's width. Default md. */
  size?: CardFaceSize;
  /** "need" dims and desaturates the card and says "Need" on it. Default owned. */
  state?: "owned" | "need";
  /**
   * Draw an empty sleeve instead of the card: a dashed pocket with the card's
   * number as a ghost, for a slot the collector has yet to fill.
   */
  empty?: boolean;
  /** This copy's own serial ("23/50"): replaces the bare "/50" stamp. */
  serial?: string;
  /** Overrides the accessible name. */
  label?: string;
  className?: string;
  /**
   * NEO-377: a real photo to show instead of the drawn card. Left out, a
   * `model` card shows the collector's own photo when the page has one
   * (`final/data/cardImages`); the drawing is the fallback.
   */
  photo?: CopyPhotos;
}

/** Proportions used inside the face, in % of the card's width. */
const cq = (n: number) => `${n}cqw`;

const GOLD_FRAME =
  "linear-gradient(135deg, #8a6a1c 0%, #f5d77a 28%, #b8902c 52%, #fff1b8 74%, #9c7a23 100%)";

/** Everything the face draws, whichever kind of card it was handed. */
interface Face {
  label: string;
  season: string;
  setName: string;
  cardNumber: string;
  playerName: string;
  initials: string;
  teamName: string;
  primary: string;
  secondary: string;
  printRun: number | null;
  features: readonly string[];
  variation: string | null;
  /** The insert or parallel's name; null for Base. */
  variantName: string | null;
  finish: Finish;
  /** NEO-361 — the collector's own card, not a known NB card: wears the "Unlisted" tag. */
  own: boolean;
}

/** A team NB has no livery for: slate frame, lighter slate band. */
const NO_LIVERY = { primary: "#334155", secondary: "#94A3B8" };

function faceOf(card: Card | undefined, model: ModelCard | undefined): Face {
  if (model) {
    const player = model.players[0];
    const team = model.teams[0];
    return {
      label: modelLabel(model),
      season: model.set.season,
      setName: model.set.name,
      cardNumber: model.cardNumber,
      playerName: player?.nameOnCard ?? player?.name ?? "",
      initials: player ? initialsOf(player.name) : "?",
      teamName: team?.name ?? "",
      primary: team?.primary ?? NO_LIVERY.primary,
      secondary: team?.secondary ?? team?.primary ?? NO_LIVERY.secondary,
      printRun: model.printRun,
      features: model.features,
      variation: model.cardVariation,
      variantName: model.variant.kind === "base" ? null : model.variant.name,
      finish: model.finish,
      own: model.own !== undefined,
    };
  }
  if (!card) throw new Error("CardFace: pass a card or a model");
  const set = getSet(card.setId);
  const player = leadPlayer(card);
  const team = leadTeam(card);
  return {
    label: cardLabel(card),
    season: set.season,
    setName: set.name,
    cardNumber: card.cardNumber,
    playerName: player.name,
    initials: playerInitials(player),
    teamName: team.name,
    primary: team.primary,
    secondary: team.secondary,
    printRun: card.printRun,
    features: card.features,
    variation: card.variation,
    variantName: card.variantPath.type !== "Base" ? card.variantPath.name : null,
    finish: card.finish,
    own: false,
  };
}

function frameBackground(face: Face, primary: string): string {
  const { kind, tint } = face.finish;
  if (kind === "gold" || kind === "superfractor") return GOLD_FRAME;
  if (kind === "foil" && tint) {
    return `linear-gradient(135deg, ${tint} 0%, #ffffff 30%, ${tint} 55%, #ffffff 80%, ${tint} 100%)`;
  }
  if (kind === "refractor" && tint) return tint;
  return primary;
}

export default function CardFace({
  card,
  model,
  size = "md",
  state = "owned",
  empty = false,
  serial,
  label,
  className = "",
  photo,
}: CardFaceProps) {
  const theirs = useCardImage(photo || empty ? undefined : model?.id);
  const picture = (photo ?? theirs)?.front ?? (photo ?? theirs)?.back;
  const face = faceOf(card, model);
  const run = face.printRun === null ? null : face.printRun === 1 ? "1/1" : `/${face.printRun}`;
  const compact = size === "sm";

  const baseName = label ?? face.label;

  if (empty) {
    return (
      <EmptySleeve
        size={size}
        label={`${baseName}, empty pocket`}
        ghost={`#${face.cardNumber}`}
        caption={compact ? undefined : face.playerName}
        className={className}
      />
    );
  }

  const need = state === "need";
  const accessibleName = [
    baseName,
    face.own ? "unlisted, not in the NeonBinder catalog" : null,
    serial ? `serial ${serial}` : null,
    need ? "need" : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (picture) {
    return (
      <div
        role="img"
        aria-label={accessibleName}
        className={`nb-card relative shrink-0 select-none overflow-hidden ${className}`}
        style={{
          width: WIDTH[size],
          aspectRatio: "5 / 7",
          containerType: "inline-size",
          borderRadius: cq(5),
          background: "#0b0f1a",
          boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
        }}
      >
        <img
          src={picture.thumbUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          className="absolute inset-0 h-full w-full object-contain"
          style={{ filter: need ? "grayscale(0.9) brightness(0.5)" : undefined }}
        />
        {serial && (
          <span
            aria-hidden="true"
            className="absolute font-bold tabular-nums"
            style={{
              right: cq(4),
              bottom: cq(4),
              fontSize: cq(compact ? 10 : 7.5),
              padding: `${cq(0.8)} ${cq(2.2)}`,
              borderRadius: cq(1.5),
              background: "rgba(0,0,0,0.78)",
              color: "#F5D77A",
              lineHeight: 1.15,
            }}
          >
            {serial}
          </span>
        )}
      </div>
    );
  }

  const primary = face.primary;
  const secondary = face.secondary;
  const bandInk = inkOn(secondary);
  const initialsInk = inkOn(primary);
  const darkPhoto = initialsInk === "#FFFFFF";
  const stamp = serial ?? run;
  const isOneOfOne = face.printRun === 1;
  const finish = face.finish.kind;

  const rootStyle: CSSProperties = {
    width: WIDTH[size],
    aspectRatio: "5 / 7",
    containerType: "inline-size",
  };

  return (
    <div
      role="img"
      aria-label={accessibleName}
      className={`nb-card relative shrink-0 select-none ${className}`}
      style={rootStyle}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 flex"
        style={{
          padding: cq(3.5),
          borderRadius: cq(5),
          background: frameBackground(face, primary),
          boxShadow: "0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 18px rgba(0,0,0,0.45)",
          filter: need ? "grayscale(0.9) brightness(0.5)" : undefined,
        }}
      >
        <div
          className="relative flex flex-1 flex-col overflow-hidden"
          style={{ borderRadius: cq(3), background: "#0b0f1a" }}
        >
          {/* Photo window: pinstripes in the livery, a soft key light. */}
          <div
            className="relative flex-1 overflow-hidden"
            style={{
              backgroundImage: [
                "radial-gradient(circle at 50% 32%, rgba(255,255,255,0.22), transparent 62%)",
                `repeating-linear-gradient(135deg, ${primary} 0 ${cq(7)}, ${secondary} ${cq(7)} ${cq(9)})`,
              ].join(", "),
            }}
          >
            {/* Top scrim so the corner type always reads. */}
            <div
              className="absolute inset-x-0 top-0"
              style={{
                height: cq(22),
                background: "linear-gradient(rgba(0,0,0,0.6), transparent)",
              }}
            />
            <div
              className="absolute flex items-start"
              style={{ left: cq(5), right: cq(4), top: cq(3.5), gap: cq(2) }}
            >
              {!compact && (
                <span
                  className="nb-card-ink min-w-0 flex-1 truncate font-bold"
                  style={{ fontSize: cq(6.5), lineHeight: 1.1, paddingTop: cq(1) }}
                >
                  {face.season} {face.setName}
                </span>
              )}
              <span
                className="nb-card-ink ml-auto shrink-0 font-bold tabular-nums"
                style={{
                  fontSize: cq(compact ? 11 : 8),
                  padding: `${cq(0.8)} ${cq(2.4)}`,
                  borderRadius: cq(2),
                  background: "rgba(0,0,0,0.72)",
                  lineHeight: 1.15,
                }}
              >
                #{face.cardNumber}
              </span>
            </div>

            {/* The "photo": big initials in the team's ink. */}
            <span
              className="absolute inset-0 flex items-center justify-center font-bold"
              style={{
                fontSize: cq(34),
                letterSpacing: "-0.04em",
                color: initialsInk,
                opacity: 0.92,
                textShadow: darkPhoto
                  ? "0 0.04em 0 rgba(0,0,0,0.45)"
                  : "0 0.04em 0 rgba(255,255,255,0.4)",
              }}
            >
              {face.initials}
            </span>

            {face.features.includes("AU") && <Signature dark={darkPhoto} />}
            {face.features.includes("Relic") && <RelicSwatch primary={primary} secondary={secondary} />}

            <div
              className="absolute flex items-end"
              style={{ left: cq(4), bottom: cq(4), gap: cq(1.5) }}
            >
              {face.own && <Tag tone="own">{compact ? "U" : "Unlisted"}</Tag>}
              {face.features.includes("RC") && <Tag tone="rc">RC</Tag>}
              {face.features.includes("SP") && !compact && <Tag tone="plain">SP</Tag>}
            </div>

            {stamp && (
              <span
                className="absolute font-bold tabular-nums"
                style={{
                  right: cq(4),
                  bottom: cq(4),
                  fontSize: cq(compact ? 10 : 7.5),
                  padding: `${cq(0.8)} ${cq(2.2)}`,
                  borderRadius: cq(1.5),
                  background: isOneOfOne ? "#7f1d1d" : "rgba(0,0,0,0.78)",
                  color: "#F5D77A",
                  border: `${cq(0.7)} solid #F5D77A`,
                  lineHeight: 1.15,
                }}
              >
                {stamp}
              </span>
            )}
          </div>

          {/* Nameplate: slanted band in the secondary colour. */}
          <div
            className="relative flex flex-col justify-center"
            style={{
              background: secondary,
              color: bandInk,
              marginTop: cq(-5),
              padding: `${cq(compact ? 6 : 6.5)} ${cq(5)} ${cq(compact ? 3.5 : 4)}`,
              clipPath: "polygon(0 26%, 100% 0, 100% 100%, 0 100%)",
              minHeight: cq(compact ? 22 : 26),
            }}
          >
            <span
              className="block truncate font-bold"
              style={{ fontSize: cq(compact ? 11 : 9), lineHeight: 1.15 }}
            >
              {face.playerName}
            </span>
            {!compact && (
              <span
                className="block truncate"
                style={{ fontSize: cq(6.2), lineHeight: 1.2 }}
              >
                {face.teamName}
                {face.variation ? `, ${face.variation}` : ""}
                {face.variantName ? `, ${face.variantName}` : ""}
              </span>
            )}
          </div>

          {/* Finishes sit over everything printed. */}
          {(finish === "refractor" || finish === "superfractor") && (
            <>
              {face.finish.tint && (
                <div
                  className="absolute inset-0"
                  style={{ background: face.finish.tint, mixBlendMode: "overlay", opacity: 0.4 }}
                />
              )}
              <div className="nb-prism" />
            </>
          )}
          {finish === "superfractor" && <div className="nb-swirl" />}
          {finish !== "standard" && <div className="nb-sheen" />}
        </div>
      </div>

      {need && (
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 nb-card-need rounded-md border font-bold"
          style={{
            fontSize: cq(compact ? 13 : 9),
            padding: `${cq(1.5)} ${cq(4)}`,
            lineHeight: 1.2,
          }}
        >
          Need
        </span>
      )}
    </div>
  );
}

function Tag({ tone, children }: { tone: "rc" | "plain" | "own"; children: ReactNode }) {
  return (
    <span
      className="font-bold"
      style={{
        fontSize: cq(6.5),
        padding: `${cq(0.6)} ${cq(1.8)}`,
        borderRadius: cq(1.5),
        lineHeight: 1.15,
        background: tone === "rc" ? "#ffffff" : "rgba(0,0,0,0.78)",
        color: tone === "rc" ? "#000000" : tone === "own" ? "#7DD3FC" : "#ffffff",
        border:
          tone === "rc"
            ? `${cq(0.7)} solid #E0242B`
            : tone === "own"
              ? `${cq(0.7)} dashed #7DD3FC`
              : undefined,
      }}
    >
      {children}
    </span>
  );
}

/** A paint-pen autograph across the photo: silver on dark, blue on light. */
function Signature({ dark }: { dark: boolean }) {
  return (
    <svg
      className="absolute"
      style={{ left: "12%", right: "12%", bottom: "24%", width: "76%" }}
      viewBox="0 0 100 30"
      fill="none"
    >
      <path
        d="M4 22 C 12 4, 18 4, 20 18 S 30 26, 34 12 S 44 2, 46 16 C 48 26, 58 22, 62 10 S 74 6, 76 18 S 90 24, 96 8"
        stroke={dark ? "#E5E7EB" : "#1D3FBF"}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A jersey swatch in a window, for relic cards. */
function RelicSwatch({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <span
      className="absolute"
      style={{
        right: cq(5),
        top: "56%",
        width: cq(20),
        height: cq(20),
        borderRadius: cq(2),
        border: `${cq(1.2)} solid #f8fafc`,
        boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
        backgroundImage: `repeating-linear-gradient(45deg, ${primary} 0 ${cq(1.2)}, ${secondary} ${cq(1.2)} ${cq(1.8)}), repeating-linear-gradient(-45deg, rgba(0,0,0,0.25) 0 ${cq(1)}, transparent ${cq(1)} ${cq(2)})`,
        backgroundBlendMode: "multiply",
      }}
    />
  );
}

export interface EmptySleeveProps {
  size?: CardFaceSize;
  /** Accessible name, e.g. "Empty pocket 3 of 9". */
  label: string;
  /** Big ghost text in the middle, usually "#27". */
  ghost?: string;
  /** Small line under the ghost (md and up), e.g. the player still needed. */
  caption?: string;
  className?: string;
}

/** An empty nine-pocket sleeve: dashed outline, a ghost number, nothing else. */
export function EmptySleeve({
  size = "md",
  label,
  ghost,
  caption,
  className = "",
}: EmptySleeveProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className={`relative flex shrink-0 flex-col items-center justify-center border-2 border-dashed border-control bg-field/60 text-ink-3 ${className}`}
      style={{
        width: WIDTH[size],
        aspectRatio: "5 / 7",
        containerType: "inline-size",
        // Percentages, not cqw: a container's own cqw resolves against an
        // ancestor (here the viewport), which turned the sleeve into a pill.
        // 5% of the width across, the same length down a 5:7 card.
        borderRadius: "5% / 3.57%",
      }}
    >
      {ghost && (
        <span
          aria-hidden="true"
          className="font-bold tabular-nums"
          style={{ fontSize: cq(size === "sm" ? 22 : 18), lineHeight: 1 }}
        >
          {ghost}
        </span>
      )}
      {caption && (
        <span
          aria-hidden="true"
          className="mt-1 max-w-[85%] truncate text-center"
          style={{ fontSize: cq(7.5) }}
        >
          {caption}
        </span>
      )}
    </div>
  );
}
