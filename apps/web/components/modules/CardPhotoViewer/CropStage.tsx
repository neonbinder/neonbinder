/**
 * NEO-481 — the crop stage: the source picture turned by the edit's quarter
 * turns, with a crop box over it that moves, resizes and spins a full circle.
 *
 * Pointer: drag inside the box to move it, a corner to resize it (the
 * opposite corner stays put), the round handle above its top edge to spin it;
 * two fingers on the stage spin and resize it together. Keyboard: the box is
 * one focusable group named "Crop box" (its instructions are its
 * description). The viewer's visible step buttons do the same steps, so
 * nothing here needs a drag (WCAG 2.1.1, 2.5.7).
 *
 * Every change goes through `clampCrop`, so the box never leaves its source;
 * on a stored photo that is what makes a crop a trim. `touch-action: none`
 * is on this stage only, so the page still scrolls everywhere else.
 */

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  angleToward,
  normalizeAngle,
  clampCrop,
  cropCorners,
  dragCorner,
  moveCropTo,
  nudgeCrop,
  RESIZE_STEP,
  resizeCrop,
  rotatePoint,
  tiltCrop,
  turnedSize,
  turnTransform,
  wholeFrame,
  type PhotoCrop,
  type Point,
  type QuarterTurns,
} from "@/lib/photo-edit/geometry";

/** The keys the box answers, and what each does. Exported for the viewer's tests and its help line. */
export function cropKeyStep(key: string, shift: boolean): ((crop: PhotoCrop, turns: QuarterTurns) => PhotoCrop) | null {
  switch (key) {
    case "ArrowLeft":
      return (c, t) => nudgeCrop(c, -1, 0, t, shift);
    case "ArrowRight":
      return (c, t) => nudgeCrop(c, 1, 0, t, shift);
    case "ArrowUp":
      return (c, t) => nudgeCrop(c, 0, -1, t, shift);
    case "ArrowDown":
      return (c, t) => nudgeCrop(c, 0, 1, t, shift);
    case "+":
    case "=":
      return (c) => resizeCrop(c, RESIZE_STEP);
    case "-":
    case "_":
      return (c) => resizeCrop(c, 1 / RESIZE_STEP);
    // Shift+comma is "<" and Shift+period ">" on most layouts; both spellings count.
    case ",":
      return (c) => tiltCrop(c, shift ? -15 : -1);
    case "<":
      return (c) => tiltCrop(c, -15);
    case ".":
      return (c) => tiltCrop(c, shift ? 15 : 1);
    case ">":
      return (c) => tiltCrop(c, 15);
    default:
      return null;
  }
}

/** Screen pixels for a handle's dot and its touch target (44 px across). */
const DOT = 7;
const HIT = 22;
/** How far the spin handle sits above the box's top edge, in screen pixels. */
const STEM = 34;

type Drag =
  | { kind: "move"; from: Point; start: PhotoCrop }
  | { kind: "corner"; corner: number }
  | { kind: "spin"; below: boolean }
  | { kind: "pinch"; start: PhotoCrop; angle: number; dist: number };

