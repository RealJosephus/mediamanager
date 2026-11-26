import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { withCleanup } from '../core/operation-failure.js';
import { stripCanvasColorProfile } from '../images/renderer.js';
import { extractTrickplayFrames } from '../media-execution/trickplay.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { trickplayDirectory } from '../playback/trickplay.js';
import { nativeGuid } from '../users/native.js';
import { dateTicks, idKey, VIDEO_TYPES } from './records.js';

const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
const layoutName = ({ Width, TileWidth, TileHeight }) => `${Width} - ${TileWidth}x${TileHeight}`;
const bandwidth = (bytes, { TileWidth, TileHeight, Interval }) => Math.ceil(bytes * 8000 / TileWidth / TileHeight / Interval);
const roundEven = value => { const floor = Math.floor(value); return value - floor === 0.5 ? floor + floor % 2 : Math.round(value); };
const eligible = (item, interval) => Number.isSafeInteger(interval) && BigInt(item.RunTimeTicks ?? 0) >= BigInt(interval) * 10000n
  && item.Path && !item.Path.includes('://') && !item.IsPlaceHolder && !item.IsShortcut && (!item.VideoType || item.VideoType === 'VideoFile');

export class TrickplayGeneration {
  #active = new Map();
  #lifetime = new AbortController();
  #tail = Promise.resolve();

  constructor({ playback, probe, fileSystem, getConfiguration, onError }) {
    Object.assign(this, { playback, probe, fileSystem, getConfiguration, onError });
  }

