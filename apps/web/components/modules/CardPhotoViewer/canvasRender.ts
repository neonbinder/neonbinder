/**
 * NEO-481 — an edit drawn in the browser, for the demo only. Real photos are
 * rendered by the preprocess service, never here (iOS Safari cannot draw a
 * 64 MP scan, and a canvas drops the colour profile). The demo's pictures are
 * already 1600 px and live only on the page, so a canvas is enough.
 */

import { COPY_PHOTO_LONG_EDGE, COPY_PHOTO_THUMB_EDGE } from "@/lib/collection/copy-photo-resize";
import { effectiveCrop, normalizeAngle, outputSize, thumbnailSize, type PhotoEdit } from "@/lib/photo-edit/geometry";

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That photo didn't load."));
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("That edit didn't take. Try again."))), "image/jpeg", 0.9),
  );
}

function draw(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't edit photos.");
  ctx.imageSmoothingQuality = "high";
  paint(ctx);
  return canvas;
}

/** The edit of the picture at `url`, fitted to 1600 and 360 like a kept photo. */
export async function renderEdit(url: string, edit: PhotoEdit): Promise<{ image: Blob; thumb: Blob }> {
  const img = await load(url);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const crop = effectiveCrop(edit, srcW, srcH);
  const out = outputSize(edit, srcW, srcH);
  const full = draw(out.w, out.h, (ctx) => {
    ctx.translate(out.w / 2, out.h / 2);
    ctx.rotate((normalizeAngle(edit.turns * 90 - crop.angle) * Math.PI) / 180);
    ctx.drawImage(img, -crop.cx, -crop.cy);
  });
  const imageSize = thumbnailSize(out.w, out.h, COPY_PHOTO_LONG_EDGE);
  const image = draw(imageSize.w, imageSize.h, (ctx) => ctx.drawImage(full, 0, 0, imageSize.w, imageSize.h));
  const thumbSize = thumbnailSize(imageSize.w, imageSize.h, COPY_PHOTO_THUMB_EDGE);
  const thumb = draw(thumbSize.w, thumbSize.h, (ctx) => ctx.drawImage(image, 0, 0, thumbSize.w, thumbSize.h));
  return { image: await toBlob(image), thumb: await toBlob(thumb) };
}
