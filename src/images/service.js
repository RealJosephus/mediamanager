import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { once } from 'node:events';
import { BinaryResult } from '../http/binary-result.js';
import { HttpResult } from '../http/binding.js';
import { parseInvariantDate } from '../core/invariant-date-parse.js';
import { dateTicks, dateText, MIN_DATE, nonemptyId, mapRecord } from '../library/records.js';
import { MetadataImageAssets } from '../metadata/image-assets.js';
import { MetadataImages } from '../metadata/images.js';
import { MetadataUpdateHost } from '../metadata/update-host.js';
import { persistImageMetadata, insertVideoVersions } from '../metadata/persistence.js';
import { persistVideoVersionRelations } from '../library/video-version-relations.js';
import { imageTypes, multipleImages } from '../metadata/image-paths.js';
import { md5Guid } from '../core/identity.js';
import { roundEven } from './options.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { nativeDate } from '../sessions/user-data.js';
import { readItemImageRows } from '../library/image-order.js';
import { insertNativeImageBatch } from '../database/native-relation-order.js';
import { isFileProtocol } from '../library/owned-items.js';

const remote = image => /^http/i.test(image.Path);
const missing = () => Object.assign(new Error('Image item not found.'), { status: 404, code: 'image-item-missing' });
const asDate = value => new Date(dateText(value ?? MIN_DATE));
const allQuery = (query, name) => [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value).join(',');
export function imageFormats({ headers, query }, format) {
  if (format != null) return [format];
  const accept = (headers.accept ?? '').split(',').map(value => value.split(';')[0].trim());
  const override = allQuery(query, 'Accept').toLowerCase(), agent = (headers['user-agent'] ?? '').toLowerCase();
  return [...(accept.includes('image/webp') || override === 'webp' || agent.includes('crosswalk') && agent.includes('android') ? ['Webp'] : []), 'Jpg', 'Png',
    ...(accept.includes('image/gif') || accept.includes('*/*') || override === 'gif' ? ['Gif'] : [])];
}
// DateTime.TryParse without styles converts zoned values to local wall-clock ticks.
// DateTime comparison then ignores Kind, which differs from DateTimeOffset comparison.
function invariantLocalTicks(value) {
  const parsed = parseInvariantDate(value); if (!parsed) return null;
  const offset = new Date(parsed).getTimezoneOffset();
  return dateTicks(parsed) - BigInt(offset) * 600000000n;
}
function httpDate(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z]{3}, |[A-Za-z]+, |[A-Za-z]{3} )/.test(value)) return NaN;
  return Date.parse(value);
}