  refresh(item, { replace = false, libraryOptions, signal } = {}) {
    if (!VIDEO_TYPES.has(item.Type)) return Promise.resolve();
    const id = nativeGuid(item.Id);
    if (!replace && this.#active.has(id)) return this.#active.get(id);
    const operation = this.#serialize(active => this.#refresh(item, id, { replace, libraryOptions, signal: active }), signal);
    this.#active.set(id, operation);
    const finish = () => { if (this.#active.get(id) === operation) this.#active.delete(id); };
    operation.then(finish, finish);
    return operation;
  }

  move(item, { signal } = {}) {
    if (!VIDEO_TYPES.has(item.Type)) return Promise.resolve();
    return this.#serialize(active => this.#move(item, active), signal);
  }

  #serialize(operation, signal) {
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const work = this.#tail.then(() => this.playback.library.store.runDetached(() => operation(combined)));
    this.#tail = work.catch(() => {});
    return work;
  }

  close() { this.#lifetime.abort(); return this.#tail; }

  async #entries(directory, signal, withFileTypes = false) {
    try { return await this.fileSystem.readdir(directory, { signal, withFileTypes }); }
    catch (error) { if (!missing(error)) throw error; return []; }
  }

  async #tiles(folder, signal) {
    return (await this.#entries(folder, signal, true)).filter(entry => entry.isFile() && /\.jpg$/iu.test(entry.name));
  }

  async #discover(directory, alternate, id, runtime, options, known, signal) {
    const api = imagePathApi(directory), store = this.playback.library.store;
    const orphaned = [];
    for (const [width, info] of known) {
      const layout = layoutName(info);
      if ((await this.#tiles(api.join(directory, layout), signal)).length) continue;
      if (alternate && (await this.#tiles(imagePathApi(alternate).join(alternate, layout), signal)).length) continue;
      orphaned.push(width);
    }
    if (orphaned.length) {
      await store.transaction(async database => {
        for (const Width of orphaned) await database.delete('TrickplayInfos', { ItemId: id, Width });
      }, { signal });
      for (const width of orphaned) known.delete(width);
    }
    for (const name of await this.#entries(directory, signal)) {
      const match = /^(\d+) - (\d+)x(\d+)$/u.exec(name);
      if (!match) continue;
      const [Width, TileWidth, TileHeight] = match.slice(1).map(Number);
      if (!Width || !TileWidth || !TileHeight || known.has(Width) || ![Width, TileWidth, TileHeight].every(value => Number.isSafeInteger(value))) continue;
      const folder = api.join(directory, name);
      const files = (await this.#tiles(folder, signal)).map(entry => entry.name).sort();
      if (!files.length) continue;
      const capacity = TileWidth * TileHeight;
      const maximum = files.length * capacity, minimum = files.length > 1 ? (files.length - 1) * capacity + 1 : 1;
      const milliseconds = Number(runtime / 10000n);
      const lower = Math.max(1000, Math.ceil(milliseconds / maximum));
      const upper = Math.max(lower, Math.floor(milliseconds / minimum));
      const Interval = options.Interval >= lower && options.Interval <= upper ? options.Interval
        : Math.min(upper, Math.max(lower, 1000 * roundEven((lower + upper) / 2000)));
      const ThumbnailCount = Math.max(minimum, Math.min(maximum, roundEven(milliseconds / Interval)));
      const first = await loadImage(await this.fileSystem.readFile(api.join(folder, files[0]), { signal }));
      const info = { ItemId: id, Width, Height: Math.max(1, Math.ceil(first.height / TileHeight)), TileWidth, TileHeight, Interval, ThumbnailCount, Bandwidth: 0 };
      for (const file of files) {
        const size = (await this.fileSystem.stat(api.join(folder, file), { bigint: true })).size;
        info.Bandwidth = Math.max(info.Bandwidth, bandwidth(Number(size), info));
      }
      await store.transaction(async database => {
        const [previous] = await database.rows('TrickplayInfos', { where: { ItemId: id, Width }, limit: 1 });
        if (!previous) await database.insert('TrickplayInfos', info);
      }, { signal });
      known.set(Width, info);
    }
  }

  async #render(directory, id, item, source, video, accessPath, width, options, signal) {
    const api = imagePathApi(directory), store = this.playback.library.store;
    const lease = await this.probe.bridge.lease(accessPath, { signal, expiresInMs: 21660000 });
    const staged = api.join(directory, 'trickplay-' + randomUUID());
    const info = { ItemId: id, Width: width, Interval: options.Interval, TileWidth: options.TileWidth,
      TileHeight: options.TileHeight, ThumbnailCount: 0, Height: 0, Bandwidth: 0 };
    let extracted, staging;
    return withCleanup(async () => {
      extracted = await extractTrickplayFrames(this.probe.mediaEncoder, lease.url, source, video, width, options, { signal });
      const capacity = info.TileWidth * info.TileHeight;
      info.ThumbnailCount = extracted.frameCount;
      await this.fileSystem.mkdir(directory, { recursive: true, signal });
      await this.fileSystem.mkdir(staged, { signal });
      staging = true;
      for (let start = 0; start < extracted.frameCount; start += capacity) {
        signal.throwIfAborted();
        let canvas, context;
        const count = Math.min(capacity, extracted.frameCount - start);
        for (let index = 0; index < count; index++) {
          const image = await loadImage(await extracted.readFrame(start + index));
          info.Height ||= image.height;
          if (image.width !== width || image.height !== info.Height) throw new Error('Trickplay frame dimensions changed.');
          if (!canvas) {
            canvas = createCanvas(width * info.TileWidth, info.Height * info.TileHeight);
            context = canvas.getContext('2d');
            context.fillStyle = 'black'; context.fillRect(0, 0, canvas.width, canvas.height);
          }
          context.drawImage(image, index % info.TileWidth * width, Math.floor(index / info.TileWidth) * info.Height);
        }
        const bytes = stripCanvasColorProfile(await canvas.encode('jpeg', options.JpegQuality), 'Jpg');
        await this.fileSystem.writeFile(api.join(staged, `${start / capacity}.jpg`), bytes, { signal });
        info.Bandwidth = Math.max(info.Bandwidth, bandwidth(bytes.length, info));
      }
      const target = api.join(directory, layoutName(info));
      return store.serializeWrites(async database => {
        const [row] = await database.rows('BaseItems', { where: { Id: id }, columns: ['DateModified', 'Path'] });
        if (!row || row.Path !== item.Path || dateTicks(row.DateModified) !== dateTicks(item.DateModified)) return;
        signal.throwIfAborted();
        const previous = api.join(directory, 'trickplay-previous-' + randomUUID());
        let backedUp = false;
        try { await this.fileSystem.rename(target, previous); backedUp = true; }
        catch (error) { if (!missing(error)) throw error; }
        try {
          await this.fileSystem.rename(staged, target); staging = false;
          await database.transaction(async transaction => {
            await transaction.delete('TrickplayInfos', { ItemId: id, Width: width });
            await transaction.insert('TrickplayInfos', info);
          }, { signal });
        } catch (error) {
          await withCleanup(() => { throw error; }, [
            () => !staging && this.fileSystem.rm(target, { recursive: true, force: true }),
            () => backedUp && this.fileSystem.rename(previous, target),
          ], 'Trickplay publication failed.');
        }
        if (backedUp) await this.fileSystem.rm(previous, { recursive: true, force: true });
        return info;
      }, { signal });
    }, [lease.release, () => extracted?.release(), () => staging && this.fileSystem.rm(staged, { recursive: true, force: true })], 'Trickplay generation failed.');
  }

  async #libraryOptions(item) {
    const library = this.playback.library;
    const folder = (await library.getCollectionFolders(item)).find(value => value.Type === 'CollectionFolder');
    const configured = library.options.libraryOptions;
    return folder && (configured instanceof Map ? configured.get(idKey(folder.Id)) : configured?.[idKey(folder.Id)]);
  }

  async #move(item, signal) {
    signal.throwIfAborted();
    if (!eligible(item, this.getConfiguration().TrickplayOptions.Interval)) return;
    const options = await this.#libraryOptions(item);
    if (!options?.EnableTrickplayImageExtraction) return;
    const { library } = this.playback;
    const source = trickplayDirectory(item, library.options.dataPath, !options.SaveTrickplayWithMedia);
    const target = trickplayDirectory(item, library.options.dataPath, options.SaveTrickplayWithMedia);
    if (!source || !target) return;
    const sourceApi = imagePathApi(source), targetApi = imagePathApi(target);
    const layouts = await library.store.run(database => database.rows('TrickplayInfos', { where: { ItemId: nativeGuid(item.Id) } }), { signal });
    const files = async directory => {
      try { return (await this.fileSystem.readdir(directory, { withFileTypes: true, signal })).filter(file => file.isFile()); }
      catch (error) { if (!missing(error)) throw error; return null; }
    };
    for (const layout of layouts) {
      signal.throwIfAborted();
      const name = layoutName(layout), from = sourceApi.join(source, name), to = targetApi.join(target, name);
      const sourceFiles = await files(from);
      if (!sourceFiles?.length) continue;
      const destinationFiles = await files(to);
      if (destinationFiles?.length === 0) continue;
      await this.fileSystem.mkdir(target, { recursive: true, signal });
      if (!destinationFiles) {
        try { await this.fileSystem.rename(from, to); continue; }
        catch (error) { if (!['EXDEV', 'ENOTSUP', 'EEXIST', 'ENOTEMPTY', 'not-supported'].includes(error.code)) throw error; }
      }
      let created = false;
      if (!destinationFiles) {
        try { await this.fileSystem.mkdir(to, { signal }); created = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      try {
        for (const file of sourceFiles) {
          signal.throwIfAborted();
          await this.fileSystem.copyFile(sourceApi.join(from, file.name), targetApi.join(to, file.name));
        }
      } catch (error) {
        if (created) await withCleanup(() => { throw error; }, [() => this.fileSystem.rm(to, { recursive: true, force: true })], 'Trickplay move failed.');
        throw error;
      }
      await this.fileSystem.rm(from, { recursive: true, force: true });
    }
    if ((await this.#entries(source, signal)).length) return;
    try { await this.fileSystem.rmdir(source); } catch (error) { if (!missing(error) && error.code !== 'ENOTEMPTY') throw error; }
  }

  async #refresh(item, id, { replace, libraryOptions, signal }) {
    signal.throwIfAborted();
    const { library } = this.playback, { store } = library;
    const options = { ...this.getConfiguration().TrickplayOptions };
    if (!eligible(item, options.Interval)) return;
    const runtime = BigInt(item.RunTimeTicks ?? 0);
    libraryOptions ??= await this.#libraryOptions(item);
    if (!libraryOptions) return;
    const directory = trickplayDirectory(item, library.options.dataPath, libraryOptions.SaveTrickplayWithMedia);
    if (!directory) return;
    const known = new Map((await store.run(database => database.rows('TrickplayInfos', { where: { ItemId: id } }), { signal })).map(info => [info.Width, info]));
    if (!replace) {
      const alternate = trickplayDirectory(item, library.options.dataPath, !libraryOptions.SaveTrickplayWithMedia);
      await this.#discover(directory, alternate, id, runtime, options, known, signal);
    }
    if (!libraryOptions.EnableTrickplayImageExtraction && !replace && libraryOptions.SaveTrickplayWithMedia) return;
    if (!libraryOptions.EnableTrickplayImageExtraction || replace) {
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      await store.transaction(database => database.deleteWhere('TrickplayInfos', { ItemId: id }), { signal });
      known.clear();
      if (!replace) return;
    }
    options.Interval = Math.max(1000, options.Interval);
    if (!(options.TileWidth > 0 && options.TileHeight > 0)) throw new Error('The trickplay tile dimensions are invalid.');
    const source = (await library.getMediaSources(id)).find(value => idKey(value.Id) === idKey(id));
    const video = source?.MediaStreams.find(value => value.Type === 'Video' && !value.IsAttachedPic);
    const api = imagePathApi(item.Path);
    if (!video || api.basename(api.dirname(item.Path)).toLowerCase() === 'backdrops') return;
    const accessPath = this.playback.accessPath(item);
    for (const requested of options.WidthResolutions ?? []) {
      signal.throwIfAborted();
      const width = 2 * Math.trunc(Math.min(requested, video.Width ?? requested) / 2);
      if (width < 2) continue;
      const info = known.get(width);
      if (info && (await this.#entries(imagePathApi(directory).join(directory, layoutName(info)), signal)).length) continue;
      try {
        const generated = await this.#render(directory, id, item, source, video, accessPath, width, options, signal);
        if (generated) known.set(width, generated);
      } catch (error) { if (signal.aborted) throw error; this.onError?.(error); }
    }
    const expected = new Set([...known.values()].map(layoutName));
    for (const name of await this.#entries(directory, signal)) {
      if (!/^\d+ - \d+x\d+$/u.test(name) || expected.has(name)) continue;
      try { await this.fileSystem.rm(imagePathApi(directory).join(directory, name), { recursive: true, force: true }); }
      catch (error) { this.onError?.(error); }
    }
  }
}
