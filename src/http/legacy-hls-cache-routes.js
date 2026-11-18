import path from 'node:path';
import { clrTrim } from '../metadata/whitespace.js';
import { requestPath } from '../network/http-request.js';
import { existingHlsCacheDirectory, hasLegacyHlsPlaylist, openLegacyHlsArtifact } from '../playback/legacy-hls-cache.js';
import { BindingError, HttpResult } from './binding.js';
import { binaryStreamResult } from './binary-result.js';
import { getMimeType } from './mime-types.js';

const leaf = /^[a-z0-9_-][a-z0-9._-]*$/iu;
const videoExtensions = new Set(['.ts', '.mp4']);
const invalidSegment = () => new HttpResult(400, 'Invalid segment.');
const missingSegment = () => new HttpResult(404, 'Hls segment not found.');

function requireRouteValues(params) {
  for (const [key, value] of Object.entries(params)) {
    if (!clrTrim(value)) throw new BindingError(key, `The ${key} field is required.`);
  }
}

export function registerLegacyHlsCacheRoutes(add, { encodingPaths }) {
  const cacheDirectory = async () => existingHlsCacheDirectory(await encodingPaths?.getTranscodePath({ create: false }));
  const artifact = (directory, name) => binaryStreamResult(options => openLegacyHlsArtifact(directory, name, options),
    { physicalFile: true, contentType: getMimeType(name) });
  const extension = request => path.extname(requestPath(request).replace(/\/$/u, ''));
  add('GET', ['/Audio/{itemId}/hls/{segmentId}/stream.mp3', '/Audio/{itemId}/hls/{segmentId}/stream.aac'],
    async ({ params, request }) => {
      requireRouteValues(params);
      if (!leaf.test(params.segmentId)) return invalidSegment();
      return artifact(await cacheDirectory(), params.segmentId + extension(request));
    }, { public: true });
  add('GET', '/Videos/{itemId}/hls/{playlistId}/stream.m3u8', async ({ params, request }) => {
    requireRouteValues(params);
    if (!leaf.test(params.playlistId)) return invalidSegment();
    return artifact(await cacheDirectory(), params.playlistId + extension(request));
  });
  add('GET', '/Videos/{itemId}/hls/{playlistId}/{segmentId}.{segmentContainer}', async ({ params, signal }) => {
    requireRouteValues(params);
    const { playlistId, segmentId, segmentContainer } = params;
    if (!leaf.test(playlistId) || !leaf.test(segmentId)) return invalidSegment();
    const fileExtension = '.' + segmentContainer;
    if (!videoExtensions.has(fileExtension.toLowerCase())) return missingSegment();
    const directory = await cacheDirectory();
    return await hasLegacyHlsPlaylist(directory, playlistId, fileExtension, signal)
      ? artifact(directory, segmentId + fileExtension) : missingSegment();
  }, { public: true });
}
