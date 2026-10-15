import { tableDefinition } from '../database/model.js';
import { parseLosslessJson } from '../core/json.js';
import { nativeGuid } from '../users/native.js';
import { nativeDate } from '../sessions/user-data.js';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { probeRaw } from '../storage/ffprobe.js';
import { normalizeProbe } from '../storage/probe-normalizer.js';
import { StorageError, checkAbort } from '../storage/errors.js';
import { externalCandidates, discoverExternalStreams } from '../storage/external-streams.js';
import { applyProbeMetadata, normalizeProbeChapters } from '../storage/probe-metadata.js';
import { persistMetadataInDatabase, insertVideoVersions } from '../metadata/persistence.js';
import { invalidateVideoParent } from './video-version-discovery.js';
import { defaultLibraryOptions } from './options.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { supportsProbeMetadata, probeIsVideo, probeFileProtocol, probeFileChanged, missingProbeInfo, probeExternalFilesChanged, probeFetchDecision, normalizeProbeFileDate } from '../storage/probe-lifecycle.js';
import { ExternalDataManager } from './external-data.js';
import { mapRecord, nonemptyId } from './records.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { MetadataUpdateHost } from '../metadata/update-host.js';
import { MetadataImages } from '../metadata/images.js';
import { itemRequiresJson } from './item-data.js';

const streamTypes = ['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric'];
const values = (table, source) => Object.fromEntries(tableDefinition(table).columns.map(column => [column.name, source[column.name] ?? (column.nullable ? null : column.clrType === 'bool' ? false : 0)]));
export function probeStreamRow(itemId, stream) {
  return values('MediaStreamInfos', { ...stream, ItemId: itemId, StreamIndex: stream.Index, StreamType: streamTypes.indexOf(stream.Type), IsAvc: stream.IsAVC });
}
const dataOf = item => itemRequiresJson(item) && item.Data ? parseLosslessJson(item.Data) : {};
const persistData = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry);

function waitForActiveProbe(task, signal) {
  checkAbort(signal);
  if (!signal) return task.catch(() => {});
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StorageError('cancelled', 'Media probing was cancelled.'));
    const settled = () => { signal.removeEventListener('abort', abort); resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    task.then(settled, settled);
  });
}

async function transportTimestamp(vfs, path, { signal, version } = {}) {
  let handle;
  try {
    handle = await vfs.openRead(path, { signal, range: { start: 0n, end: 196n }, ifMatch: version ?? undefined });
    const chunks = []; let size = 0;
    for await (const chunk of handle.stream) { checkAbort(signal); const bytes = Buffer.from(chunk).subarray(0, 197 - size); chunks.push(bytes); size += bytes.length; if (size === 197) break; }
    if (size !== 197) return null;
    const bytes = Buffer.concat(chunks);
    return bytes[0] === 71 || bytes[4] !== 71 || bytes[196] !== 71 ? 'None' : bytes.subarray(0, 4).every(value => value === 0) ? 'Zero' : 'Valid';
  } catch (error) { checkAbort(signal); if (error.code === 'version-changed') throw error; return null; }
  finally { await handle?.close(); }
}

export class ProbeService {
  #cache = new Map();
  #active = new Map();
  #reads = new Set();
  #lifetime = new AbortController();
  constructor({ store, vfs, identityMap, bridge, probeOptions = {}, localization, library, externalData, logger = { error() {} }, probe = probeRaw, loadContext, updates }) {
    if (!store || !vfs || !identityMap) throw new TypeError('Probe service requires native persistence, VFS and identity mappings.');
    this.store = store;
    this.vfs = vfs;
    this.identityMap = identityMap;
    this.bridge = bridge ?? new ProbeReadBridge(vfs);
    this.ownsBridge = !bridge;
    this.probeOptions = probeOptions;
    this.localization = localization;
    this.library = library;
    this.probe = probe;
    this.loadContext = loadContext;
    this.ownedMetadataImages = updates ? null : new MetadataImages({ logger });
    this.updates = updates ?? new MetadataUpdateHost({ store, images: this.ownedMetadataImages, library, logger });
    this.externalData = externalData ?? new ExternalDataManager({ store, vfs, identityMap, logger });
  }

