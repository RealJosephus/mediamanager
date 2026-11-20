import { withCleanup } from '../core/operation-failure.js';
import { extractStillImage } from '../media-execution/still-image.js';
import { MetadataImageAssets, imagePathApi } from '../metadata/image-assets.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeGuid } from '../users/native.js';
import { dateTicks, idKey } from './records.js';

const supportedImage = /\.(?:jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif)$/iu;
const unavailable = error => ['ENOENT', 'not-found', 'not-directory', 'permission-denied', 'unmapped-path'].includes(error.code);
const second = 10000000n;

export class ChapterImages {
  #active = new Map();

  constructor({ playback, probe, fileSystem, applicationPaths, getConfiguration, onError }) {
    this.assets = new MetadataImageAssets({ fileSystem, get metadataPath() { return applicationPaths.metadataPath; } });
    Object.assign(this, { playback, probe, getConfiguration, onError });
  }

  refresh(item, options) {
    const id = nativeGuid(item.Id);
    const previous = this.#active.get(id);
    const operation = (previous?.catch(() => {}) ?? Promise.resolve()).then(() => this.#refresh(item, id, options));
    this.#active.set(id, operation);
    const finish = () => { if (this.#active.get(id) === operation) this.#active.delete(id); };
    operation.then(finish, finish);
    return operation;
  }

  async #refresh(item, id, { signal, extract, libraryOptions } = {}) {
    signal?.throwIfAborted();
    const { library } = this.playback, { store } = library;
    const readChapters = database => database.rows('Chapters', { where: { ItemId: id } });
    const chapters = await store.run(readChapters, { signal });
    if (!chapters.length || !this.assets.metadataPath) return true;
    const runtime = BigInt(item.RunTimeTicks ?? 0n);
    const timestamp = dateTicks(item.DateModified);
    const root = this.assets.metadataPath;
    const directory = imagePathApi(root).join(internalImagePath(item, root), 'chapters');
    const canExtract = chapters.length === 1 || (chapters.at(-1).StartPositionTicks - chapters[0].StartPositionTicks) >= second * BigInt(chapters.length);
    const folders = libraryOptions ? [] : await library.getCollectionFolders(item);
    const folder = folders.find(entry => entry.Type === 'CollectionFolder');
    const options = libraryOptions ?? (folder && library.options.libraryOptions?.get?.(idKey(folder.Id)));
    const enabled = options?.EnableChapterImageExtraction === true;
    if (extract == null) extract = options?.ExtractChapterImagesDuringLibraryScan === true;
    let video, source, virtualPath;
    if (enabled && canExtract && extract && item.Path && !item.IsPlaceHolder && !item.IsShortcut
      && (!item.VideoType || item.VideoType === 'VideoFile') && !item.Path.includes('://')) {
      source = (await library.getMediaSources(item.Id)).find(value => idKey(value.Id) === idKey(item.Id));
      video = source?.MediaStreams.find(stream => stream.Type === 'Video' && stream.Index === item.DefaultVideoStreamIndex);
      if (video) virtualPath = this.playback.accessPath(item);
    }
    let entries;
    try { entries = await this.assets.list(directory, { signal }); }
    catch (error) { if (!unavailable(error)) throw error; entries = []; }
    const images = new Map(entries.filter(entry => entry.kind === 'file' && supportedImage.test(entry.name))
      .map(entry => [ordinalIgnoreCaseKey(entry.Path), entry]));
    const updates = [];
    let success = true;
    for (const chapter of chapters) {
      signal?.throwIfAborted();
      if (chapter.StartPositionTicks >= runtime) break;
      const filename = imagePathApi(directory).join(directory, `${timestamp}_${chapter.StartPositionTicks}.jpg`);
      let saved = images.get(ordinalIgnoreCaseKey(filename));
      if (!saved && video) {
        const offset = chapter.StartPositionTicks === 0n ? runtime < 15n * second ? runtime : 15n * second : chapter.StartPositionTicks;
        try {
          const lease = await this.probe.bridge.lease(virtualPath, { signal, expiresInMs: 60000 + 2 * Math.max(this.getConfiguration().ImageExtractionTimeoutMs ?? 0, 20000) });
          const bytes = await withCleanup(() => extractStillImage(this.probe.mediaEncoder, lease.url, { container: source.Container,
            stream: video, stereo: source.Video3DFormat, offset, configuration: this.getConfiguration(), signal }), [lease.release], 'Chapter extraction failed.');
          saved = await this.assets.write(filename, bytes, { signal });
        } catch (error) {
          if (signal?.aborted) throw error;
          this.onError?.(error); success = false; break;
        }
      }
      const original = chapter.ImagePath;
      if (saved && ordinalIgnoreCaseKey(original ?? '') !== ordinalIgnoreCaseKey(filename)) {
        updates.push({ chapter, ImagePath: filename, ImageDateModified: saved.modified.replace('T', ' ').replace(/(?:\.0+)?Z$/u, '') });
      } else if (original && (!saved || !enabled)) updates.push({ chapter, ImagePath: null, ImageDateModified: chapter.ImageDateModified });
    }
    const retained = new Set(chapters.map(chapter => ordinalIgnoreCaseKey(chapter.ImagePath ?? '')));
    if (updates.length) {
      const committed = await store.transaction(async database => {
        const [row] = await database.rows('BaseItems', { where: { Id: id }, columns: ['Path', 'DateModified'] });
        if (!row || row.Path !== item.Path || dateTicks(row.DateModified) !== timestamp) return false;
        const current = await readChapters(database);
        if (current.length !== chapters.length || current.some((entry, index) => entry.StartPositionTicks !== chapters[index].StartPositionTicks
          || entry.ImagePath !== chapters[index].ImagePath)) return false;
        for (const { chapter, ImagePath, ImageDateModified } of updates) {
          await database.updateWhere('Chapters', { ItemId: id, ChapterIndex: chapter.ChapterIndex }, { ImagePath, ImageDateModified });
          chapter.ImagePath = ImagePath;
        }
        return true;
      }, { signal });
      if (!committed) return success;
      retained.clear();
      for (const chapter of chapters) retained.add(ordinalIgnoreCaseKey(chapter.ImagePath ?? ''));
    }
    for (const [key, entry] of images) if (!retained.has(key)) {
      try { await this.assets.delete(entry.Path, { signal }); }
      catch (error) { if (signal?.aborted) throw error; if (!unavailable(error)) this.onError?.(error); }
    }
    return success;
  }
}
