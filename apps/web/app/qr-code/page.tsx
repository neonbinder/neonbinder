"use client";

import { useState, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "../../components/modules/NeonButton";
import {
  QrCodeSvg,
  BinderFinderPattern,
} from "../../components/modules/QrCode";
import {
  QrCodeIcon,
  ArrowDownTrayIcon,
  PrinterIcon,
} from "@heroicons/react/24/outline";


async function downloadSvgAsPng(
  svgElement: SVGSVGElement,
  filename: string,
  scale = 3,
) {
  // Clone the SVG and embed font CSS so text renders in the isolated blob context
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@700&family=Geist:wght@700&display=swap');`;
  clone.insertBefore(style, clone.firstChild);

  const svgData = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = svgElement.viewBox.baseVal.width * scale;
    canvas.height = svgElement.viewBox.baseVal.height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(pngBlob);
      a.download = `${filename}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };
  img.src = url;
}

function printSvg(svgElement: SVGSVGElement, title: string) {
  const svgData = new XMLSerializer().serializeToString(svgElement);
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@700&family=Geist:wght@700&display=swap" rel="stylesheet" />
      </head>
      <body style="margin:0;display:flex;justify-content:center;align-items:center;height:100vh">
        <div style="width:min(100vw,100vh);height:min(100vw,100vh)">${svgData}</div>
        <style>svg{width:100%;height:100%}@page{margin:0;size:auto}@media print{svg rect[fill="#00D558"],svg rect[fill="#00B7FF"]{fill:#000000!important}}</style>
      </body>
    </html>
  `);
  win.document.close();
  win.onload = () => {
    win.print();
    win.close();
  };
}

export default function QrCodePage() {
  const myProfile = useQuery(api.publicProfile.getMyPublicProfile);
  const [amount, setAmount] = useState("");
  const [generatedAmount, setGeneratedAmount] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const handleGenerate = useCallback(() => {
    if (!myProfile?.username || !amount) return;

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 9999.99)
      return;

    const formatted =
      parsedAmount % 1 === 0
        ? parsedAmount.toString()
        : parsedAmount.toFixed(2);
    const url = `https://neonbinder.io/u/${myProfile.username}/sale?amt=${formatted}`;

    setGeneratedAmount(formatted);
    setGeneratedUrl(url);
  }, [myProfile?.username, amount]);

  const handleDownload = () => {
    if (!svgRef.current || !generatedAmount) return;
    downloadSvgAsPng(svgRef.current, `neonbinder-qr-${generatedAmount}`);
  };

  const handlePrint = () => {
    if (!svgRef.current || !generatedAmount) return;
    printSvg(svgRef.current, `NeonBinder QR - $${generatedAmount}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleGenerate();
  };

  const isValidAmount =
    amount !== "" &&
    !isNaN(parseFloat(amount)) &&
    parseFloat(amount) > 0 &&
    parseFloat(amount) <= 9999.99;

  // Profile still loading
  if (myProfile === undefined) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // No public profile set up
  if (myProfile === null) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <QrCodeIcon className="w-20 h-20 text-neon-pink mb-6" />
        <h1 className="text-3xl font-bold mb-3">QR Code Generator</h1>
        <p className="text-gray-400 max-w-md mb-6">
          Set up your public profile first to generate sale QR codes.
        </p>
        <a href="/profile">
          <NeonButton>Go to Profile</NeonButton>
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-8 py-12 px-4">
      <div className="text-center">
        <QrCodeIcon className="w-16 h-16 text-neon-green mx-auto mb-4" />
        <div className="flex items-center justify-center gap-3 mb-2">
          <h1 className="text-3xl font-bold">QR Code Generator</h1>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-neon-green/15 text-neon-green border border-neon-green/30">
            Free During Beta
          </span>
        </div>
        <p className="text-gray-400 max-w-md">
          Generate QR codes for in-person card sales. Buyers scan to add items
          to their running total.
        </p>
      </div>

      {/* Amount input */}
      <div className="w-full max-w-xs">
        <label
          htmlFor="amount"
          className="block text-sm font-medium text-gray-300 mb-2"
        >
          Sale Amount
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg font-bold">
            $
          </span>
          <input
            id="amount"
            type="number"
            step="0.01"
            min="0.01"
            max="9999.99"
            placeholder="10.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full pl-8 pr-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white text-lg font-bold placeholder-gray-600 focus:outline-none focus:border-neon-green focus:ring-1 focus:ring-neon-green/30 transition-colors"
          />
        </div>
      </div>

      {/* Generate button */}
      <NeonButton
        disabled={!isValidAmount}
        onClick={handleGenerate}
        size="3"
      >
        Generate QR Code
      </NeonButton>

      {/* QR Code display */}
      {generatedUrl && generatedAmount && (
        <div className="flex flex-col items-center gap-6">
          <div
            className="rounded-2xl p-4 bg-white border border-neon-green/30"
            style={{ boxShadow: "0 0 20px rgba(0, 213, 88, 0.15)" }}
          >
            <QrCodeSvg
              ref={svgRef}
              data={generatedUrl}
              size={800}
              centerText={generatedAmount}
              dotShape="star"
              dotScale={0.85}
              finderPattern={BinderFinderPattern}
              className="w-[280px] h-[280px]"
            />
          </div>

          <p className="text-xs text-gray-500 break-all max-w-xs text-center">
            {generatedUrl}
          </p>

          <div className="flex gap-3">
            <NeonButton secondary onClick={handleDownload} size="3">
              <ArrowDownTrayIcon className="w-5 h-5 mr-2" />
              Download
            </NeonButton>
            <NeonButton onClick={handlePrint} size="3">
              <PrinterIcon className="w-5 h-5 mr-2" />
              Print
            </NeonButton>
          </div>
        </div>
      )}
    </div>
  );
}
