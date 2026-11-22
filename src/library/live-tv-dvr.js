import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withCleanup } from '../core/operation-failure.js';
import { stageLiveTvStateFile } from '../database/live-tv-state-files.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { visitPostgresRowPlanPages } from '../database/postgres-item-query.js';
import { BinaryResult } from '../http/binary-result.js';
import { postProcessRecording, recordTransportStream } from '../media-execution/recording.js';
import { httpMediaUrl, isHlsManifest, udpMediaUrl } from '../media-execution/input.js';
import { LiveStreamReadBridge } from '../playback/live-stream-bridge.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { guideChannelId } from './live-tv-guide-channel.js';
import { isFileProtocol } from './owned-items.js';
import { findPostgresLinkedChildByPath } from './postgres-linked-child-resolution.js';
import { libraryError } from './records.js';

const terminal = new Set(['Cancelled', 'Completed']);
const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
const key = ordinalIgnoreCaseKey;
const publicationFile = 'publication.json';
const recordingEnd = timer => Date.parse(timer.EndDate) + timer.PostPaddingSeconds * 1000;
const fileIdentity = info => info.isFile() && info.ino ? [info.dev, info.ino, info.birthtimeNs].join(':') : null;
const captureUnavailable = () => Object.assign(new Error('The original recording file is unavailable.'), { code: 'recording-unavailable' });
const dateParts = value => {
  const date = new Date(value), two = number => String(number).padStart(2, '0');
  return [String(date.getFullYear()).padStart(4, '0'), two(date.getMonth() + 1), two(date.getDate()),
    two(date.getHours()), two(date.getMinutes()), two(date.getSeconds())];
};
const pathApi = filename => /^[A-Za-z]:[\\/]|^\\\\/u.test(filename) ? path.win32 : path.posix;

