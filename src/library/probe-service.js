import path from 'node:path';
import { tableDefinition } from '../database/model.js';
import { parseLosslessJson } from '../core/json.js';
import { nativeGuid } from '../users/native.js';
import { nativeDate } from '../sessions/user-data.js';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { probeRaw, probeRemoteRaw } from '../storage/ffprobe.js';
import { decodeNativeText } from '../core/native-text.js';
import { clrTrim } from '../metadata/whitespace.js';
import { normalizeProbe } from '../storage/probe-normalizer.js';
import { getDvdMediaFiles, verifyDvdMediaFiles } from '../storage/dvd-media-files.js';
import { readBlurayDiscInfo, verifyBlurayDiscInfo } from '../storage/bluray-disc-info.js';
import { mergeBlurayProbe } from '../storage/bluray-probe-info.js';
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
import { cloneNativeItemEntity } from './native-item-entity.js';

const streamTypes = ['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric'];
const values = (table, source) => Object.fromEntries(tableDefinition(table).columns.map(column => [column.name, source[column.name] ?? (column.nullable ? null : column.clrType === 'bool' ? false : 0)]));
export function probeStreamRow(itemId, stream) {
  return values('MediaStreamInfos', { ...stream, ItemId: itemId, StreamIndex: stream.Index, StreamType: streamTypes.indexOf(stream.Type), IsAvc: stream.IsAVC });
}
const dataOf = item => itemRequiresJson(item) && item.Data ? parseLosslessJson(item.Data) : {};
const persistData = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry);
const audioShortcut = item => item.IsShortcut && ['Audio', 'AudioBook'].includes(String(item.Type).split('.').at(-1));

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
  constructor({ store, vfs, identityMap, bridge, probeOptions = {}, localization, library, externalData, logger = { error() {} }, probe = probeRaw, probeRemote = probeRemoteRaw, loadContext, updates }) {
    if (!store || !vfs || !identityMap) throw new TypeError('Probe service requires native persistence, VFS and identity mappings.');
    this.store = store;
    this.vfs = vfs;
    this.identityMap = identityMap;
    this.bridge = bridge ?? new ProbeReadBridge(vfs);
    this.ownsBridge = !bridge;
    this.probeOptions = probeOptions;
    this.localization = localization;
    this.library = library;
    this.logger = logger;
    this.probe = probe;
    this.probeRemote = probeRemote;
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
      const options = { ...this.probeOptions, extractChapters: false, signal: this.#lifetime.signal };
      // Episode.BeforeMetadataRefresh reads its current static media source;
      // FetchShortcutInfo runs later in the ordinary probe provider.
      if (probeIsVideo(item) && item.IsShortcut && /^(?:https?|rtsp|rtp):/iu.test(item.ShortcutPath ?? '')) {
        const result = await this.probeRemote(item.ShortcutPath, options);
        return normalizeProbe(result.raw, { path: item.ShortcutPath, isAudio: false });
      }
      const virtualPath = loaded.context?.accessPath ?? this.identityMap.resolve({ itemId: item.Id, identityPath: item.Path,
        style: /^[A-Za-z]:[\\/]|^\\\\/u.test(item.Path) ? 'windows' : 'posix' });
      const result = await this.probe(this.bridge, virtualPath, options);
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
    if (audioShortcut(loaded.item) && !options.EnableRemoteContentProbe) {
      await this.#readShortcut(loaded.item, { signal: options.signal, virtualPath: loaded.context?.accessPath });
      // FetchShortcutInfo mutates the live item; the owning MetadataService
      // performs its ordinary final save. No technical data is replaced.
      return { changed: false, reason: 'shortcut-read', UpdateType: ItemUpdateType.MetadataImport };
    }
    const result = await this.refresh(loaded.item.Id, { force: true, signal: options.signal, virtualPath: loaded.context?.accessPath, notify: false,
      onCommitted, externalDataInvalidated, replaceAllMetadata: options.ReplaceAllMetadata ?? false, metadataRefreshMode: options.MetadataRefreshMode ?? 'FullRefresh',
      enableRemoteContentProbe: options.EnableRemoteContentProbe ?? false,
      onShortcutRead: target => { loaded.item.ShortcutPath = target; } });
    return { ...result, UpdateType: result.UpdateType ?? (result.changed ? 2 : 1) };
  }

  async #readShortcut(item, { signal, virtualPath, before } = {}) {
    this.#lifetime.signal.throwIfAborted();
    signal = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const work = (async () => {
      checkAbort(signal);
      virtualPath ??= this.identityMap.resolve({ itemId: item.Id, identityPath: item.Path,
        style: /^[A-Za-z]:[\\/]|^\\\\/u.test(item.Path) ? 'windows' : 'posix' });
      before ??= await this.vfs.stat(virtualPath, { signal });
      if (before.kind !== 'file') throw new StorageError('is-directory', 'Shortcut source must be a file.');
      const version = this.vfs.capabilities(virtualPath).reliableVersion === true ? before.version : undefined;
      const handle = await this.vfs.openRead(virtualPath, { signal, ifMatch: version ?? undefined });
      let text;
      try {
        const chunks = [];
        for await (const chunk of handle.stream) { checkAbort(signal); chunks.push(Buffer.from(chunk)); }
        text = decodeNativeText(Buffer.concat(chunks));
      } finally { await handle.close(); }
      if (version != null && (await this.vfs.stat(virtualPath, { signal })).version !== version) {
        throw new StorageError('version-changed', 'The shortcut changed during its read.');
      }
      checkAbort(signal);
      const target = text.split(/\r\n|\r|\n/u).map(line => clrTrim(line.replaceAll('\t', '')))
        .find(line => line && !line.startsWith('#'));
      if (target) {
        let valid = false;
        try { valid = !target.includes('\0') && ['http:', 'https:', 'rtsp:', 'rtp:'].includes(new URL(target).protocol); }
        catch { /* Invalid first entries do not select a later line. */ }
        if (valid) item.ShortcutPath = target;
        else this.logger.warn?.('Ignoring an invalid or non-remote shortcut target.');
      }
      return item.ShortcutPath;
    })();
    this.#reads.add(work);
    try { return await work; } finally { this.#reads.delete(work); }
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
    const directoryVideo = probeIsVideo(item) && ['Dvd', 'BluRay', 2, 3].includes(item.VideoType);
    return externalCandidates(this.vfs, virtualPath, item.Path, { signal, additionalDirectories,
      sourceIsDirectory: directoryVideo && !item.IsPlaceHolder && !item.AdditionalParts?.length,
      useFullFileName: directoryVideo, types: probeIsVideo(item) ? ['Subtitle', 'Audio'] : ['Lyric'] });
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

  async #refresh(itemId, { force = false, signal, virtualPath, replaceAllMetadata = false, metadataRefreshMode = 'Default', notify = true, onCommitted, externalDataInvalidated = false,
    enableRemoteContentProbe = false, onShortcutRead } = {}) {
    checkAbort(signal);
    const item = await this.store.run(async database => (await database.rows('BaseItems', { where: { Id: itemId } }))[0]);
    if (!item) throw new StorageError('not-found', 'The media item does not exist.');
    const data = dataOf(item);
    const loaded = this.loadContext ? await this.loadContext(itemId) : null;
    let operationFailed = false, operationError;
    try {
    const libraryOptions = loaded?.libraryOptions ?? defaultLibraryOptions();
    if (item.IsFolder || item.IsVirtualItem || data.IsPlaceHolder || !['Video', 'Audio'].includes(item.MediaType)) return { changed: false, reason: 'not-probeable' };
    const shortcut = Boolean((loaded?.item ?? { ...data, ...item }).IsShortcut);
    const dvd = ['Dvd', 2].includes(data.VideoType);
    const bluray = ['BluRay', 3].includes(data.VideoType);
    const directoryDisc = dvd || bluray;
    if (data.VideoType && !['VideoFile', 'Iso', 'Dvd', 'BluRay', 0, 1, 2, 3].includes(data.VideoType)) throw new StorageError('not-supported', 'Unsupported video source kind.');
    const identityPath = loaded?.item.Path ?? item.Path;
    virtualPath ??= loaded?.context.accessPath ?? this.identityMap.resolve({ itemId, identityPath, style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? 'windows' : 'posix' });
    const before = await this.vfs.stat(virtualPath, { signal });
    if (before.kind !== (directoryDisc ? 'directory' : 'file')) throw new StorageError(directoryDisc ? 'not-directory' : 'is-directory', 'Probe source has the wrong media kind.');
    let shortcutPath;
    if (shortcut) {
      shortcutPath = await this.#readShortcut(loaded?.item ?? { ...data, ...item }, { signal, virtualPath, before });
      onShortcutRead?.(shortcutPath);
      if (!enableRemoteContentProbe && item.MediaType === 'Audio') {
        const committed = await this.store.transaction(async database => {
          const current = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
          if (!current || current.Data !== item.Data || current.Path !== item.Path || current.DateModified !== item.DateModified) {
            throw new StorageError('version-changed', 'The media item changed during shortcut reading.');
          }
          if (loaded) await persistMetadataInDatabase(database, loaded, { Item: loaded.item }, { signal });
          else await database.update('BaseItems', { Id: itemId }, { Data: persistData({ ...data, ShortcutPath: shortcutPath ?? null }) });
          checkAbort(signal);
          return { Item: mapRecord((await database.rows('BaseItems', { where: { Id: itemId } }))[0]), Parent: loaded?.parent ?? null };
        });
        this.#reportCommit(committed, notify, onCommitted);
        return { changed: true, reason: 'shortcut-read' };
      }
    }
    const videoSourceModified = probeIsVideo(item) && probeFileChanged(item, before.modified);
    if (videoSourceModified && !externalDataInvalidated) {
      // BeforeSave prunes extracted files and all four data sets before probing.
      await this.externalData.invalidateChangedVideo(loaded?.item ?? { ...data, ...item, Type: item.Type.split('.').at(-1) }, before.modified, { loaded, expectedSnapshot: item });
      checkAbort(signal);
    }
    // A directory version does not bind the selected media or playlist contents.
    const reliable = !directoryDisc && this.vfs.capabilities(virtualPath).reliableVersion === true && before.version != null;
    const candidates = await this.#externalCandidates(loaded?.item ?? { ...data, ...item, Path: identityPath }, loaded, virtualPath, signal);
    const candidatesReliable = candidates.every(candidate => candidate.version != null && this.vfs.capabilities(candidate.virtualPath).reliableVersion === true);
    const cacheKey = !shortcut && reliable && candidatesReliable ? `${virtualPath}\0${before.version}\0${item.Path}\0${item.MediaType}\0${persistData(candidates)}\0${persistData(libraryOptions)}\0${replaceAllMetadata}\0${metadataRefreshMode}` : null;
    const cached = this.#cache.get(itemId);
    if (!force && cacheKey && cached?.key === cacheKey) return { changed: false, reason: 'unchanged-version', mediaInfo: structuredClone(cached.info), sourceConsistency: 'versioned' };
    const missing = item.RunTimeTicks == null && item.TotalBitrate == null;
    const modified = before.modified != null && item.DateModified != null && new Date(before.modified).getTime() !== new Date(item.DateModified.replace(' ', 'T') + (item.DateModified.endsWith('Z') ? '' : 'Z')).getTime();
    if (!shortcut && !force && !cached && !missing && !modified && item.MediaType !== 'Video') return { changed: false, reason: 'native-fields-present' };
    const probeOptions = { ...this.probeOptions, extractChapters: item.MediaType === 'Video' || item.Type.endsWith('.AudioBook'), signal };
    let info, dvdFiles, blurayPlan;
    if (bluray) {
      try { blurayPlan = await readBlurayDiscInfo(this.vfs, virtualPath, { signal }); }
      catch (error) {
        checkAbort(signal);
        if (['cancelled', 'version-changed', 'incomplete-listing', 'not-supported'].includes(error.code)) throw error;
        this.logger.error(error, 'Error getting Blu-ray disc information.');
        return { changed: false, reason: 'bluray-info-unavailable', UpdateType: ItemUpdateType.MetadataImport };
      }
      // A scanned disc without a valid playlist is not Fetch(null), which would
      // clear attachments and refresh external streams as a shortcut does.
      if (!blurayPlan) throw new StorageError('invalid-response', 'The Blu-ray disc contains no valid playlist.');
      const firstFile = blurayPlan.files[0];
      let reference;
      if (blurayPlan.referenceFile.virtualPath !== firstFile.virtualPath) {
        try { reference = await this.probe(this.bridge, blurayPlan.referenceFile.virtualPath, { ...probeOptions, extractChapters: false }); }
        catch (error) {
          // BDROM.Scan rethrows elementary stream read failures to GetBDInfo,
          // which logs and returns without running Fetch. Keep source failures
          // distinct from the later, ordinary first-file ffprobe failure.
          checkAbort(signal);
          if (['cancelled', 'version-changed', 'incomplete-listing', 'not-supported'].includes(error.code)) throw error;
          await verifyBlurayDiscInfo(this.vfs, blurayPlan, { signal });
          this.logger.error(error, 'Error reading Blu-ray reference media information.');
          return { changed: false, reason: 'bluray-reference-unavailable', UpdateType: ItemUpdateType.MetadataImport };
        }
      }
      checkAbort(signal);
      // GetBDInfo finishes before the ordinary first-file probe. When both use
      // the same source, its single ordinary probe retains the failure boundary.
      const result = await this.probe(this.bridge, firstFile.virtualPath, probeOptions);
      reference ??= result;
      const api = /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? path.win32 : path.posix;
      info = normalizeProbe(result.raw, { path: api.join(identityPath, firstFile.virtualPath.slice(virtualPath.length + 1)), isAudio: false });
      if (['ts', 'm2ts', 'mpeg2ts'].includes(info.Container?.toLowerCase())) {
        info.Timestamp = await transportTimestamp(this.vfs, firstFile.virtualPath, { signal, version: firstFile.version ?? undefined });
      }
      checkAbort(signal);
      info = mergeBlurayProbe(blurayPlan, info, reference.raw);
    } else if (dvd) {
      dvdFiles = await getDvdMediaFiles(this.vfs, virtualPath, { signal });
      const api = /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? path.win32 : path.posix;
      for (const file of dvdFiles) {
        checkAbort(signal);
        const result = await this.probe(this.bridge, file.virtualPath, probeOptions);
        const fileIdentity = api.join(identityPath, file.virtualPath.slice(virtualPath.length + 1));
        const current = normalizeProbe(result.raw, { path: fileIdentity, isAudio: false });
        if (!info) {
          info = current;
          if (['ts', 'm2ts', 'mpeg2ts'].includes(info.Container?.toLowerCase())) {
            info.Timestamp = await transportTimestamp(this.vfs, file.virtualPath, { signal, version: file.reliable ? file.version : undefined });
          }
        } else info.RunTimeTicks = info.RunTimeTicks == null || current.RunTimeTicks == null ? null : info.RunTimeTicks + current.RunTimeTicks;
      }
    } else {
      const result = shortcut && !enableRemoteContentProbe ? null
        : shortcut ? await this.probeRemote(shortcutPath, probeOptions) : await this.probe(this.bridge, virtualPath, probeOptions);
      info = result ? normalizeProbe(result.raw, { path: identityPath, isAudio: item.MediaType === 'Audio' }) : null;
    }
    if (!shortcut && item.MediaType === 'Video' && [undefined, null, 'VideoFile', 0].includes(data.VideoType)
      && ['ts', 'm2ts', 'mpeg2ts'].includes(info.Container?.toLowerCase())) {
      info.Timestamp = await transportTimestamp(this.vfs, virtualPath, { signal, version: reliable ? before.version : undefined });
    }
    const external = item.MediaType === 'Video' ? await discoverExternalStreams(candidates, { probe: this.probe, bridge: this.bridge, probeOptions: this.probeOptions, signal }) : null;
    if (candidatesReliable) for (const candidate of candidates) if ((await this.vfs.stat(candidate.virtualPath, { signal })).version !== candidate.version) throw new StorageError('version-changed', 'An external stream changed during probing.');
    if (dvdFiles) await verifyDvdMediaFiles(this.vfs, virtualPath, dvdFiles, { signal });
    if (blurayPlan) await verifyBlurayDiscInfo(this.vfs, blurayPlan, { signal });
    const after = await this.vfs.stat(virtualPath, { signal });
    if (reliable && after.version !== before.version) throw new StorageError('version-changed', 'Media changed during probing.');
    checkAbort(signal);
    // FFProbeVideoInfo.Fetch(null) still refreshes local streams and chapters,
    // but does not import embedded metadata or replace scalar media information.
    const metadata = loaded && (info ? applyProbeMetadata(loaded, info, { replaceAllMetadata }) : { Item: cloneNativeItemEntity(loaded.item) });
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
      const internalStreams = info ? info.MediaStreams : (await database.rows('MediaStreamInfos', { where: { ItemId: itemId, IsExternal: false } }))
        .sort((a, b) => a.StreamIndex - b.StreamIndex)
        .map(row => ({ ...row, Index: row.StreamIndex, Type: streamTypes[row.StreamType], IsAVC: row.IsAvc }));
      const streams = external ? [...external.Subtitle, ...external.Audio, ...internalStreams].map((stream, Index) => ({ ...stream, Index })) : [...internalStreams];
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
      const attachmentRows = (info?.MediaAttachments ?? []).map(attachment => values('AttachmentStreamInfos', {
        ...attachment, ItemId: itemId, Filename: attachment.FileName,
      }));
      await database.insertBatch('AttachmentStreamInfos', attachmentRows);
      const chapters = item.MediaType === 'Video' ? normalizeProbeChapters(info?.Chapters ?? [], { runtime: info ? info.RunTimeTicks : item.RunTimeTicks, dummyChapterDuration: loaded?.globalOptions?.DummyChapterDuration,
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
      const nextData = { ...dataOf(refreshed) };
      if (info) nextData.Container = info.Container;
      if (shortcut) nextData.ShortcutPath = shortcutPath;
      if (item.MediaType === 'Video') Object.assign(nextData, { DefaultVideoStreamIndex: video?.StreamIndex ?? null, HasSubtitles: rows.some(row => row.StreamType === 2),
        SubtitleFiles: [...new Set(external.Subtitle.map(stream => stream.Path))], AudioFiles: [...new Set(external.Audio.map(stream => stream.Path))],
        ...(info ? { Timestamp: info.Timestamp } : {}) });
      else Object.assign(nextData, { LyricFiles: [...new Set(candidates.map(candidate => candidate.identityPath))], HasLyrics: rows.some(row => row.StreamType === 5) });
      const changes = { Data: itemRequiresJson(item) ? persistData(nextData) : null, Size: directoryDisc ? info.Size : before.size ?? item.Size };
      if (info) Object.assign(changes, { RunTimeTicks: info.RunTimeTicks, TotalBitrate: info.Bitrate });
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
    this.#reportCommit(committed, notify, onCommitted);
    if (cacheKey) this.#cache.set(itemId, { key: cacheKey, info: structuredClone(info) });
    else this.#cache.delete(itemId);
    return { changed: true, reason: force ? 'forced' : missing ? 'missing-media-info' : 'source-changed', mediaInfo: info, externalStreamFailures: external?.failures ?? [], sourceConsistency: !shortcut && reliable ? 'versioned' : 'unversioned' };
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

  #reportCommit(committed, notify, onCommitted) {
    if (!committed.Item) return;
    let pending = true;
    const reportCommitted = () => {
      if (!pending) return;
      pending = false;
      this.library?.reportItemUpdated(committed.Item, committed.Parent, ItemUpdateType.MetadataImport);
    };
    if (notify) reportCommitted();
    else onCommitted?.(reportCommitted);
  }

  async close() {
    this.#lifetime.abort();
    await Promise.allSettled([...this.#active.values(), ...this.#reads]);
    if (this.ownsBridge) await this.bridge.close();
    await this.ownedMetadataImages?.close();
    this.#cache.clear();
  }
}
