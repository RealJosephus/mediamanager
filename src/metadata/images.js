import { imagePathApi, imageIdentityPath } from './image-assets.js';
import { imageSavePaths, internalImagePath, multipleImages, containingImageFolder } from './image-paths.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeDate } from '../sessions/user-data.js';
import { ImageProcessor } from '../images/processor.js';
import { normalizeProbeFileDate } from '../storage/probe-lifecycle.js';
import { dateTicks, MIN_DATE, nonemptyId } from '../library/records.js';
import { roundEven } from '../images/options.js';

const same = (a, b) => ordinalIgnoreCaseKey(a) === ordinalIgnoreCaseKey(b);
const remote = image => /^http/i.test(image.Path);
const conversionFailure = error => ['ArgumentException', 'InvalidOperationException', 'IOException', 'HttpRequestException'].includes(error.nativeException ?? error.name)
  || ['http-error', 'not-found', 'permission-denied', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(error.code);
const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.tbn', '.gif', '.svg'];
const singular = ['Primary', 'Art', 'Banner', 'Box', 'BoxRear', 'Disc', 'Logo', 'Menu', 'Thumb'];
const allImageTypes = [...singular, 'Backdrop', 'Screenshot', 'Chapter', 'Profile'];
const defaultImageOptions = {
  Movie: { Backdrop: [1, 1280], Art: [0, 0], Disc: [0, 0], Primary: [1, 0], Banner: [0, 0], Thumb: [1, 0], Logo: [1, 0] },
  MusicVideo: { Backdrop: [1, 1280], Art: [0, 0], Disc: [0, 0], Primary: [1, 0], Banner: [0, 0], Thumb: [1, 0], Logo: [1, 0] },
  Series: { Backdrop: [1, 1280], Art: [0, 0], Primary: [1, 0], Banner: [1, 0], Thumb: [1, 0], Logo: [1, 0] },
  MusicAlbum: { Backdrop: [0, 1280], Disc: [0, 0] },
  MusicArtist: { Backdrop: [1, 1280], Banner: [0, 0], Art: [0, 0], Logo: [1, 0] },
  BoxSet: { Backdrop: [1, 1280], Primary: [1, 0], Thumb: [1, 0], Logo: [1, 0], Art: [0, 0], Disc: [0, 0], Banner: [0, 0] },
  Season: { Backdrop: [0, 1280], Primary: [1, 0], Banner: [0, 0], Thumb: [0, 0] },
  Episode: { Backdrop: [0, 1280], Primary: [1, 0] },
};
const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.avif': 'image/avif' };
const modified = file => file.modified ? nativeDate(normalizeProbeFileDate(file.modified)) : '0001-01-01 00:00:00';
const isModified = (previous, current) => {
  const delta = dateTicks(previous ?? '0001-01-01 00:00:00') - dateTicks(modified(current));
  return (delta < 0n ? -delta : delta) > 10000000n;
};
const row = (file, Type) => ({ Path: file.Path, Type, DateModified: modified(file), Width: 0, Height: 0, Blurhash: null });
const remoteRow = (Path, Type) => ({ Path, Type, DateModified: '0001-01-01 00:00:00', Width: 0, Height: 0, Blurhash: null });
const emptyLanguage = value => value == null || value === '';
function imageOption(loaded, type) {
  const configured = loaded.libraryOptions?.TypeOptions?.find(value => value.Type === loaded.item.Type)?.ImageOptions?.find(value => value.Type === type);
  if (configured) return { limit: configured.Limit ?? 1, minWidth: configured.MinWidth ?? 0 };
  const fallback = defaultImageOptions[loaded.item.Type]?.[type] ?? [1, 0];
  return { limit: fallback[0], minWidth: fallback[1] };
}
function orderRemoteImages(images, requestedLanguage) {
  requestedLanguage = requestedLanguage?.trim() || 'en';
  const score = image => image.Language?.toLowerCase() === requestedLanguage.toLowerCase() ? 4
    : image.Language?.toLowerCase() === 'en' ? 3 : emptyLanguage(image.Language) ? 2 : 0;
  const rating = image => roundEven(Number(image.CommunityRating ?? 0) * 10) / 10;
  return [...images].sort((a, b) => score(b) - score(a) || rating(b) - rating(a) || Number(b.VoteCount ?? 0) - Number(a.VoteCount ?? 0));
}
function waitForDownload(task, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    const released = () => { signal.removeEventListener('abort', abort); resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    // A URL lock releases after either result. A waiting caller owns its next attempt.
    task.then(released, released);
  });
}