function recordingLocation(timer, configuration, dataPath) {
  const defaultPath = configuration.RecordingPath?.trim() ? configuration.RecordingPath : path.join(dataPath, 'livetv', 'recordings');
  const programSeries = timer.IsProgramSeries;
  const custom = programSeries ? configuration.SeriesRecordingPath : timer.IsMovie ? configuration.MovieRecordingPath : null;
  const root = custom?.trim() ? custom : defaultPath;
  const api = pathApi(root);
  const sanitize = value => String(value ?? '').replace(api === path.win32 ? /[<>:"/\\|?*\u0000-\u001f]/gu : /[/\\\u0000]/gu, '_').trim();
  const safeName = value => sanitize(value).replace(/[. ]+$/u, '') || 'Recording';
  const kids = timer.Tags?.some(tag => ordinalIgnoreCaseEquals(tag, 'Kids'));
  const sports = timer.Tags?.some(tag => ordinalIgnoreCaseEquals(tag, 'Sports'));
  const group = programSeries ? 'Series' : timer.IsMovie ? 'Movies' : kids ? 'Kids' : sports ? 'Sports' : 'Other';
  const parts = [root];
  if (configuration.EnableRecordingSubfolders && ordinalIgnoreCaseEquals(root, defaultPath)) parts.push(group);
  const year = timer.ProductionYear != null ? ` (${timer.ProductionYear})` : '';
  parts.push(safeName((timer.Name ?? '') + (!programSeries && (timer.IsMovie || kids) ? year : '')));
  const seriesPath = programSeries ? api.join(...parts) : undefined;
  if (programSeries && timer.SeasonNumber != null) parts.push(`Season ${timer.SeasonNumber}`);

  const stamp = dateParts(timer.StartDate).join('_');
  let name = timer.Name ?? '';
  if (programSeries) {
    const numbered = timer.SeasonNumber != null && timer.EpisodeNumber != null;
    if (numbered) name += ` S${String(timer.SeasonNumber).padStart(2, '0')}E${String(timer.EpisodeNumber).padStart(2, '0')}`;
    else name += ' ' + (timer.OriginalAirDate && timer.OriginalAirDate.slice(0, 10) !== timer.StartDate.slice(0, 10)
      ? dateParts(timer.OriginalAirDate).slice(0, 3).join('-') : stamp);
    const titled = name + (numbered ? ' ' : ' - ') + (timer.EpisodeTitle ?? '');
    if (timer.EpisodeTitle?.trim() && Buffer.byteLength(titled) < 250) name = titled;
  } else name += timer.IsMovie && year ? year : ' ' + stamp;
  return { api, directory: api.join(...parts), basename: safeName(name), seriesPath };
}

/** Each fired timer owns one recording, one input reservation and its growing file. */
export class LiveTvDvr {
  #jobs = new Map();
  #timers = new Map();
  #publications = new Map();
  #bridge = new LiveStreamReadBridge();
  #lifetime = new AbortController();
  #retention = Promise.resolve();
  #wake;
  #starting;
  #closing;
  #generation = 0;
  #ready = false;

  constructor({ fileSystem, mediaFileSystem = fileSystem, publicationRetryMs = 60000, ...options }) {
    Object.assign(this, options, { fileSystem, mediaFileSystem, publicationRetryMs });
  }

  start() {
    return this.#starting ??= (async () => {
      const generation = this.#generation;
      const timers = await this.timers.readRecordingTimers();
      this.#publications = await this.#recoverPublications();
      this.#ready = true;
      if (generation === this.#generation) this.syncTimers(timers);
      else this.#schedule();
    })().catch(error => {
      this.#ready = false;
      this.#starting = undefined;
      throw error;
    });
  }

  syncTimers(timers) {
    if (this.#lifetime.signal.aborted) return;
    this.#generation++;
    this.#timers = new Map(timers.filter(timer => !terminal.has(timer.Status)).map(timer => [key(timer.Id), timer]));
    for (const [id, job] of this.#jobs) if (!job.finishing && !this.#timers.has(id)) job.controller.abort();
    this.#schedule();
  }

  #report(error) { try { void Promise.resolve(this.onError?.(error)).catch(() => {}); } catch { /* Retain the original recording state. */ } }

  #schedule() {
    clearTimeout(this.#wake);
    if (!this.#ready || this.#lifetime.signal.aborted) return;
    let next = Infinity;
    const now = Date.now();
    const admit = (id, timer, due, publication) => {
      if (this.#jobs.has(id) || !Number.isFinite(due)) return;
      if (due > now) { next = Math.min(next, due); return; }
      const job = { controller: new AbortController(), readers: publication?.readers ?? new Set(),
        finishing: Boolean(publication), writing: false, path: publication?.path };
      this.#jobs.set(id, job);
      job.done = Promise.resolve().then(() => this.runBackground(() => this.#runJob(job, timer, publication))).catch(error => {
        const pending = this.#publications.get(id);
        if (pending) pending.due = Date.now() + this.publicationRetryMs;
        else if (this.#timers.get(id)?.StartDate === timer.StartDate) this.#timers.delete(id);
        if (!this.#lifetime.signal.aborted) this.#report(error);
      }).finally(() => {
        this.#jobs.delete(id);
        this.#schedule();
      });
    };
    for (const [id, publication] of this.#publications) admit(id, publication.timer, publication.due, publication);
    for (const [id, timer] of this.#timers) {
      if (!this.#publications.has(id)) admit(id, timer, Date.parse(timer.StartDate) - 1000 * timer.PrePaddingSeconds);
    }
    if (Number.isFinite(next)) this.#wake = setTimeout(() => this.#schedule(), Math.min(2147483647, next - now)).unref();
  }

  isActive(id) { return Boolean(id && this.#jobs.get(key(id))?.writing); }

  #runJob(job, timer, publication) {
    job.storage = this.retainStorage?.() ?? { fileSystem: this.fileSystem, mediaFileSystem: this.mediaFileSystem };
    return withCleanup(() => publication ? this.#resumePublication(job, publication) : this.#record(job, timer),
      [() => Promise.allSettled(job.readers), () => job.storage.close?.()], 'Recording storage release failed.');
  }

  #publicationRoot(fileSystem) {
    const root = fileSystem.spoolRoot;
    return root ? pathApi(root).join(root, 'dvr-publications')
      : pathApi(this.dataPath).join(this.dataPath, 'livetv', 'dvr-publications');
  }

  async #createSpool(job, signal) {
    const { fileSystem } = job.storage, root = this.#publicationRoot(fileSystem);
    await fileSystem.mkdir(root, { recursive: true, signal });
    job.spool = await fileSystem.mkdtemp(pathApi(root).join(root, 'recording-'));
  }

  async #publicationBytes(fileSystem, readPath) {
    try {
      const file = await fileSystem.stat(readPath, { bigint: true });
      if (!file.isFile()) throw new Error('The staged recording is not a regular file.');
      return file.size;
    } catch (error) { if (missing(error)) return 0n; throw error; }
  }

  async #recoverPublications() {
    const publications = new Map();
    const { fileSystem } = this, root = this.#publicationRoot(fileSystem);
    let entries;
    try { entries = await fileSystem.readdir(root, { withFileTypes: true }); }
    catch (error) { if (missing(error)) return publications; throw error; }
    const api = pathApi(root);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^recording-[a-f0-9-]{36}$/u.test(entry.name)) continue;
      const spool = api.join(root, entry.name), stagedPath = api.join(spool, 'recording.ts');
      let metadata;
      try { metadata = await fileSystem.readFile(api.join(spool, publicationFile), 'utf8'); }
      catch (error) {
        if (!missing(error)) throw error;
        if (await this.#publicationBytes(fileSystem, stagedPath)) this.#report(error);
        else await fileSystem.rm(spool, { recursive: true, force: true });
        continue;
      }
      let state, phase;
      try {
        state = JSON.parse(metadata);
        // Older writers left retryCapture=false both during capture and before upload.
        phase = state?.phase ?? (state?.retryCapture ? 'publishing' : 'capturing');
        if (typeof state?.timer?.Id !== 'string' || !state.timer.Id.trim() || typeof state.path !== 'string'
          || !pathApi(state.path).isAbsolute(state.path) || !state.path.endsWith('.ts') || typeof state.retryCapture !== 'boolean'
          || state.fileIdentity !== undefined && !/^\d+:\d+:\d+$/u.test(state.fileIdentity)
          || state.mediaBinding !== undefined && !/^[a-f0-9]{64}$/u.test(state.mediaBinding)
          || !['capturing', 'publishing', 'post-processing', 'processed'].includes(phase)) {
          throw new Error('The staged recording has invalid publication metadata.');
        }
        const id = key(state.timer.Id);
        if (publications.has(id)) throw new Error('More than one staged recording exists for this timer.');
      } catch (error) { this.#report(error); continue; }
      if (!state.fileIdentity && !await this.#publicationBytes(fileSystem, stagedPath)) {
        await fileSystem.rm(spool, { recursive: true, force: true });
        continue;
      }
      publications.set(key(state.timer.Id), { ...state, phase, spool, readPath: state.fileIdentity ? state.path : stagedPath, due: 0 });
    }
    return publications;
  }

  async #savePublication(fileSystem, { spool, timer, path: filename, seriesPath, phase, retryCapture, fileIdentity, mediaBinding }) {
    const staged = await stageLiveTvStateFile(spool, publicationFile,
      JSON.stringify({ timer, path: filename, seriesPath, phase, retryCapture, fileIdentity, mediaBinding }), fileSystem);
    await withCleanup(async () => {
      await fileSystem.rename(staged.temporary, staged.filename);
      staged.published = true;
    }, [() => !staged.published && fileSystem.rm(staged.temporary, { force: true })], 'Recording publication metadata failed.');
  }

  async #setPublicationPhase(fileSystem, publication, phase) {
    await this.#savePublication(fileSystem, { ...publication, phase });
    publication.phase = phase;
  }

  async #openLocalCapture(fileSystem, publication, flags) {
    let handle, matched = false;
    try {
      handle = await fileSystem.open(publication.path, flags);
      const info = await handle.stat({ bigint: true });
      matched = fileIdentity(info) === publication.fileIdentity;
      return matched ? { handle, size: info.size } : { replaced: true };
    } catch (error) {
      if (!missing(error) && error.code !== 'EISDIR') throw error;
      return null;
    } finally { if (!matched) await handle?.close(); }
  }

  #canReplaceCapture(storage, publication, capture) {
    return capture?.replaced && (!storage.mediaBinding
      || publication.mediaBinding === storage.mediaBinding(publication.path));
  }

  async #reserveLocalCapture(job, timer, target, seriesPath, signal) {
    const { fileSystem, mediaFileSystem: media, mediaBinding } = job.storage;
    job.path = target;
    let handle;
    try { handle = await media.open(target, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    try {
      const identity = fileIdentity(await handle.stat({ bigint: true }));
      if (!identity) throw new Error('The local recording file has no stable identity.');
      await this.#createSpool(job, signal);
      const publication = { spool: job.spool, readPath: target, path: target, seriesPath, fileIdentity: identity,
        mediaBinding: mediaBinding?.(target), timer, phase: 'capturing', retryCapture: false, due: 0, readers: job.readers };
      await this.#savePublication(fileSystem, publication);
      job.publication = publication;
      job.readPath = target;
      return handle;
    } catch (error) {
      return withCleanup(() => { throw error; }, [() => handle.close(), () => media.rm(target, { force: true })],
        'The local recording could not be reserved.');
    }
  }

  #pathReserved(target, job, publication) {
    return [...this.#jobs.values()].some(other => other !== job && ordinalIgnoreCaseEquals(other.path, target))
      || [...this.#publications.values()].some(other => other !== publication && ordinalIgnoreCaseEquals(other.path, target));
  }

  async #openInput(channel, mediaFileSystem, signal) {
    const [candidate] = await this.mediaSources.getMediaSources(channel, { signal });
    if (!candidate) throw libraryError(404, 'The recording channel has no media source.');
    const owner = candidate.RequiresOpening && await this.liveStreams.openOwned({ ItemId: channel.Id, OpenToken: candidate.OpenToken }, { signal });
    const source = owner?.MediaSource ?? candidate;
    // Owned bytes take precedence. The original URL can provide a manifest's
    // relative origin or allow FFmpeg to receive UDP directly.
    let openRead = owner?.openRead;
    const http = !openRead && source.Protocol === 'Http' ? httpMediaUrl(source.Path) : undefined;
    const udp = !openRead && source.Protocol === 'Udp' ? udpMediaUrl(source.Path) : undefined;
    if (!openRead && source.Protocol === 'File') openRead = options => mediaFileSystem.openRead(source.Path, options);
    if (http) {
      openRead = async ({ signal: readSignal }) => {
        const controller = new AbortController();
        const combined = AbortSignal.any([readSignal, controller.signal]);
        const result = await fetch(http, { signal: combined, headers: source.RequiredHttpHeaders ?? {} });
        if (!result.ok || !result.body) { controller.abort(); throw libraryError(502, 'The tuner did not supply a recording body.'); }
        return { stream: result.body, close: () => controller.abort() };
      };
    }
    if (!openRead && !udp) {
      await owner?.release();
      throw libraryError(422, 'The tuner source protocol has no recording input.');
    }
    const mappedHls = !owner?.openRead && source.Protocol === 'File'
      && (isHlsManifest(source.Container) || /\.m3u8?$/iu.test(source.Path ?? ''));
    return { source, openRead, url: http ?? udp, mappedHls, close: () => owner?.release() };
  }

  async #openOutput(job, timer, { api, directory, basename, seriesPath }, signal) {
    const { fileSystem, mediaFileSystem: media } = job.storage;
    if (job.publication) {
      if (!job.publication.fileIdentity) return fileSystem.open(job.readPath, 'a');
      const previous = await this.#openLocalCapture(media, job.publication, 'r+');
      if (previous?.handle) {
        job.position = previous.size;
        return previous.handle;
      }
      if (!this.#canReplaceCapture(job.storage, job.publication, previous)) throw captureUnavailable();
      await this.#clearPublication(job, job.publication);
      job.path = job.readPath = job.publication = undefined;
    }
    await media.mkdir(directory, { recursive: true, signal });
    const { adapter, mount } = media.resolve(directory);
    const staged = !adapter.openFile || !mount.capabilities.replace;
    if (staged) {
      if (!fileSystem.spoolRoot) throw new Error('Recording requires writable spool storage for this destination.');
      await this.#createSpool(job, signal);
      job.readPath = pathApi(job.spool).join(job.spool, 'recording.ts');
    }
    for (let suffix = 1; ; suffix++) {
      signal.throwIfAborted();
      const target = api.join(directory, basename + '.ts');
      if (!this.#pathReserved(target, job)) {
        if (staged) {
          let exists = false;
          try { await media.stat(target, { signal }); exists = true; } catch (error) { if (!missing(error)) throw error; }
          if (!exists && !this.#pathReserved(target, job)) {
            job.path = target;
            job.publication = { spool: job.spool, readPath: job.readPath, path: target, seriesPath,
              timer, phase: 'capturing', retryCapture: false, due: 0, readers: job.readers };
            await this.#savePublication(fileSystem, job.publication);
            return fileSystem.open(job.readPath, 'wx');
          }
        } else {
          const handle = await this.#reserveLocalCapture(job, timer, target, seriesPath, signal);
          if (handle) return handle;
        }
      }
      basename += ` - ${suffix}`;
    }
  }

  async #checksum(fileSystem, filename, size, signal) {
    const handle = await fileSystem.openRead(filename, { signal });
    return withCleanup(async () => {
      if (handle.contentLength != null && handle.contentLength !== size) return null;
      let bytes = 0n;
      const hash = createHash('sha256');
      for await (const chunk of handle.stream) {
        signal.throwIfAborted();
        bytes += BigInt(chunk.length);
        if (bytes > size) return null;
        hash.update(chunk);
      }
      return bytes === size ? hash.digest('hex') : null;
    }, [() => handle.close()], 'Recording verification failed.');
  }

  async #publishRecording(job, publication, size, signal) {
    const api = pathApi(publication.path), original = api.parse(publication.path);
    const { fileSystem } = job.storage;
    let suffix = 0, sourceHash;
    for (;;) {
      signal.throwIfAborted();
      const target = publication.path;
      let existing;
      try { existing = await this.mediaFileSystem.stat(target, { signal }); }
      catch (error) { if (!missing(error)) throw error; }
      if (!existing) {
        let handle;
        this.monitor?.reportFileSystemChangeBeginning(target);
        await withCleanup(async () => {
          handle = await fileSystem.openRead(publication.readPath, { signal });
          await this.mediaFileSystem.writeFile(target, handle.stream, { flag: 'wx', size, signal });
        }, [() => handle?.close(), () => this.monitor?.reportFileSystemChangeComplete(target, false)], 'Recording publication failed.');
        return;
      }
      if (existing.isFile()) {
        const targetHash = await this.#checksum(this.mediaFileSystem, target, size, signal);
        if (targetHash !== null) {
          sourceHash ??= await this.#checksum(fileSystem, publication.readPath, size, signal);
          if (targetHash === sourceHash) return;
        }
      }
      do { job.path = api.join(original.dir, `${original.name} - ${++suffix}${original.ext}`); }
      while (this.#pathReserved(job.path, job, publication));
      // A restart must resume the last reserved name, including when the
      // remote write completed but its response or the timer update was lost.
      await this.#savePublication(fileSystem, { ...publication, path: job.path });
      publication.path = job.path;
    }
  }

  async #verifyCurrentCapture(publication) {
    if (!publication.fileIdentity) return;
    const direct = await this.#openLocalCapture(this.mediaFileSystem, publication, 'r');
    if (!direct?.handle) throw captureUnavailable();
    await direct.handle.close();
  }

  async #scanRecording(publication) {
    if (this.#lifetime.signal.aborted) return false;
    await this.#verifyCurrentCapture(publication);
    await this.folders?.reconcile();
    if (this.#lifetime.signal.aborted) return false;
    await this.queueLibraryScan?.();
    return true;
  }

  async #finishTimer(timer, filename, retryCapture, { confirm = false } = {}) {
    if (retryCapture) {
      const saved = await this.timers.updateRecordingTimer(timer, { Status: 'New', PrePaddingSeconds: 0,
        StartDate: new Date(Date.now() + 60000).toISOString(), RetryCount: timer.RetryCount + 1 });
      if (confirm && !saved) throw new Error('The recording timer retry could not be saved.');
    } else if (filename) {
      const saved = await this.timers.updateRecordingTimer(timer, { Status: 'Completed', RecordingPath: filename }, { finish: true });
      if (confirm && !saved) throw new Error('The recording timer completion could not be saved.');
    } else await this.timers.updateRecordingTimer(timer, null);
  }

  async #resumePublication(job, publication) {
    const id = key(publication.timer.Id);
    if (publication.phase === 'capturing') {
      const current = this.#timers.get(id);
      if (current && Date.now() < recordingEnd(current)) {
        if (publication.fileIdentity) {
          const direct = await this.#openLocalCapture(job.storage.mediaFileSystem, publication, 'r');
          if (!direct?.handle && !this.#canReplaceCapture(job.storage, publication, direct)) throw captureUnavailable();
          await direct?.handle?.close();
        }
        job.spool = publication.spool;
        job.readPath = publication.readPath;
        job.publication = publication;
        job.finishing = false;
        return this.#record(job, current);
      }
      await this.#setPublicationPhase(job.storage.fileSystem, publication, 'publishing');
    }
    return this.#finishPublication(job, publication);
  }

  async #finishPublication(job, publication) {
    const { timer, readPath, seriesPath } = publication, signal = this.#lifetime.signal;
    const { fileSystem, mediaFileSystem } = job.storage;
    signal.throwIfAborted();
    const current = (await this.timers.readRecordingTimers()).find(candidate => key(candidate.Id) === key(timer.Id));
    let scan = true;
    if (current?.Status === 'Completed') {
      if (current.RecordingPath !== publication.path) throw new Error('The recording timer was completed with a different file.');
    } else if (!(publication.retryCapture && current?.RetryCount > timer.RetryCount)) {
      const direct = publication.fileIdentity && await this.#openLocalCapture(mediaFileSystem, publication, 'r');
      if (publication.fileIdentity && !direct?.handle) throw captureUnavailable();
      const size = direct ? direct.size : await this.#publicationBytes(fileSystem, readPath);
      await direct?.handle?.close();
      if (size && !publication.fileIdentity) {
        await this.#savePublication(fileSystem, publication);
        await this.#publishRecording(job, publication, size, signal);
        try {
          const configuration = await this.configuration.getConfiguration();
          await this.saveAssets?.({ timer, filename: publication.path, seriesPath, configuration, signal, fileSystem: this.fileSystem });
          await this.#enforceKeepUpTo(timer.SeriesTimerId, seriesPath);
        } catch (error) { this.#report(error); }
      }
      if (direct && !size) {
        await Promise.allSettled([...job.readers]);
        await mediaFileSystem.rm(publication.path, { force: true });
      }
      const retry = publication.retryCapture && current && current.Status !== 'Cancelled' && Date.now() < Date.parse(timer.EndDate);
      // If the timer commit succeeds but the runtime stops before seeing its
      // result, recovery still owns the recording's pending post-processing.
      if (size && !retry && publication.phase === 'publishing') await this.#setPublicationPhase(fileSystem, publication, 'post-processing');
      await this.#finishTimer(timer, size ? publication.path : null, retry, { confirm: Boolean(size) });
      scan = Boolean(size);
    }
    if (publication.phase === 'post-processing') {
      // As in Native, normal shutdown joins an admitted post-processor.
      // Keep the journal until it records that the attempt has finished.
      await this.#verifyCurrentCapture(publication);
      if (signal.aborted) return;
      try { await postProcessRecording(await this.configuration.getConfiguration(), publication.path); }
      catch (error) { this.#report(error); }
      await this.#setPublicationPhase(fileSystem, publication, 'processed');
    }
    if (scan && !await this.#scanRecording(publication)) return;
    await Promise.allSettled([...job.readers]);
    await this.#clearPublication(job, publication);
  }

  async #clearPublication(job, { timer, spool }) {
    await job.storage.fileSystem.rm(spool, { recursive: true, force: true });
    this.#publications.delete(key(timer.Id));
    job.spool = null;
  }

  #enforceKeepUpTo(seriesId, seriesPath, isCurrent = () => true) {
    if (!seriesId?.trim() || !seriesPath) return;
    const work = this.#retention.then(() => this.#pruneRecordings(seriesId, seriesPath, isCurrent));
    this.#retention = work.catch(error => { if (!this.#lifetime.signal.aborted) this.#report(error); });
    return this.#retention;
  }

  #pruneRecordings(seriesId, seriesPath, isCurrent) {
    const signal = this.#lifetime.signal, available = () => !signal.aborted && isCurrent();
    if (!available()) return;
    const { library, mediaFileSystem: fileSystem } = this;
    const findByPath = (identity, isFolder) => findPostgresLinkedChildByPath({ library, store: library.store,
      itemCreation: library.itemCreation }, identity, isFolder);
    const active = identity => [...this.#jobs.values()].some(job => ordinalIgnoreCaseEquals(job.path, identity));
    const eligible = async identity => {
      if (active(identity)) return false;
      try { return (await fileSystem.stat(identity)).isFile(); }
      catch (error) { if (!missing(error)) this.#report(error); return false; }
    };
    return this.timers.withRecordingRetention(seriesId, { signal }, async ({ keepPrevious, visitTimers }) => {
      let keep = keepPrevious;
      await visitTimers(async timers => {
        const removed = [];
        for (const timer of timers) {
          if (!available()) break;
          if (!await eligible(timer.RecordingPath) || keep-- > 0) continue;
          try {
            const item = await findByPath(timer.RecordingPath, false);
            if (!available() || active(timer.RecordingPath)) continue;
            if (item) await library.deleteItem(item, { DeleteFileLocation: true });
            else await fileSystem.unlink(timer.RecordingPath);
            removed.push(timer);
          } catch (error) { this.#report(error); }
        }
        await this.timers.removeCompletedRecordings(removed);
      });
      if (!available()) return;
      const series = await findByPath(seriesPath, true);
      if (!series) return;
      const query = { parentId: series.Id, recursive: true, filters: ['IsNotFolder'],
        excludeLocationTypes: ['Virtual'], sortBy: ['DateCreated'], sortOrder: ['Descending'], enableTotalRecordCount: false };
      keep = keepPrevious;
      // The cursor freezes the ordered IDs before deleting any of them.
      await library.withItemQueryPlan(query, {}, (database, plan) => visitPostgresRowPlanPages(database, plan, { signal }, async rows => {
        for (const row of rows) {
          if (!available()) return;
          if (row.Id == null) continue;
          const item = await library.itemCreation.getItemById(decodeNativeTextBytes(row.Id));
          if (!item || !isFileProtocol(item) || !await eligible(item.Path) || keep-- > 0 || !available() || active(item.Path)) continue;
          try { await library.deleteItem(item, { DeleteFileLocation: true }); }
          catch (error) { this.#report(error); }
        }
      }));
    });
  }

  async #record(job, timer) {
    const { fileSystem, mediaFileSystem, isCurrent } = job.storage;
    const stop = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, job.controller.signal, stop.signal]);
    const end = recordingEnd(timer);
    const deadline = () => {
      const remaining = end - Date.now();
      if (remaining <= 0) stop.abort();
      else job.deadline = setTimeout(deadline, Math.min(2147483647, remaining)).unref();
    };
    let input, output, reader, bridge, failure, interrupted, monitored, written = 0;
    const write = async bytes => {
      if (job.position === undefined) await output.writeFile(bytes);
      else {
        // Reopen without creating a new file, and append to the verified handle.
        for (let offset = 0; offset < bytes.length;) {
          const position = Number(job.position);
          if (!Number.isSafeInteger(position)) throw new RangeError('The recording append position exceeds the file writer range.');
          const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset, position);
          if (!bytesWritten) throw new Error('The recording output could not write more bytes.');
          offset += bytesWritten;
          job.position += BigInt(bytesWritten);
        }
      }
      written += bytes.length;
    };
    try {
      deadline();
      if (!signal.aborted) {
        const channel = await this.library.itemCreation.getItemById(guideChannelId('Emby', timer.ChannelId));
        if (channel?.Type !== 'LiveTvChannel') throw libraryError(404, 'The recording channel was not found.');
        const configuration = await this.configuration.getConfiguration();
        const location = recordingLocation(timer, configuration, this.dataPath);
        input = await this.#openInput(channel, mediaFileSystem, signal);
        output = await this.#openOutput(job, timer, location, signal);
        if (job.publication.fileIdentity) {
          this.monitor?.reportFileSystemChangeBeginning(job.path);
          monitored = true;
        }
        const onStarted = async () => {
          const saved = await this.timers.updateRecordingTimer(timer, { Status: 'InProgress' });
          if (!saved) job.controller.abort();
          signal.throwIfAborted();
          job.writing = true;
          if (!job.publication.fileIdentity) return;
          const { seriesPath } = job.publication;
          job.assets = Promise.resolve().then(async () => {
            await this.saveAssets?.({ timer, filename: job.path, seriesPath, configuration, signal: this.#lifetime.signal, fileSystem });
            await this.folders?.reconcile();
            await this.#enforceKeepUpTo(timer.SeriesTimerId, seriesPath, isCurrent);
          }).catch(error => this.#report(error));
        };
        const { source } = input;
        if (input.mappedHls) {
          bridge = await this.#bridge.leaseMappedHls(mediaFileSystem.vfs, mediaFileSystem.accessPath(source.Path), { signal });
          await recordTransportStream(this.mediaEncoder, source, bridge.url, write, onStarted, { signal, mappedHls: true });
        } else if (!source.RequiresLooping && /ts$/iu.test(source.Container ?? '') && ['File', 'Http'].includes(source.Protocol)) {
          reader = await input.openRead({ signal });
          await onStarted();
          for await (const bytes of reader.stream) {
            signal.throwIfAborted();
            await write(bytes);
          }
        } else if (input.url) {
          await recordTransportStream(this.mediaEncoder, source, input.url, write, onStarted, { signal, requestHeaders: source.RequiredHttpHeaders });
        } else {
          bridge = await this.#bridge.lease(input.openRead);
          await recordTransportStream(this.mediaEncoder, source, bridge.url, write, onStarted, { signal });
        }
      }
    } catch (error) { if (!signal.aborted) { failure = error; this.#report(error); } }
    finally {
      interrupted = this.#lifetime.signal.aborted && !job.controller.signal.aborted && Date.now() < end;
      clearTimeout(job.deadline);
      job.writing = false;
      job.finishing = true;
    }
    for (const release of [() => reader?.close(), () => bridge?.release(), () => input?.close()]) {
      try { await release(); } catch (error) { this.#report(error); }
    }
    await withCleanup(async () => {
      try {
        await withCleanup(async () => { if (written) await output.sync?.(); },
          [() => output?.close()], 'Recording output failed to close.');
      }
      catch (error) { failure = error; this.#report(error); }
      await job.assets;
      if (interrupted) return;
      if (!output && failure?.code === 'recording-unavailable') throw failure;
      const retryCapture = Boolean(failure && !signal.aborted && Date.now() < Date.parse(timer.EndDate) && timer.RetryCount < 10);
      if (job.publication) {
        job.publication.timer = timer;
        job.publication.phase = 'publishing';
        job.publication.retryCapture = retryCapture;
        this.#publications.set(key(timer.Id), job.publication);
        if (this.#lifetime.signal.aborted) {
          await this.#savePublication(fileSystem, job.publication);
          return;
        }
        await this.#finishPublication(job, job.publication);
        return;
      }
      await this.#finishTimer(timer, null, retryCapture);
    }, [() => monitored && this.monitor?.reportFileSystemChangeComplete(job.path, false),
      async () => {
        if (!job.spool || job.publication) return;
        await Promise.allSettled([...job.readers]);
        await fileSystem.rm(job.spool, { recursive: true, force: true });
      }], 'Recording finalization failed.');
  }

  streamFile(id) {
    const job = this.#jobs.get(key(id));
    if (!job?.writing) return null;
    return new BinaryResult(async (request, response) => {
      if (!job.writing) throw libraryError(404, 'The active recording was not found.');
      const completion = Promise.withResolvers();
      job.readers.add(completion.promise);
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.#lifetime.signal]);
      const stop = () => abort.abort();
      request.once('aborted', stop); response.once('close', stop);
      let handle;
      try {
        const fileSystem = job.publication.fileIdentity ? job.storage.mediaFileSystem : job.storage.fileSystem;
        handle = await fileSystem.open(job.readPath, 'r');
        response.setHeader('Content-Type', 'video/mp2t');
        const buffer = Buffer.allocUnsafe(65536);
        let position = 0;
        if (request.method !== 'HEAD') while (!signal.aborted) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) {
            if (!job.writing) break;
            await delay(100, undefined, { signal });
            continue;
          }
          position += bytesRead;
          if (!response.write(Buffer.from(buffer.subarray(0, bytesRead)))) await once(response, 'drain', { signal });
        }
        response.end();
      } catch (error) { if (signal.aborted || response.headersSent) response.destroy(); else throw error; }
      finally {
        request.removeListener('aborted', stop); response.removeListener('close', stop);
        try { await handle?.close(); } finally { job.readers.delete(completion.promise); completion.resolve(); }
      }
    });
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#lifetime.abort(); clearTimeout(this.#wake);
    return this.#closing = withCleanup(async () => {
      await Promise.allSettled([this.#starting, ...[...this.#jobs.values()].map(job => job.done)]);
    }, [() => this.#bridge.close(), () => this.configuration.release()], 'Live TV recording shutdown failed.');
  }
}