  supportsMetadata(item) { return supportsProbeMetadata(item); }

  async readMediaInfo(loaded) {
    this.#lifetime.signal.throwIfAborted();
    const work = (async () => {
      const item = loaded.item;
      const virtualPath = loaded.context?.accessPath ?? this.identityMap.resolve({ itemId: item.Id, identityPath: item.Path,
        style: /^[A-Za-z]:[\\/]|^\\\\/u.test(item.Path) ? 'windows' : 'posix' });
      const result = await this.probe(this.bridge, virtualPath, { ...this.probeOptions, extractChapters: false, signal: this.#lifetime.signal });
      return normalizeProbe(result.raw, { path: item.Path, isAudio: false });
    })();
    this.#reads.add(work);
    try { return await work; } finally { this.#reads.delete(work); }
  }

  async hasChanged(loaded, { signal } = {}) {
    checkAbort(signal);
    const item = loaded.item;
    if (!this.supportsMetadata(item)) return false;
    const file = probeFileProtocol(item), video = probeIsVideo(item);
    let virtualPath;
    if (file && item.Path) {
      virtualPath = loaded.context?.accessPath ?? this.identityMap.resolve({ itemId: item.Id, identityPath: item.Path, style: /^[A-Za-z]:[\\/]|^\\\\/u.test(item.Path) ? 'windows' : 'posix' });
      if (!video || ['VideoFile', 'Iso', 0, 1, undefined, null].includes(item.VideoType)) {
        try { if (probeFileChanged(item, (await this.vfs.stat(virtualPath, { signal })).modified)) return true; }
        catch (error) { if (error.code !== 'not-found') throw error; }
      }
    }
    if (missingProbeInfo(item)) return true;
    if (!file || item.SupportsLocalMetadata === false || video && item.IsPlaceHolder) return false;
    let candidates;
    try { candidates = await this.#externalCandidates(item, loaded, virtualPath, signal); }
    catch (error) { if (error.code !== 'not-found') throw error; candidates = []; }
    return video ? probeExternalFilesChanged(item.SubtitleFiles, candidates.filter(entry => entry.type === 'Subtitle').map(entry => entry.identityPath))
      || probeExternalFilesChanged(item.AudioFiles, candidates.filter(entry => entry.type === 'Audio').map(entry => entry.identityPath))
      : probeExternalFilesChanged(item.LyricFiles, candidates.map(entry => entry.identityPath));
  }

  async refreshMetadata(loaded, options = {}, { onCommitted, externalDataInvalidated = false } = {}) {
    checkAbort(options.signal);
    const reason = probeFetchDecision(loaded.item, options);
    if (reason) return { changed: false, reason, UpdateType: 1 };
    const result = await this.refresh(loaded.item.Id, { force: true, signal: options.signal, virtualPath: loaded.context?.accessPath, notify: false,
      onCommitted, externalDataInvalidated, replaceAllMetadata: options.ReplaceAllMetadata ?? false, metadataRefreshMode: options.MetadataRefreshMode ?? 'FullRefresh' });
    return { ...result, UpdateType: result.changed ? 2 : 1 };
  }

  async #externalCandidates(item, loaded, virtualPath, signal) {
    if (!probeFileProtocol(item) || item.SupportsLocalMetadata === false) return [];
    const additionalDirectories = [...loaded?.context.externalStreamDirectories ?? []];
    if (loaded?.metadataPath) {
      const identityPath = internalImagePath(loaded.item, loaded.metadataPath);
      try {
        const accessPath = this.identityMap.resolve({ identityPath, style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? 'windows' : 'posix' });
        if ((await this.vfs.stat(accessPath, { signal })).kind === 'directory') additionalDirectories.push({ identityPath, virtualPath: accessPath });
      } catch (error) { if (error.code !== 'not-found') throw error; }
    }
    return externalCandidates(this.vfs, virtualPath, item.Path, { signal, additionalDirectories, types: probeIsVideo(item) ? ['Subtitle', 'Audio'] : ['Lyric'] });
  }

  async refresh(itemId, options = {}) {
    this.#lifetime.signal.throwIfAborted();
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal };
    itemId = nativeGuid(itemId);
    // A cancelled caller never cancels another caller's successful refresh.
    if (this.#active.has(itemId)) {
      await waitForActiveProbe(this.#active.get(itemId), options.signal);
      checkAbort(options.signal);
      return this.refresh(itemId, options);
    }
    const active = this.#refresh(itemId, options);
    this.#active.set(itemId, active);
    try { return await active; }
    finally { if (this.#active.get(itemId) === active) this.#active.delete(itemId); }
  }

  async #refresh(itemId, { force = false, signal, virtualPath, replaceAllMetadata = false, metadataRefreshMode = 'Default', notify = true, onCommitted, externalDataInvalidated = false } = {}) {
    checkAbort(signal);
    const item = await this.store.run(async database => (await database.rows('BaseItems', { where: { Id: itemId } }))[0]);
    if (!item) throw new StorageError('not-found', 'The media item does not exist.');
    const data = dataOf(item);
    const loaded = this.loadContext ? await this.loadContext(itemId) : null;
    let operationFailed = false, operationError;
    try {
    const libraryOptions = loaded?.libraryOptions ?? defaultLibraryOptions();
    if (item.IsFolder || item.IsVirtualItem || data.IsPlaceHolder || !['Video', 'Audio'].includes(item.MediaType)) return { changed: false, reason: 'not-probeable' };
    if (data.IsShortcut || data.VideoType && !['VideoFile', 0].includes(data.VideoType)) throw new StorageError('not-supported', 'Disc and shortcut probing requires its native resolver.');
    const identityPath = loaded?.item.Path ?? item.Path;
    virtualPath ??= loaded?.context.accessPath ?? this.identityMap.resolve({ itemId, identityPath, style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? 'windows' : 'posix' });
    const before = await this.vfs.stat(virtualPath, { signal });
    if (before.kind !== 'file') throw new StorageError('is-directory', 'Probe source must be a media file.');
    const videoSourceModified = probeIsVideo(item) && probeFileChanged(item, before.modified);
    if (videoSourceModified && !externalDataInvalidated) {
      // BeforeSave prunes extracted files and all four data sets before probing.
      await this.externalData.invalidateChangedVideo(loaded?.item ?? { ...data, ...item, Type: item.Type.split('.').at(-1) }, before.modified, { loaded, expectedSnapshot: item });
      checkAbort(signal);
    }
    const reliable = this.vfs.capabilities(virtualPath).reliableVersion === true && before.version != null;
    const candidates = await this.#externalCandidates(loaded?.item ?? { ...data, ...item, Path: identityPath }, loaded, virtualPath, signal);
    const candidatesReliable = candidates.every(candidate => candidate.version != null && this.vfs.capabilities(candidate.virtualPath).reliableVersion === true);
    const cacheKey = reliable && candidatesReliable ? `${virtualPath}\0${before.version}\0${item.Path}\0${item.MediaType}\0${persistData(candidates)}\0${persistData(libraryOptions)}\0${replaceAllMetadata}\0${metadataRefreshMode}` : null;
    const cached = this.#cache.get(itemId);
    if (!force && cacheKey && cached?.key === cacheKey) return { changed: false, reason: 'unchanged-version', mediaInfo: structuredClone(cached.info), sourceConsistency: 'versioned' };
    const missing = item.RunTimeTicks == null && item.TotalBitrate == null;
    const modified = before.modified != null && item.DateModified != null && new Date(before.modified).getTime() !== new Date(item.DateModified.replace(' ', 'T') + (item.DateModified.endsWith('Z') ? '' : 'Z')).getTime();
    if (!force && !cached && !missing && !modified && item.MediaType !== 'Video') return { changed: false, reason: 'native-fields-present' };
    const result = await this.probe(this.bridge, virtualPath, { ...this.probeOptions, extractChapters: item.MediaType === 'Video' || item.Type.endsWith('.AudioBook'), signal });
    const info = normalizeProbe(result.raw, { path: identityPath, isAudio: item.MediaType === 'Audio' });
    if (item.MediaType === 'Video' && ['ts', 'm2ts', 'mpeg2ts'].includes(info.Container?.toLowerCase())) info.Timestamp = await transportTimestamp(this.vfs, virtualPath, { signal, version: reliable ? before.version : undefined });
    const external = item.MediaType === 'Video' ? await discoverExternalStreams(candidates, { probe: this.probe, bridge: this.bridge, probeOptions: this.probeOptions, signal }) : null;
    if (candidatesReliable) for (const candidate of candidates) if ((await this.vfs.stat(candidate.virtualPath, { signal })).version !== candidate.version) throw new StorageError('version-changed', 'An external stream changed during probing.');
    const after = await this.vfs.stat(virtualPath, { signal });
    if (reliable && after.version !== before.version) throw new StorageError('version-changed', 'Media changed during probing.');
    checkAbort(signal);
    const metadata = loaded && applyProbeMetadata(loaded, info, { replaceAllMetadata });
    // Both native probers call synchronous UpdatePeople (CancellationToken.None)
    // before persisting streams. A later technical save failure retains credits
    // and any completed Person creation/saver writes.
    if (metadata?.People != null) await this.updates.updatePeople(loaded, metadata.People);
    const newVersions = loaded ? await loaded.videoVersionDiscovery?.prepare({ ...loaded, item: metadata.Item },
      { baseline: loaded, reportRemoved: (item, parent) => this.updates.reportItemRemoved(item, parent) }) ?? [] : [];
    const committed = await this.store.transaction(async database => {
      const current = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
      if (!current || current.Path !== item.Path || current.Data !== item.Data || current.DateModified !== item.DateModified) throw new StorageError('version-changed', 'The media item changed during probing.');
      if (loaded) {
        await insertVideoVersions(database, loaded, newVersions, { signal });
        await persistMetadataInDatabase(database, loaded, metadata, { signal });
      }
      const streams = external ? [...external.Subtitle, ...external.Audio, ...info.MediaStreams].map((stream, Index) => ({ ...stream, Index })) : [...info.MediaStreams];
      if (!external && candidates.length) streams.push({ Type: 'Lyric', Path: candidates[0].identityPath, Language: candidates[0].parsed.Language,
        Index: streams.length ? Math.max(...streams.map(stream => stream.Index)) + 1 : 0 });
      const allowance = libraryOptions.AllowEmbeddedSubtitles;
      const isText = stream => /microdvd/iu.test(stream.Codec ?? '') || !(/pgs|dvdsub|vobsub|dvbsub/iu.test(stream.Codec ?? '') || /^(?:sup|sub)$/iu.test(stream.Codec ?? ''));
      const filtered = streams.filter(stream => stream.Type !== 'Subtitle' || stream.IsExternal ||
        allowance !== 'AllowNone' && !(allowance === 'AllowImage' && isText(stream)) && !(allowance === 'AllowText' && !isText(stream)));
      const rows = filtered.map(stream => probeStreamRow(itemId, stream));
      await database.deleteWhere('MediaStreamInfos', { ItemId: itemId });
      await database.insertBatch('MediaStreamInfos', rows);
      await database.deleteWhere('AttachmentStreamInfos', { ItemId: itemId });
      const attachmentRows = info.MediaAttachments.map(attachment => values('AttachmentStreamInfos', {
        ...attachment, ItemId: itemId, Filename: attachment.FileName,
      }));
      await database.insertBatch('AttachmentStreamInfos', attachmentRows);
      const chapters = item.MediaType === 'Video' ? normalizeProbeChapters(info.Chapters, { runtime: info.RunTimeTicks, dummyChapterDuration: loaded?.globalOptions.DummyChapterDuration,
        hasVideo: rows.some(row => row.StreamType === 1), localization: this.localization, mode: metadataRefreshMode }) : item.Type.endsWith('.AudioBook') && info.Chapters.length ? info.Chapters : null;
      if (chapters) {
        const oldChapters = await database.rows('Chapters', { where: { ItemId: itemId } });
        await database.deleteWhere('Chapters', { ItemId: itemId });
        const chapterRows = chapters.map((chapter, index) => {
          const old = oldChapters.find(row => row.StartPositionTicks === chapter.StartPositionTicks);
          return values('Chapters', { ...old, ...chapter, ItemId: itemId, ChapterIndex: index });
        });
        await database.insertBatch('Chapters', chapterRows);
      }
      const video = rows.find(row => row.StreamType === 1);
      const refreshed = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
      const nextData = { ...dataOf(refreshed), Container: info.Container };
      if (item.MediaType === 'Video') Object.assign(nextData, { DefaultVideoStreamIndex: video?.StreamIndex ?? null, HasSubtitles: rows.some(row => row.StreamType === 2),
        SubtitleFiles: [...new Set(external.Subtitle.map(stream => stream.Path))], AudioFiles: [...new Set(external.Audio.map(stream => stream.Path))], Timestamp: info.Timestamp });
      else Object.assign(nextData, { LyricFiles: [...new Set(candidates.map(candidate => candidate.identityPath))], HasLyrics: rows.some(row => row.StreamType === 5) });
      const changes = { RunTimeTicks: info.RunTimeTicks, TotalBitrate: info.Bitrate,
        Data: itemRequiresJson(item) ? persistData(nextData) : null, Size: before.size ?? item.Size };
      if (item.MediaType === 'Video') Object.assign(changes, { Width: video?.Width ?? 0, Height: video?.Height ?? 0 });
      if (before.modified != null) changes.DateModified = nativeDate(normalizeProbeFileDate(before.modified));
      await database.update('BaseItems', { Id: itemId }, changes);
      checkAbort(signal);
      const updated = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
      const parent = nonemptyId(updated?.ParentId)
        ? (await database.rows('BaseItems', { where: { Id: updated.ParentId }, limit: 1 }))[0]
        : null;
      return { Item: updated && mapRecord(updated), Parent: parent && mapRecord(parent) };
    });
    invalidateVideoParent(loaded?.parent);
    if (committed.Item) {
      let pending = true;
      const reportCommitted = () => {
        if (!pending) return;
        pending = false;
        this.library?.reportItemUpdated(committed.Item, committed.Parent, ItemUpdateType.MetadataImport);
      };
      if (notify) reportCommitted();
      else onCommitted?.(reportCommitted);
    }
    if (cacheKey) this.#cache.set(itemId, { key: cacheKey, info: structuredClone(info) });
    else this.#cache.delete(itemId);
    return { changed: true, reason: force ? 'forced' : missing ? 'missing-media-info' : 'source-changed', mediaInfo: info, externalStreamFailures: external?.failures ?? [], sourceConsistency: reliable ? 'versioned' : 'unversioned' };
    } catch (error) {
      operationFailed = true; operationError = error; throw error;
    } finally {
      try { await loaded?.dispose(); }
      catch (cleanup) {
        if (operationFailed) throw new AggregateError([operationError, cleanup], operationError?.message, { cause: operationError });
        throw cleanup;
      }
    }
  }

  async close() {
    this.#lifetime.abort();
    await Promise.allSettled([...this.#active.values(), ...this.#reads]);
    if (this.ownsBridge) await this.bridge.close();
    await this.ownedMetadataImages?.close();
    this.#cache.clear();
  }
}
