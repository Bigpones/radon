"use client";

/**
 * Resize a user-selected image to a centred square data URL, client-side.
 *
 * Draws the largest centred square crop of the source onto a `dim`×`dim`
 * canvas and exports it as WebP (falls back to JPEG when WebP is unavailable)
 * at quality 0.85. Keeping the work on the client means the avatar never
 * touches the server larger than the 256-byte-bounded payload the API accepts.
 */
export async function resizeImageToSquareDataUrl(file: File, dim: number): Promise<string> {
  const bitmap = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, dim, dim);

  const webp = canvas.toDataURL("image/webp", 0.85);
  if (webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/jpeg", 0.85);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}