export function publishNativeImageInfos(item, images) {
  item.ImageInfos = images.map(image => ({ Path: image.Path, Type: image.Type,
    DateModified: image.DateModified ?? MIN_DATE, Width: image.Width ?? 0, Height: image.Height ?? 0,
    BlurHash: image.BlurHash ?? (image.Blurhash == null ? null : Buffer.from(image.Blurhash).toString('utf8')) }));
}

export class MetadataImages {
  #cache = new Map();
  #requests = new Map();
  #cacheTimer;
  #lifetime = new AbortController();
  constructor({ fetch = globalThis.fetch, now = () => Date.now(), logger = { error() {} }, processor = new ImageProcessor({ logger }) } = {}) { Object.assign(this, { fetch, now, logger, processor }); }
  get cacheEntryCount() { return this.#cache.size; }
  #expireCache() {
    clearTimeout(this.#cacheTimer); this.#cacheTimer = undefined;
    const now = this.now(); let expires = Infinity;
    for (const [url, entry] of this.#cache) {
      if (entry.expires <= now) this.#cache.delete(url);
      else expires = Math.min(expires, entry.expires);
    }
    if (expires !== Infinity && !this.#lifetime.signal.aborted) {
      this.#cacheTimer = setTimeout(() => this.#expireCache(), Math.max(1, expires - now));
      this.#cacheTimer.unref?.();
    }
  }
  async updateImages(loaded, images, { signal, forceUpdate = false, persistImages, markIrreversible } = {}) {
    // The native method freezes outdated image identities before converting
    // any URL. A nested independent save may refresh another pending image,
    // but that image must still be processed in this outer pass.
    const pending = [];
    for (const image of [...images]) {
      signal?.throwIfAborted();
      if (!image.Path) continue;
      if (forceUpdate || remote(image) || !image.Width || !image.Height || !image.Blurhash?.length) { pending.push(image); continue; }
      try { if (isModified(image.DateModified, await loaded.imageAssets.stat(image.Path, { signal }))) pending.push(image); }
      catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Cannot get image file information'); }
    }
    if (!pending.length) return false;
    // LibraryManager skips transient live TV records whose parent is also non-library content.
    const source = item => item.SourceType ?? (nonemptyId(item.ChannelId) ? 'Channel' : 'Library');
    const librarySource = item => source(item) === 'Library' || source(item) === 0;
    if (!librarySource(loaded.item) && loaded.parent && !librarySource(loaded.parent)) return false;
    let changed = false;
    for (const image of pending) {
      signal?.throwIfAborted(); if (!image.Path || !images.includes(image)) continue;
      let file;
      if (remote(image)) {
        const index = images.filter(value => value.Type === image.Type).indexOf(image); let fetched = false, unavailable = true;
        for (const url of image.Path.split('|')) {
          try {
            await this.saveRemote(loaded, images, { Type: image.Type, Url: url },
              { signal, index, beforeWrite: markIrreversible });
            fetched = true; changed = true; break;
          }
          catch (error) { if (signal?.aborted) throw error; if (error.code === 'http-error' && [403, 404].includes(error.status)) continue; unavailable = false; this.logger.error(error, 'Cannot fetch image'); break; }
        }
        if (!fetched && unavailable) { images.splice(images.indexOf(image), 1); changed = true; }
        if (fetched || unavailable) {
          try {
            if (loaded.onImageRemoteChange) markIrreversible?.();
            await loaded.onImageRemoteChange?.();
          }
          catch (error) {
            if (signal?.aborted || !conversionFailure(error)) throw error;
            // UpdateImagesAsync tolerates conversion/update I/O failures but
            // does not swallow unrelated database or metadata conflicts.
            this.logger.error(error, 'Cannot fetch image'); continue;
          }
        }
        if (!fetched || !images.includes(image)) continue;
      }
      try { file = await loaded.imageAssets.stat(image.Path, { signal }); }
      catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Cannot get image file information'); continue; }
      if (file.kind !== 'file') continue;
      const old = { Width: image.Width, Height: image.Height, Blurhash: image.Blurhash && Buffer.from(image.Blurhash).toString('utf8'), DateModified: image.DateModified };
      let bytes, size = { Width: image.Width ?? 0, Height: image.Height ?? 0 };
      try { bytes = await loaded.imageAssets.read(image.Path, { signal }); size = await this.processor.getImageSize(bytes, image.Path, { signal }); image.Width = size.Width; image.Height = size.Height; }
      catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Cannot get image dimensions'); image.Width = image.Height = 0; size = { Width: 0, Height: 0 }; }
      try { image.Blurhash = Buffer.from(bytes ? await this.processor.getImageBlurHash(bytes, image.Path, size, { signal }) : '', 'utf8'); }
      catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Cannot compute image BlurHash'); image.Blurhash = Buffer.alloc(0); }
      image.DateModified = modified(file);
      changed ||= old.Width !== image.Width || old.Height !== image.Height || old.Blurhash !== image.Blurhash.toString('utf8') || old.DateModified !== image.DateModified;
    }
    changed = await this.validate(images, loaded.imageAssets, signal) || changed;
    if (persistImages) {
      markIrreversible?.();
      await persistImages(images);
    }
    return changed;
  }
  updateReplaceImages(options, foundTypes) {
    if (!options || !foundTypes.length) return;
    if (options.ReplaceAllImages) {
      options.ReplaceAllImages = false;
      options.ReplaceImages = [...allImageTypes];
    }
    const found = new Set(foundTypes);
    options.ReplaceImages = (options.ReplaceImages ?? []).filter(type => !found.has(type));
  }
  async #cleanupEpisodeMetadataDirectory(loaded, signal) {
    const { item } = loaded;
    if (item.Type !== 'Episode' || item.IsVirtualItem || !item.Path) return;
    const api = imagePathApi(item.Path);
    const directory = api.join(containingImageFolder(item), 'metadata');
    try { await loaded.imageAssets.deleteEmptyDirectory(directory, { signal }); }
    catch (error) { if (error.code !== 'not-found') throw error; }
  }
  async removeForRefresh(loaded, images, signal) {
    let changed = false;
    const metadataKey = loaded.metadataPath && ordinalIgnoreCaseKey(internalImagePath(loaded.item, loaded.metadataPath));
    for (const image of [...images]) {
      if (![...singular, 'Backdrop'].includes(image.Type)) continue;
      const local = !remote(image);
      const removable = loaded.saveLocalMetadataEnabled || metadataKey && ordinalIgnoreCaseKey(image.Path).startsWith(metadataKey);
      if (!removable) continue;
      if (local) try { await loaded.imageAssets.delete(image.Path, { signal }); }
      catch (error) { if (!['not-found', 'invalid-path', 'unmapped-path', 'permission-denied'].includes(error.code)) throw error; }
      images.splice(images.indexOf(image), 1); changed = true;
    }
    await this.#cleanupEpisodeMetadataDirectory(loaded, signal);
    return changed;
  }
  async refreshRemoteProviders(loaded, images, providers, options = {}) {
    const { item } = loaded; const signal = options.signal;
    const replacing = type => options.ImageRefreshMode === 'FullRefresh' && Boolean(options.ReplaceAllImages || options.ReplaceImages?.includes(type));
    const oldBackdrops = replacing('Backdrop') ? images.filter(image => image.Type === 'Backdrop') : [];
    const backdropLimit = imageOption(loaded, 'Backdrop').limit + oldBackdrops.length;
    const downloaded = new Set(); let changed = false, failures = 0, errorMessage;
    const supportsDownload = !(item.Type === 'Episode' && item.IsMissingEpisode);
    const useStub = !item.IsFileProtocol || item.Type === 'Person' || item.Type === 'LiveTvProgram';
    const setStub = (type, url) => {
      const value = remoteRow(url, type);
      if (type === 'Backdrop') images.push(value);
      else {
        const old = images.find(image => image.Type === type);
        if (old) images[images.indexOf(old)] = value; else images.push(value);
      }
      changed = true;
    };
    for (const provider of providers) {
      try {
        signal?.throwIfAborted();
        if (!supportsDownload) continue;
        const supported = provider.imageTypes ?? [];
        if (!options.ReplaceAllImages && !(options.ReplaceImages?.length)) {
          const missingSingular = singular.some(type => supported.includes(type) && imageOption(loaded, type).limit > 0 && !images.some(image => image.Type === type));
          const missingBackdrops = supported.includes('Backdrop') && images.filter(image => image.Type === 'Backdrop').length < backdropLimit;
          if (!missingSingular && !missingBackdrops) continue;
        }
        let available = [];
        try { available = await provider.getImages(item, { ...loaded.context, signal }) ?? []; }
        catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw error;
          // ProviderManager.GetAvailableRemoteImages logs provider query failures and returns an empty list.
          this.logger.error(error, `${provider.name} failed while listing remote images`);
        }
        const list = orderRemoteImages(available, item.MetadataLanguage);
        for (const type of singular) {
          const setting = imageOption(loaded, type);
          if (!supported.includes(type) || setting.limit <= 0 || images.some(image => image.Type === type) && (!replacing(type) || downloaded.has(type))) continue;
          for (const image of list.filter(value => value.Type === type && (value.Width == null || value.Width >= setting.minWidth))) {
            if (useStub) setStub(type, image.Url);
            else {
              try {
                await this.saveRemote(loaded, images, image, { signal, index: 0, download: (url, activeSignal) => this.#downloadProvider(provider, url, activeSignal) });
                changed = true;
              } catch (error) {
                if (signal?.aborted || error.name === 'AbortError') throw error;
                if (error.code === 'http-error' && [403, 404].includes(error.status)) continue;
                if (error.code === 'http-error') break;
                throw error;
              }
            }
            downloaded.add(type); break;
          }
        }
        if (!supported.includes('Backdrop') || imageOption(loaded, 'Backdrop').limit <= 0) continue;
        const backdrops = list.filter(image => image.Type === 'Backdrop')
          .sort((a, b) => Number(emptyLanguage(b.Language)) - Number(emptyLanguage(a.Language)));
        for (const image of backdrops) {
          if (images.filter(value => value.Type === 'Backdrop').length >= backdropLimit) break;
          if (image.Width != null && image.Width < imageOption(loaded, 'Backdrop').minWidth) continue;
          if (useStub) { setStub('Backdrop', image.Url); continue; }
          try {
            const source = await this.#downloadProvider(provider, image.Url, signal);
            if (source.contentLength != null && !replacing('Backdrop')) {
              let duplicate = false;
              for (const current of images.filter(value => value.Type === 'Backdrop' && !remote(value))) try {
                if ((await loaded.imageAssets.stat(current.Path, { signal })).size === BigInt(source.contentLength)) { duplicate = true; break; }
              } catch (error) { if (!['not-found', 'invalid-path', 'unmapped-path'].includes(error.code)) this.logger.error(error, 'Error examining images'); }
              if (duplicate) continue;
            }
            await this.saveRemote(loaded, images, image, { signal, download: async () => source }); changed = true;
          } catch (error) {
            if (signal?.aborted || error.name === 'AbortError') throw error;
            if (error.code === 'http-error' && [403, 404].includes(error.status)) continue;
            if (error.code === 'http-error') break;
            throw error;
          }
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        failures++; errorMessage = error.message; this.logger.error(error, `Error in ${provider.name} image provider`);
      }
    }
    if (oldBackdrops.length && oldBackdrops.length < images.filter(image => image.Type === 'Backdrop').length) {
      for (const image of oldBackdrops) {
        if (!remote(image)) try { await loaded.imageAssets.delete(image.Path, { signal }); }
        catch (error) { if (!['not-found', 'invalid-path', 'unmapped-path', 'permission-denied'].includes(error.code)) this.logger.error(error, 'Unable to delete replaced image'); }
        const index = images.indexOf(image); if (index >= 0) images.splice(index, 1);
      }
      await this.#cleanupEpisodeMetadataDirectory(loaded, signal);
      changed = true;
    }
    return { changed, failures, errorMessage };
  }
  async validate(images, assets, signal) {
    let changed = false;
    for (const image of [...images]) if (!remote(image)) {
      try { if ((await assets.stat(image.Path, { signal })).kind === 'file') continue; }
      catch (error) { if (!['not-found', 'invalid-path'].includes(error.code)) throw error; }
      images.splice(images.indexOf(image), 1); changed = true;
    }
    return changed;
  }
  async merge(images, candidates, loaded, signal, options) {
    let changed = await this.validate(images, loaded.imageAssets, signal);
    const folder = loaded.item?.Path && containingImageFolder(loaded.item);
    const storedWithMedia = candidate => folder && ordinalIgnoreCaseKey(folder).includes(ordinalIgnoreCaseKey(imagePathApi(candidate.Path).dirname(candidate.Path)));
    const foundTypes = [];
    for (const type of singular) {
      const file = candidates.find(image => image.Type === type); if (!file) continue;
      if (storedWithMedia(file)) foundTypes.push(type);
      const old = images.find(image => image.Type === type);
      if (!old) { images.push(row(file, type)); changed = true; }
      else if (!same(old.Path, file.Path)) { Object.assign(old, { Path: file.Path, DateModified: modified(file), Width: 0, Height: 0 }); changed = true; }
      else { if (old.DateModified !== modified(file) && (old.Width > 0 || old.Height > 0)) { old.Width = old.Height = 0; changed = true; } old.DateModified = modified(file); }
    }
    for (const file of candidates.filter(image => image.Type === 'Backdrop')) {
      if (storedWithMedia(file)) foundTypes.push('Backdrop');
      const old = images.find(image => image.Type === 'Backdrop' && same(image.Path, file.Path));
      if (!old) { images.push(row(file, 'Backdrop')); changed = true; }
      else if (!remote(old)) { if (old.DateModified !== modified(file) && (old.Width > 0 || old.Height > 0)) { old.Width = old.Height = 0; changed = true; } old.DateModified = modified(file); }
    }
    this.updateReplaceImages(options, foundTypes);
    return changed;
  }
  async download(url, signal) {
    signal = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    while (true) {
      signal.throwIfAborted();
      const running = this.#requests.get(url);
      if (!running) break;
      await waitForDownload(running, signal);
    }
    this.#expireCache();
    const cached = this.#cache.get(url); if (cached) return cached;
    const task = (async () => {
      let response;
      try { response = await this.fetch(url, { signal }); }
      catch (error) { if (signal?.aborted || error.name === 'AbortError') throw error; error.code = 'http-error'; throw error; }
      const value = await this.#readResponse(response, url, signal);
      const entry = { ...value, expires: this.now() + 10000 }; this.#cache.set(url, entry); this.#expireCache(); return entry;
    })();
    this.#requests.set(url, task); try { return await task; } finally { this.#requests.delete(url); }
  }
  async close() {
    this.#lifetime.abort(); clearTimeout(this.#cacheTimer); this.#cacheTimer = undefined; this.#cache.clear();
    await Promise.allSettled(this.#requests.values());
  }
  async #readResponse(response, url, signal) {
    try {
      if (!response.ok) throw Object.assign(new Error(`Image download returned HTTP ${response.status}.`), { code: 'http-error', status: response.status });
      let mimeType = response.headers.get('content-type')?.split(';')[0];
      if (!mimeType && /\/imagecache\//i.test(url)) mimeType = 'image/png';
      if (!mimeType || mimeType.toLowerCase() === 'application/octet-stream') mimeType = mimeTypes[imagePathApi(url).extname(new URL(url).pathname).toLowerCase()] ?? 'application/octet-stream';
      if (!/^image\//i.test(mimeType)) throw Object.assign(new Error(`Request returned '${mimeType}' instead of an image type`), { code: 'http-error', status: 404 });
      const contentLength = response.headers.get('content-length');
      const bytes = Buffer.from(await response.arrayBuffer()); signal?.throwIfAborted();
      return { mimeType, bytes, contentLength: contentLength != null && /^\d+$/.test(contentLength) ? Number(contentLength) : null };
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  async #downloadProvider(provider, url, signal) {
    let response;
    try { response = await provider.getImageResponse(url, { signal }); }
    catch (error) { if (signal?.aborted || error.name === 'AbortError') throw error; error.code ??= 'http-error'; throw error; }
    return this.#readResponse(response, url, signal);
  }
  async saveRemote(loaded, images, image, { signal, index, download, beforeWrite } = {}) {
    const { item, imageAssets: assets } = loaded;
    const { bytes, mimeType } = await (download ? download(image.Url, signal) : this.download(image.Url, signal));
    let saveLocally = item.SupportsLocalMetadata && loaded.saveLocalMetadataEnabled && item.ExtraType == null && item.Type !== 'Audio';
    if (item.Type === 'Episode' && image.Type !== 'Primary') saveLocally = false;
    if (!item.IsFileProtocol) saveLocally = item.Type === 'Season' && loaded.series?.Path && loaded.saveLocalMetadataEnabled;
    index ??= multipleImages(image.Type) ? images.filter(value => value.Type === image.Type).length : 0;
    const options = { saveLocally, metadataPath: loaded.metadataPath, series: loaded.series, images, configuration: loaded.globalOptions, extraImagePaths: loaded.extraImagePaths };
    const paths = imageSavePaths(item, image.Type, index, mimeType, options);
    const retries = saveLocally ? imageSavePaths(item, image.Type, index, mimeType, { ...options, saveLocally: false }) : [];
    const old = images.filter(value => value.Type === image.Type)[index], oldPath = old?.Path, oldIsLocal = old && !remote(old), saved = [];
    beforeWrite?.();
    for (const [i, path] of paths.entries()) {
      let file;
      try { file = await assets.write(path, bytes, { signal }); }
      catch (error) { if (!['permission-denied', 'unavailable', 'not-supported'].includes(error.code) || paths.length !== retries.length || same(path, retries[i])) throw error; file = await assets.write(retries[i], bytes, { signal }); }
      saved.push(file);
    }
    if (old) Object.assign(old, { Path: saved[0].Path, DateModified: modified(saved[0]), Width: 0, Height: 0 }); else images.push(row(saved[0], image.Type));
    if (oldIsLocal && !saved.some(file => same(file.Path, oldPath)) && (saveLocally || loaded.metadataPath && ordinalIgnoreCaseKey(oldPath).includes(ordinalIgnoreCaseKey(loaded.metadataPath)))) {
      try { await assets.delete(oldPath, { signal }); } catch (error) { if (error.code !== 'not-found') throw error; }
    }
    return saved;
  }
  async importLocalResult(loaded, result, images, options = {}) {
    let changed = false; const foundTypes = [];
    for (const image of result.RemoteImages ?? []) {
      if (images.some(current => current.Type === image.Type) && !options.ReplaceAllImages && !options.ReplaceImages?.includes(image.Type)) continue;
      try { await this.saveRemote(loaded, images, image, options); changed = true; foundTypes.push(image.Type); }
      catch (error) { if (error.code !== 'http-error') throw error; this.logger.error(error, 'Could not save NFO remote image'); }
    }
    const files = [...result.Images ?? []];
    for (const image of result.LocalImageCandidates ?? []) {
      // DirectoryService.GetFile receives the literal NFO value; Windows FileInfo rejects file URIs.
      if (/^file:/i.test(image.Url)) continue;
      try { const file = await loaded.imageAssets.stat(imageIdentityPath(image.Url), options); if (file.kind === 'file' && !files.some(value => value.Type === image.Type)) files.push({ ...file, Type: image.Type }); }
      catch (error) { if (error.code !== 'not-found') throw error; }
    }
    this.updateReplaceImages(options, foundTypes);
    return await this.merge(images, files, loaded, options.signal, options) || changed;
  }
}