export class ImageService {
  #options;
  #lifetime = new AbortController();
  #responses = new Set();
  #active = new Set();
  #itemUpdates = new Map();
  constructor(options) {
    const { store, library, fileSystem = library?.options.fileSystem, vfs, identityMap, mediaIdentityMap = identityMap,
      processor, metadataImages, metadataUpdates, loadContext, logger = { error() {} } } = options;
    this.#options = options;
    Object.assign(this, { store, library, vfs, identityMap, mediaIdentityMap, processor, metadataUpdates, loadContext, logger });
    this.metadataImages = metadataImages ?? new MetadataImages({ processor, logger });
    this.metadataUpdates ??= new MetadataUpdateHost({ store, images: this.metadataImages, library, logger });
    this.assets = new MetadataImageAssets({ fileSystem, vfs, identityMap, get metadataPath() { return options.metadataPath; } });
    this.userAssets = new MetadataImageAssets({ fileSystem, vfs, identityMap, get metadataPath() { return options.userImagePath; } });
  }
  get metadataPath() { return this.#options.metadataPath; }
  #track(operation) {
    if (this.#lifetime.signal.aborted) return Promise.reject(this.#lifetime.signal.reason);
    const task = operation(); this.#active.add(task);
    task.then(() => this.#active.delete(task), () => this.#active.delete(task)); return task;
  }
  async #updateItem(itemId, signal, operation) {
    const key = String(itemId).replaceAll('-', '').toLowerCase();
    const previous = this.#itemUpdates.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.#itemUpdates.set(key, tail);
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const wait = new Promise((resolve, reject) => {
      const abort = () => { combined.removeEventListener('abort', abort); reject(combined.reason); };
      if (combined.aborted) { reject(combined.reason); return; }
      combined.addEventListener('abort', abort, { once: true });
      previous.then(() => { combined.removeEventListener('abort', abort); resolve(); }, error => { combined.removeEventListener('abort', abort); reject(error); });
    });
    try {
      await wait; combined.throwIfAborted();
      return await operation(signal ?? this.#lifetime.signal);
    } finally {
      release();
      void tail.finally(() => { if (this.#itemUpdates.get(key) === tail) this.#itemUpdates.delete(key); });
    }
  }
  async load(itemId, user) {
    this.#lifetime.signal.throwIfAborted();
    if (!itemId || /^0+$/.test(itemId.replaceAll('-', ''))) throw Object.assign(new Error('The item ID must not be empty.'), { status: 400 });
    const metadataPath = this.metadataPath;
    const assets = new MetadataImageAssets({ fileSystem: this.assets.fileSystem, vfs: this.vfs, identityMap: this.identityMap, metadataPath });
    let item;
    try { item = await this.library.getItemRecord(itemId, { user }); } catch (error) { if (error?.status === 404) throw missing(); throw error; }
    const rows = await this.store.run(db => readItemImageRows(db, item.Id));
    const ordered = rows;
    const parentRow = nonemptyId(item.ParentId) ? await this.store.run(async db => (await db.rows('BaseItems', { where: { Id: item.ParentId } }))[0]) : undefined;
    const expand = this.library.options.expandPath ?? (value => value);
    let accessPath;
    if (this.mediaIdentityMap && isFileProtocol(item)) try { accessPath = this.mediaIdentityMap.resolve({ itemId: item.Id, identityPath: item.Path, style: /^[A-Za-z]:[\\/]|^\\\\/.test(item.Path) ? 'windows' : 'posix' }); }
    catch (error) { if (error?.code !== 'not-found') throw error; }
    const library = this.library;
    const capturePathScope = ({ imageAssets = assets } = {}) => {
      const metadataPath = this.metadataPath;
      return { metadataPath, imageAssets: imageAssets.withMetadataPath(metadataPath) };
    };
    return { item, parent: parentRow && mapRecord(parentRow), images: ordered.map(row => ({ ...row, Type: imageTypes[row.ImageType], Path: expand(row.Path) })), rows,
      imageAssets: assets.forItem(item, accessPath), metadataPath, capturePathScope, get globalOptions() { return library.options.configuration; },
      saveLocalMetadataEnabled: false, extraImagePaths: undefined };
  }
  getImageDimensions(item, image) { return this.#track(async () => {
    if (image.Width > 0 && image.Height > 0) return { Width: image.Width, Height: image.Height };
    let accessPath;
    if (this.mediaIdentityMap && isFileProtocol(item)) try {
      accessPath = this.mediaIdentityMap.resolve({ itemId: item.Id, identityPath: item.Path,
        style: /^[A-Za-z]:[\\/]|^\\\\/.test(item.Path) ? 'windows' : 'posix' });
    } catch (error) { if (error?.code !== 'not-found') throw error; }
    const filename = (this.library.options.expandPath ?? (value => value))(image.Path);
    const bytes = await this.assets.forItem(item, accessPath).read(filename, { signal: this.#lifetime.signal });
    const size = await this.processor.getImageSize(bytes, filename, { signal: this.#lifetime.signal });
    image.Width = size.Width; image.Height = size.Height;
    return size;
  }); }
  async persist(loaded, { dateLastSaved, context, newVersions = [], signal } = {}) {
    return this.store.serializeWrites(async () => {
      const rows = await this.store.transaction(async db => {
        signal?.throwIfAborted();
        if (!isDeepStrictEqual(await readItemImageRows(db, loaded.item.Id), loaded.rows))
          throw Object.assign(new Error('Image records changed while processing.'), { status: 409, code: 'metadata-conflict' });
        const desired = loaded.images.map(image => {
          image.Id ??= randomUUID().toUpperCase();
          const row = { ItemId: loaded.item.Id, ImageType: imageTypes.indexOf(image.Type), Path: image.Path, DateModified: image.DateModified ?? MIN_DATE,
            Width: image.Width ?? 0, Height: image.Height ?? 0, Blurhash: image.Blurhash ?? null };
          return { row: { Id: image.Id, ...row } };
        });
        await db.deleteWhere('BaseItemImageInfos', { ItemId: loaded.item.Id });
        await insertNativeImageBatch(db, desired.map(entry => entry.row));
        if (dateLastSaved) await db.update('BaseItems', { Id: loaded.item.Id }, { DateLastSaved: nativeDate(dateLastSaved) });
        if (context) {
          await insertVideoVersions(db, context, newVersions, { signal });
          await persistVideoVersionRelations(db, context.item, { reversePath: context.reversePath });
        }
        return readItemImageRows(db, loaded.item.Id);
      }, { signal });
      // Recursive remote localization can commit more than once during UpdateImagesAsync.
      loaded.rows = rows;
    }, { signal });
  }
  async persistImages(loaded, context = loaded) {
    await this.store.serializeWrites(async db => {
      if (!isDeepStrictEqual(await readItemImageRows(db, loaded.item.Id), loaded.rows))
        throw Object.assign(new Error('Image records changed while processing.'), { status: 409, code: 'metadata-conflict' });
      await persistImageMetadata(this.store, context, loaded.images);
      loaded.rows = await readItemImageRows(db, loaded.item.Id);
      const available = [...loaded.rows];
      for (const image of loaded.images) {
        const index = available.findIndex(row => row.ImageType === imageTypes.indexOf(image.Type) && row.Path === image.Path);
        if (index >= 0) image.Id = available.splice(index, 1)[0].Id;
      }
    });
  }
  imageUpdate(loaded, context, signal) {
    return this.metadataUpdates.update(context, { Item: context.item, Images: loaded.images }, ItemUpdateType.ImageUpdate, {
      signal, persist: (updated, result, options) => this.persist(loaded, { dateLastSaved: updated.item.DateLastSaved, context, ...options }),
      persistImages: updated => this.persistImages(loaded, updated),
    });
  }
  async localize(loaded, image, index, signal, { reload = false, user } = {}) {
    if (!remote(image)) return image;
    return this.#updateItem(loaded.item.Id, signal, async combined => {
      if (reload) {
        const current = await this.load(loaded.item.Id, user);
        const selected = current.images.filter(value => value.Type === image.Type)[index];
        if (!selected) throw missing();
        Object.defineProperties(loaded, Object.getOwnPropertyDescriptors(current)); image = selected;
        if (!remote(image)) return image;
      }
      const context = this.loadContext ? await this.loadContext(loaded.item.Id) : loaded;
      const update = () => this.imageUpdate(loaded, context, combined);
      context.onImageRemoteChange = update;
      let saved = false;
      for (const url of image.Path.split('|')) {
        try { await this.metadataImages.saveRemote(context, loaded.images, { Url: url, Type: image.Type }, { signal: combined, index }); saved = true; break; }
        catch (error) { if (error?.code !== 'http-error' || ![403, 404].includes(error.status)) throw error; }
      }
      if (!saved) {
        loaded.images.splice(loaded.images.indexOf(image), 1); await update();
        throw new Error('No remote image could be saved.');
      }
      await update();
      return loaded.images.filter(value => value.Type === image.Type)[index];
    });
  }
  item(options, context) { return this.#track(() => this.#item(options, context)); }
  async #item(options, context) {
    const loaded = await this.load(options.itemId, context.auth.User), index = options.imageIndex ?? 0;
    let image = index < 0 ? undefined : loaded.images.filter(value => value.Type === options.imageType)[index];
    if (options.imageType === 'Chapter' && index >= 0) {
      const chapter = await this.store.run(async db => (await db.rows('Chapters', { where: { ItemId: loaded.item.Id, ChapterIndex: index } }))[0]);
      image = chapter?.ImagePath ? { Path: (this.library.options.expandPath ?? (value => value))(chapter.ImagePath), DateModified: chapter.ImageDateModified, Type: 'Chapter' } : undefined;
    }
    if (!image) return new HttpResult(404, `${loaded.item.Name} does not have an image of type ${options.imageType}`);
    return this.result({ loaded, image, options, context, index });
  }
  user(options, context) { return this.#track(() => this.#user(options, context)); }
  async #user(options, context) {
    const image = await this.store.run(async db => (await db.rows('ImageInfos', { where: { UserId: options.userId } }))[0]);
    if (!image) throw missing();
    return this.result({ loaded: { item: {}, imageAssets: this.userAssets }, image: { Path: image.Path, DateModified: image.LastModified, Type: 'Profile' },
      options: { tag: options.tag, format: options.format, quality: 90 }, context });
  }
  info(itemId, options = {}) { return this.#track(() => this.#info(itemId, options)); }
  async #info(itemId, { user } = {}) {
    let loaded = await this.load(itemId, user), originalImages = [...loaded.images];
    if (!originalImages.length) return [];
    const collect = async signal => {
      if (originalImages.some(remote)) { loaded = await this.load(itemId, user); originalImages = [...loaded.images]; }
      if (!originalImages.length) return [];
      const context = originalImages.some(remote) && this.loadContext ? await this.loadContext(loaded.item.Id) : loaded;
      context.onImageRemoteChange = () => this.imageUpdate(loaded, context, signal);
      await this.metadataImages.updateImages(context, loaded.images, { signal,
        persistImages: () => this.persistImages(loaded, context) });
      // The controller captures the original array before UpdateImagesAsync replaces it.
      const ordered = originalImages.filter(image => !multipleImages(image.Type)).map(image => ({ image }));
      for (const type of new Set(originalImages.filter(image => multipleImages(image.Type)).map(image => image.Type)))
        originalImages.filter(image => image.Type === type).forEach((image, index) => ordered.push({ image, index }));
      return Promise.all(ordered.map(async ({ image, index }) => {
        const result = { Path: image.Path, ImageIndex: index, ImageType: image.Type, ImageTag: md5Guid(`${loaded.item.Path ?? ''}${dateTicks(image.DateModified)}`), Size: 0n };
        if (!remote(image)) try {
          result.Size = (await loaded.imageAssets.stat(image.Path)).size ?? 0n;
          if (image.Blurhash != null) result.BlurHash = Buffer.from(image.Blurhash).toString('utf8');
          if (image.Width > 0 && image.Height > 0) { result.Width = image.Width; result.Height = image.Height; }
        } catch (error) { this.logger.error(error); }
        return result;
      }));
    };
    return originalImages.some(remote) ? this.#updateItem(loaded.item.Id, this.#lifetime.signal, collect) : collect(this.#lifetime.signal);
  }
  result({ loaded, image, options, context, index, dlna = true }) {
    return new BinaryResult((request, response) => this.#track(async () => {
      this.#lifetime.signal.throwIfAborted();
      const controller = new AbortController(), abort = () => controller.abort();
      this.#lifetime.signal.addEventListener('abort', abort, { once: true }); this.#responses.add(response);
      request.once('aborted', abort); response.once('close', abort);
      const previousLength = response.getHeader('Content-Length');
      let handle;
      try {
        image = await this.localize(loaded, image, index, controller.signal, { reload: true, user: context.auth?.User });
        let percent = options.percentPlayed, count = options.unplayedCount;
        if (percent <= 0 || percent >= 100) percent = undefined;
        if (percent != null) count = undefined;
        if (count <= 0) count = undefined;
        const result = await this.processor.process({ item: loaded.item, image, assets: loaded.imageAssets, signal: controller.signal,
          Width: options.width, Height: options.height, MaxWidth: options.maxWidth, MaxHeight: options.maxHeight,
          FillWidth: options.fillWidth, FillHeight: options.fillHeight, Quality: options.quality ?? 100,
          Blur: options.blur, BackgroundColor: options.bg, ForegroundLayer: options.foreground,
          PercentPlayed: percent, UnplayedCount: count, SupportedOutputFormats: imageFormats({ headers: request.headers, query: context.query }, options.format) });
        const date = asDate(result.dateModified), tag = options.tag;
        const rawCache = request.headersDistinct?.['cache-control'] ?? [request.headers['cache-control']];
        const disabled = rawCache.includes('no-cache');
        response.setHeader('Content-Type', result.mimeType ?? 'text/plain');
        if (dlna) { response.setHeader('transferMode.dlna.org', 'Interactive'); response.setHeader('realTimeInfo.dlna.org', 'DLNA.ORG_TLAG=*'); }
        response.setHeader('Age', String(roundEven((Date.now() - date.getTime()) / 1000)));
        response.appendHeader('Vary', 'Accept'); response.setHeader('Content-Disposition', 'attachment');
        if (disabled) { response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); response.setHeader('Pragma', 'no-cache, no-store, must-revalidate'); }
        else {
          response.setHeader('Cache-Control', tag ? 'public, max-age=31536000, immutable' : 'public'); response.setHeader('Last-Modified', date.toUTCString());
          if (tag) response.setHeader('ETag', `"${tag}"`);
          const none = request.headers['if-none-match'], since = invariantLocalTicks(request.headers['if-modified-since']);
          if (tag && (none === tag || none === `"${tag}"`) || since != null && dateTicks(result.dateModified) <= since) { response.statusCode = 304; response.end(); return; }
        }
        const file = result.original ? await loaded.imageAssets.stat(result.path, { signal: controller.signal }) : { size: result.bytes.length, modified: result.dateModified };
        const modified = Math.floor(new Date(file.modified ?? date).getTime() / 1000) * 1000;
        response.setHeader('Last-Modified', new Date(modified).toUTCString());
        const since = httpDate(request.headers['if-modified-since']), unmodified = httpDate(request.headers['if-unmodified-since']);
        const unchanged = Number.isFinite(since) && since <= Date.now() && modified <= since;
        const changed = Number.isFinite(unmodified) && unmodified <= Date.now() && modified > unmodified;
        if (changed || unchanged) { response.statusCode = changed ? 412 : 304; if (changed) response.setHeader('Content-Length', '0'); response.end(); return; }
        if (file.size != null) response.setHeader('Content-Length', String(file.size));
        if (request.method === 'HEAD') { response.end(); return; }
        if (result.bytes) response.end(result.bytes);
        else {
          handle = await loaded.imageAssets.openRead(result.path, { signal: controller.signal }); let length = 0n;
          for await (const chunk of handle.stream) { controller.signal.throwIfAborted(); length += BigInt(chunk.length); if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal }); }
          if (file.size != null && length !== BigInt(file.size)) throw new Error('The image stream length changed.');
          response.end();
        }
      } catch (error) {
        if (response.headersSent || controller.signal.aborted) { response.destroy(); return; }
        // Restore the unpublished length before the application writes its error body.
        if (previousLength === undefined) response.removeHeader('Content-Length'); else response.setHeader('Content-Length', previousLength);
        const status = ({ 'not-found': 404, 'permission-denied': 403, 'unmapped-path': 501, 'not-supported': 501, timeout: 504 })[error?.code];
        if (status != null && error?.status == null) error.status = status;
        throw error;
      } finally {
        request.removeListener('aborted', abort); response.removeListener('close', abort);
        this.#lifetime.signal.removeEventListener('abort', abort); this.#responses.delete(response); await handle?.close();
      }
    }));
  }
  async close() { this.#lifetime.abort(); for (const response of this.#responses) response.destroy(); await this.metadataImages.close(); await Promise.allSettled(this.#active); }
}
