// Turns a picked photo into a coin logo before it is uploaded: centre-cropped to a square, at most
// LOGO_PX on a side, re-encoded by the browser. A multi-megabyte phone photo comes out far under the
// server's limit, and re-encoding drops its EXIF block — GPS position included.
export const LOGO_PX = 512;

/** Formats that may carry transparency stay PNG; everything else (camera photos) becomes JPEG. */
const KEEPS_ALPHA = ['image/png', 'image/webp', 'image/gif'];

export async function squareLogo(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This browser cannot read that file as an image. Pick a PNG, JPEG, WebP or GIF.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(LOGO_PX, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const type = KEEPS_ALPHA.includes(file.type) ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  if (!blob) throw new Error('Could not process that image.');
  return blob;
}
