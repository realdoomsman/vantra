// Uploaded images: a coin's logo. POST takes the raw image as the body (the browser sends the file with
// its image content type), so no multipart parser is involved; the parser lives in this plugin's own
// scope, so no other route accepts an image body. GET is public: the URL is written into Pons for good.
import type { FastifyInstance } from 'fastify';
import { IMAGE_MAX_BYTES, IMAGE_TYPES, type ImageUploadResponse } from '@vantra/shared';
import type { Deps } from '../../core/interfaces.js';
import { notFound } from '../../lib/errors.js';
import { isId } from '../../lib/ids.js';
import { ownerIdOf, sessionRateKey, type Auth } from '../auth.js';
import { servicesOf } from '../context.js';
import { idParams } from '../validate.js';

export const IMAGE_RATE_LIMIT = { max: 30, timeWindow: '1 hour', keyGenerator: sessionRateKey } as const;

export async function imageRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser([...IMAGE_TYPES], { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    scope.post(
      '/api/images',
      { preHandler: [auth.requireAuth], bodyLimit: IMAGE_MAX_BYTES, config: { rateLimit: IMAGE_RATE_LIMIT } },
      async (request, reply): Promise<ImageUploadResponse> => {
        const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        return reply.status(201).send(await servicesOf(deps).uploadImage(ownerIdOf(request), bytes));
      },
    );

    scope.get('/api/images/:id', async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const image = isId(id, 'im') ? await servicesOf(deps).image(id) : null;
      if (!image) throw notFound('Image');
      // Immutable: an id is never reused and an image is never edited. Other sites (Pons, explorers) embed it.
      return reply
        .header('content-type', image.contentType)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(image.bytes);
    });
  });
}
