// Uploaded images: a coin's logo. The type is sniffed from the bytes, never taken from the upload's
// content type, and the image is served back with that sniffed type from GET /api/images/:id.
import { eq } from 'drizzle-orm';
import { IMAGE_MAX_BYTES, type ImageType, type ImageUploadResponse } from '@vantra/shared';
import type { CoreDeps, StoredImage } from '../core/interfaces.js';
import { images } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { newImageId } from '../lib/ids.js';

/** The image format `bytes` really are, from their magic numbers; null for anything else (SVG included). */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, sig: readonly number[]) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';                                   // "GIF8"
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'; // "RIFF"…"WEBP"
  return null;
}

export async function uploadImage(deps: CoreDeps, ownerId: string, bytes: Buffer): Promise<ImageUploadResponse> {
  if (bytes.length === 0) throw badRequest('The image is empty');
  if (bytes.length > IMAGE_MAX_BYTES) throw badRequest(`The image must be at most ${IMAGE_MAX_BYTES / (1024 * 1024)} MB`);
  const contentType = sniffImageType(bytes);
  if (!contentType) throw badRequest('Upload a PNG, JPEG, WebP or GIF image', 'UNSUPPORTED_IMAGE');
  const id = newImageId();
  await deps.db.insert(images).values({ id, ownerId, contentType, bytes, createdAt: deps.clock.now() });
  return { id, url: `${deps.config.apiUrl}/api/images/${id}` };
}

export async function loadImage(deps: CoreDeps, id: string): Promise<StoredImage | null> {
  const [row] = await deps.db.select({ contentType: images.contentType, bytes: images.bytes }).from(images).where(eq(images.id, id));
  return row ?? null;
}

/** The public URL of an image `ownerId` uploaded. Someone else's image, or none, is refused. */
export async function ownedImageUrl(deps: CoreDeps, ownerId: string, id: string): Promise<string> {
  const [row] = await deps.db.select({ ownerId: images.ownerId }).from(images).where(eq(images.id, id));
  if (!row || row.ownerId !== ownerId) throw badRequest('That logo upload was not found; upload it again', 'IMAGE_NOT_FOUND');
  return `${deps.config.apiUrl}/api/images/${id}`;
}
