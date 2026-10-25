import { MetadataImageAssets, imagePathApi } from '../metadata/image-assets.js';
import { md5Guid } from '../core/identity.js';
import { utcTicks } from '../syncplay/time.js';
import { dateTicks, dtoId, libraryError } from './records.js';
import { readChannelItemResult, writeChannelItemResult, channelItemProviderResult } from './channel-item-data.js';

const cacheLength = 108000000000n;
const ioError = error => ['not-found', 'ENOENT', 'not-directory', 'ENOTDIR', 'is-directory', 'EISDIR', 'EIO', 'io', 'io-error',
  'EMFILE', 'ENFILE', 'EBUSY', 'ENOSPC', 'EDQUOT', 'EPIPE', 'ECONNRESET', 'ENAMETOOLONG'].includes(error.code);
async function waitForLock(previous, signal) {
  if (!signal) return previous;
  signal.throwIfAborted();
  let abort;
  try { await Promise.race([previous, new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

export function channelDataCachePath({ cachePath, channelId, dataVersion, userCacheKey, externalFolderId, sortField = null, sortDescending = false }) {
  let filename = externalFolderId == null || externalFolderId === '' ? 'root' : md5Guid(externalFolderId);
  filename += userCacheKey ?? '';
  if (sortField != null) filename += '-sortField-' + sortField;
  if (sortDescending) filename += '-sortDescending';
  return imagePathApi(cachePath).join(cachePath, 'channels', dtoId(channelId), md5Guid((dataVersion ?? '') + '2'), md5Guid(filename) + '.json');
}

/** ChannelManager has one lock for the complete installed inventory. A cache
 * hit is a sentinel: it skips provider calls, materialization and dead cleanup. */
export class ChannelItemCache {
  #tail = Promise.resolve();
  #operations = new Set();
  #closing;
  constructor(options) {
    const { cachePath, fileSystem, getChannelId, now = utcTicks, onError = () => {} } = options;
    if (typeof cachePath !== 'string' || !cachePath || !fileSystem || typeof getChannelId !== 'function') {
      throw new TypeError('Channel caching requires the application cache root and mapped filesystem.');
    }
    Object.assign(this, { getChannelId, now, onError, fileSystem, pathOptions: options });
  }
  get cachePath() { return this.pathOptions.cachePath; }
  get(provider, user, externalFolderId, { signal } = {}) {
    if (this.#closing) return Promise.reject(libraryError(503, 'Channel item cache is closing.'));
    const pending = Promise.resolve().then(() => this.#get(provider, user, externalFolderId, signal)); this.#operations.add(pending);
    const done = () => this.#operations.delete(pending); void pending.then(done, done); return pending;
  }
  async #fresh(assets, filename, signal) {
    try {
      const info = await assets.stat(filename);
      if (dateTicks(info.modified) + cacheLength <= this.now()) return false;
      const bytes = await assets.read(filename, { signal });
      return readChannelItemResult(bytes) !== null;
    } catch (error) { if (ioError(error)) return false; throw error; }
  }
  async #get(provider, user, externalFolderId, signal) {
    const cachePath = this.cachePath, assets = new MetadataImageAssets({ fileSystem: this.fileSystem, stateRoots: [cachePath] });
    const userId = user ? dtoId(user.Id) : null;
    const userCacheKey = provider.getCacheKey ? await provider.getCacheKey(userId) : '';
    const filename = channelDataCachePath({ cachePath, channelId: this.getChannelId(provider), dataVersion: provider.dataVersion,
      userCacheKey, externalFolderId });
    if (await this.#fresh(assets, filename, signal)) return null;
    const previous = this.#tail, completion = Promise.withResolvers(); this.#tail = previous.then(() => completion.promise);
    try {
      await waitForLock(previous, signal);
      signal?.throwIfAborted();
      if (await this.#fresh(assets, filename, signal)) return null;
      const result = channelItemProviderResult(await provider.getChannelItems({ UserId: userId ?? '0'.repeat(32), FolderId: externalFolderId,
        StartIndex: null, Limit: null, SortBy: null, SortDescending: false }, { signal }));
      if (result == null) throw libraryError(500, 'Channel returned a null result from GetChannelItems');
      try { await assets.write(filename, writeChannelItemResult(result)); }
      catch (error) { try { void Promise.resolve(this.onError(error, 'Error writing to channel cache file: ' + filename)).catch(() => {}); } catch { /* Native logging does not replace the provider result. */ } }
      return result;
    } finally { completion.resolve(); }
  }
  close() {
    return this.#closing ??= (async () => { while (this.#operations.size) await Promise.allSettled([...this.#operations]); await this.#tail; })();
  }
}