export default function CropStage({
  sourceUrl,
  srcW,
  srcH,
  turns,
  crop,
  onChange,
  instructionsId,
  boxLabel = "Crop box",
}: {
  sourceUrl: string;
  srcW: number;
  srcH: number;
  turns: QuarterTurns;
  /** The box; null = the whole frame. */
  crop: PhotoCrop | null;
  onChange: (crop: PhotoCrop) => void;
  /** The help text's id: the box's description. */
  instructionsId: string;
  boxLabel?: string;
}) {
  const box = crop ?? wholeFrame(srcW, srcH);
  const shown = turnedSize(turns, srcW, srcH);
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const [scale, setScale] = useState(() => 600 / Math.max(shown.w, shown.h));
  const [focused, setFocused] = useState(false);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, Point>());

  // Screen pixels per source pixel, so handles keep their size at any zoom.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const s = Math.min(svg.clientWidth / shown.w, svg.clientHeight / shown.h);
      if (s > 0 && Number.isFinite(s)) setScale(s);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [shown.w, shown.h]);

  /** A pointer's place in source pixels. */
  const toSource = useCallback((clientX: number, clientY: number): Point | null => {
    const g = groupRef.current;
    const svg = svgRef.current;
    const ctm = g?.getScreenCTM?.();
    if (!g || !svg || !ctm || typeof svg.createSVGPoint !== "function") return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const change = (next: PhotoCrop) => onChange(clampCrop(next));

  /** A pointer goes down: on a handle it starts that drag; a second finger anywhere starts a pinch. */
  const press = (e: PointerEvent<SVGElement>, d: Drag | null) => {
    svgRef.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = {
        kind: "pinch",
        start: box,
        angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
        dist: Math.hypot(b.x - a.x, b.y - a.y),
      };
    } else if (d) {
      drag.current = d;
    }
  };

  const begin = (e: PointerEvent<SVGElement>, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    press(e, d);
  };

  const onStageDown = (e: PointerEvent<SVGSVGElement>) => press(e, null);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      // Quarter turns keep angles, so a twist on screen is the same twist in the source.
      const spun = tiltCrop(d.start, Math.round(angle - d.angle));
      change(resizeCrop(spun, d.dist > 0 ? dist / d.dist : 1));
      return;
    }
    const p = toSource(e.clientX, e.clientY);
    if (!p) return;
    if (d.kind === "move") change(moveCropTo(d.start, { x: d.start.cx + p.x - d.from.x, y: d.start.cy + p.y - d.from.y }));
    else if (d.kind === "corner") change(dragCorner(box, d.corner, p));
    // A handle below the box points its bottom edge at the pointer: half a turn from the top's answer.
    else change({ ...box, angle: d.below ? normalizeAngle(angleToward(box, p) + 180) : angleToward(box, p) });
  };

  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0 || drag.current?.kind === "pinch") drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = cropKeyStep(e.key, e.shiftKey);
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    change(step(box, turns));
  };

  const corners = cropCorners(box);
  const poly = corners.map((p) => `${p.x},${p.y}`).join(" ");
  const u = 1 / scale;
  const up = rotatePoint({ x: 0, y: -1 }, box.angle);
  const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
  const bottomMid = { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 };
  // The spin handle sits above the box's top edge, or below its bottom when above would leave the picture.
  const above = { x: topMid.x + up.x * STEM * u, y: topMid.y + up.y * STEM * u };
  const inFrame = (p: Point) => p.x >= 0 && p.y >= 0 && p.x <= srcW && p.y <= srcH;
  const below = !inFrame(above);
  const stemFrom = below ? bottomMid : topMid;
  const knob = below ? { x: bottomMid.x - up.x * STEM * u, y: bottomMid.y - up.y * STEM * u } : above;
  const along = (t: number, a: Point, b: Point) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const thirds = [1 / 3, 2 / 3].flatMap((t) => [
    [along(t, corners[0], corners[1]), along(t, corners[3], corners[2])],
    [along(t, corners[0], corners[3]), along(t, corners[1], corners[2])],
  ]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${shown.w} ${shown.h}`}
      preserveAspectRatio="xMidYMid meet"
      // The picture is drawing, not content: the crop box group inside is what a screen reader meets.
      role="presentation"
      className="absolute inset-4 block h-[calc(100%-2rem)] w-[calc(100%-2rem)] touch-none select-none"
      overflow="visible"
      onPointerDown={onStageDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      data-crop-stage=""
    >
      <g ref={groupRef} transform={turnTransform(turns, srcW, srcH)}>
        <image href={sourceUrl} width={srcW} height={srcH} preserveAspectRatio="none" />
        {/* What the crop leaves out, dimmed. */}
        <path
          d={`M0 0H${srcW}V${srcH}H0Z M${poly.replace(/ /g, " L")}Z`}
          fillRule="evenodd"
          className="fill-scrim"
          aria-hidden="true"
          pointerEvents="none"
        />
        <g
          role="group"
          aria-label={boxLabel}
          aria-describedby={instructionsId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="outline-none"
          data-crop-box=""
        >
          {thirds.map(([a, b], i) => (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="stroke-neon-green-text/60"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
          {/* The body: drag to move. A halo first, so the neon line reads on any photo. */}
          <polygon
            points={poly}
            className="cursor-move fill-transparent stroke-background"
            strokeWidth={5}
            vectorEffect="non-scaling-stroke"
            onPointerDown={(e) => {
              const p = toSource(e.clientX, e.clientY);
              if (p) begin(e, { kind: "move", from: p, start: box });
            }}
          />
          <polygon
            points={poly}
            className="fill-none stroke-neon-green"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {focused && (
            <polygon
              points={poly}
              className="fill-none stroke-focus"
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
              transform={`translate(${box.cx} ${box.cy}) scale(1.03) translate(${-box.cx} ${-box.cy})`}
              pointerEvents="none"
            />
          )}
          <line
            x1={stemFrom.x}
            y1={stemFrom.y}
            x2={knob.x}
            y2={knob.y}
            className="stroke-neon-green"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {corners.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={DOT * u} className="fill-neon-green stroke-background" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
              <circle
                cx={p.x}
                cy={p.y}
                r={HIT * u}
                className="cursor-crosshair fill-transparent"
                onPointerDown={(e) => begin(e, { kind: "corner", corner: i })}
                data-crop-corner={i}
              />
            </g>
          ))}
          <circle cx={knob.x} cy={knob.y} r={(DOT + 2) * u} className="fill-neon-green stroke-background" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <circle
            cx={knob.x}
            cy={knob.y}
            r={HIT * u}
            className="cursor-grab fill-transparent"
            onPointerDown={(e) => begin(e, { kind: "spin", below })}
            data-crop-spin=""
          />
        </g>
      </g>
    </svg>
  );
}
