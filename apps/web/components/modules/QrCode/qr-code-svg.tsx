"use client";

import { forwardRef, useMemo } from "react";
import qrcode from "qrcode-generator";
import type { DotShape, FinderPatternRenderer } from "./types";
import { DefaultFinderPattern } from "./finder-patterns";

interface QrCodeSvgProps {
  data: string;
  size?: number;
  margin?: number;
  dotShape?: DotShape;
  dotScale?: number;
  dotColor?: string;
  bgColor?: string;
  finderPattern?: FinderPatternRenderer;
  finderColor?: string;
  centerImage?: string;
  centerText?: string;
  centerImageSize?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  className?: string;
}

function isInFinderZone(
  row: number,
  col: number,
  moduleCount: number,
): boolean {
  // Each finder is 7×7 with a 1-module separator = 8 module zone
  if (row <= 7 && col <= 7) return true;
  if (row <= 7 && col >= moduleCount - 8) return true;
  if (row >= moduleCount - 8 && col <= 7) return true;
  return false;
}

function starPath(cx: number, cy: number, outerR: number): string {
  // 4-pointed star with concave sides
  const innerR = outerR * 0.45;
  const points: string[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4 - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  return `M${points.join("L")}Z`;
}

function diamondPath(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
}

function renderDot(
  cx: number,
  cy: number,
  cellSize: number,
  dotScale: number,
  shape: DotShape,
  color: string,
  key: string,
): React.ReactElement {
  const r = (cellSize * dotScale) / 2;

  switch (shape) {
    case "circle":
      return <circle key={key} cx={cx} cy={cy} r={r} fill={color} />;
    case "diamond":
      return <path key={key} d={diamondPath(cx, cy, r)} fill={color} />;
    case "star":
    default:
      return <path key={key} d={starPath(cx, cy, r)} fill={color} />;
  }
}

export const QrCodeSvg = forwardRef<SVGSVGElement, QrCodeSvgProps>(
  function QrCodeSvg(
    {
      data,
      size = 800,
      margin = 2,
      dotShape = "star",
      dotScale = 0.6,
      dotColor = "#000000",
      bgColor = "#FFFFFF",
      finderPattern: FinderPattern = DefaultFinderPattern,
      finderColor = "#000000",
      centerImage,
      centerText,
      centerImageSize = 0.3,
      errorCorrectionLevel = "H",
      className,
    },
    ref,
  ) {
    const { dots, finders, moduleCount, cellSize } = useMemo(() => {
      const qr = qrcode(0, errorCorrectionLevel);
      qr.addData(data);
      qr.make();

      const count = qr.getModuleCount();
      const totalModules = count + margin * 2;
      const cell = size / totalModules;

      // Center image exclusion zone
      const qrContentSize = count * cell;
      const centerZoneSize = qrContentSize * centerImageSize;
      const centerStart = margin * cell + (qrContentSize - centerZoneSize) / 2;
      const centerEnd = centerStart + centerZoneSize;

      const dotElements: React.ReactElement[] = [];

      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (!qr.isDark(row, col)) continue;
          if (isInFinderZone(row, col, count)) continue;

          const cx = (col + margin + 0.5) * cell;
          const cy = (row + margin + 0.5) * cell;

          // Skip dots under center content
          if (
            (centerImage || centerText) &&
            cx >= centerStart &&
            cx <= centerEnd &&
            cy >= centerStart &&
            cy <= centerEnd
          ) {
            continue;
          }

          dotElements.push(
            renderDot(cx, cy, cell, dotScale, dotShape, dotColor, `${row}-${col}`),
          );
        }
      }

      // Finder pattern positions (top-left corner of each 7×7 block)
      // Rotations point each finder inward toward the QR center
      const finderPositions = [
        { x: margin * cell, y: margin * cell, rotation: 0 },
        { x: (margin + count - 7) * cell, y: margin * cell, rotation: 0 },
        { x: margin * cell, y: (margin + count - 7) * cell, rotation: 0 },
      ];

      return {
        dots: dotElements,
        finders: finderPositions,
        moduleCount: count,
        cellSize: cell,
      };
    }, [data, size, margin, dotShape, dotScale, dotColor, centerImage, centerText, centerImageSize, errorCorrectionLevel]);

    // Center image geometry
    const qrContentSize = moduleCount * cellSize;
    const imgSize = qrContentSize * centerImageSize;
    const imgX = margin * cellSize + (qrContentSize - imgSize) / 2;
    const imgY = imgX;
    const imgPad = cellSize * 0.5;

    return (
      <svg
        ref={ref}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
        className={className}
      >
        <rect width={size} height={size} fill={bgColor} />
        <g>{dots}</g>
        {finders.map((pos, i) => (
          <FinderPattern
            key={i}
            x={pos.x}
            y={pos.y}
            size={cellSize * 7}
            cellSize={cellSize}
            color={finderColor}
            rotation={pos.rotation}
          />
        ))}
        {(centerImage || centerText) && (
          <g>
            <rect
              x={imgX - imgPad}
              y={imgY - imgPad}
              width={imgSize + imgPad * 2}
              height={imgSize + imgPad * 2}
              rx={cellSize * 0.4}
              fill={bgColor}
            />
            {centerImage && (
              <image
                href={centerImage}
                x={imgX}
                y={imgY}
                width={imgSize}
                height={imgSize}
              />
            )}
            {centerText && !centerImage && (() => {
              const digits = centerText.replace(/\D/g, "").length;
              const showDollar = digits <= 3;
              const dollarSize = digits <= 2 ? 0.4 : 0.3;
              const numberSize = digits <= 2 ? 0.57 : digits <= 3 ? 0.45 : 0.45;

              return (
                <text
                  x={size / 2}
                  y={size / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#000000"
                  fontFamily="Lexend, Geist, sans-serif"
                >
                  {showDollar && (
                    <tspan
                      fontSize={imgSize * dollarSize}
                      fontWeight="400"
                      dy="-0.05em"
                    >$</tspan>
                  )}
                  <tspan
                    fontSize={imgSize * numberSize}
                    fontWeight="700"
                  >{centerText}</tspan>
                </text>
              );
            })()}
          </g>
        )}
      </svg>
    );
  },
);
