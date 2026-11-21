import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withCleanup } from '../core/operation-failure.js';
import { stageLiveTvStateFile } from '../database/live-tv-state-files.js';
import { BinaryResult } from '../http/binary-result.js';
import { postProcessRecording, recordTransportStream } from '../media-execution/recording.js';
import { LiveStreamReadBridge } from '../playback/live-stream-bridge.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { guideChannelId } from './live-tv-guide-channel.js';
import { findPostgresLinkedChildByPath } from './postgres-linked-child-resolution.js';
import { libraryError } from './records.js';

const terminal = new Set(['Cancelled', 'Completed']);
const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
const key = ordinalIgnoreCaseKey;
const publicationFile = 'publication.json';
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

  constructor({ publicationRetryMs = 60000, ...options }) { Object.assign(this, options, { publicationRetryMs }); }

  start() {
    return this.#starting ??= (async () => {
      const generation = this.#generation;
      const timers = await this.timers.readRecordingTimers();
      await this.#recoverPublications();
      this.#ready = true;
      if (generation === this.#generation) this.syncTimers(timers);
      else this.#schedule();
    })().catch(error => this.#report(error));
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
      job.done = Promise.resolve().then(() => this.runBackground(() => publication
        ? this.#finishPublication(job, publication) : this.#record(job, timer))).catch(error => {
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

  #publicationRoot() {
    const root = this.fileSystem.spoolRoot;
    return root && pathApi(root).join(root, 'dvr-publications');
  }

  async #publicationBytes(readPath) {
    try {
      const file = await this.fileSystem.stat(readPath, { bigint: true });
      if (!file.isFile()) throw new Error('The staged recording is not a regular file.');
      return file.size;
    } catch (error) { if (missing(error)) return 0n; throw error; }
  }

  async #recoverPublications() {
    const root = this.#publicationRoot();
    if (!root) return;
    let entries;
    try { entries = await this.fileSystem.readdir(root, { withFileTypes: true }); }
    catch (error) { if (missing(error)) return; throw error; }
    const api = pathApi(root);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^recording-[a-f0-9-]{36}$/u.test(entry.name)) continue;
      const spool = api.join(root, entry.name), readPath = api.join(spool, 'recording.ts');
      try {
        if (!await this.#publicationBytes(readPath)) {
          await this.fileSystem.rm(spool, { recursive: true, force: true });
          continue;
        }
        const state = JSON.parse(await this.fileSystem.readFile(api.join(spool, publicationFile), 'utf8'));
        if (typeof state?.timer?.Id !== 'string' || !state.timer.Id.trim() || typeof state.path !== 'string'
          || !pathApi(state.path).isAbsolute(state.path) || !state.path.endsWith('.ts') || typeof state.retryCapture !== 'boolean') {
          throw new Error('The staged recording has invalid publication metadata.');
        }
        const id = key(state.timer.Id);
        if (this.#publications.has(id)) throw new Error('More than one staged recording exists for this timer.');
        this.#publications.set(id, { ...state, spool, readPath, due: 0 });
      } catch (error) { this.#report(error); }
    }
  }

  async #savePublication({ spool, timer, path: filename, seriesPath, retryCapture }) {
    const staged = await stageLiveTvStateFile(spool, publicationFile,
      JSON.stringify({ timer, path: filename, seriesPath, retryCapture }), this.fileSystem);
    await withCleanup(async () => {
      await this.fileSystem.rename(staged.temporary, staged.filename);
      staged.published = true;
    }, [() => !staged.published && this.fileSystem.rm(staged.temporary, { force: true })], 'Recording publication metadata failed.');
  }

  #pathReserved(target, job, publication) {
    return [...this.#jobs.values()].some(other => other !== job && ordinalIgnoreCaseEquals(other.path, target))
      || [...this.#publications.values()].some(other => other !== publication && ordinalIgnoreCaseEquals(other.path, target));
  }

  async #openInput(channel, signal) {
    const [candidate] = await this.mediaSources.getMediaSources(channel, { signal });
    if (!candidate) throw libraryError(404, 'The recording channel has no media source.');
    const owner = candidate.RequiresOpening && await this.liveStreams.openOwned({ ItemId: channel.Id, OpenToken: candidate.OpenToken }, { signal });
    const source = owner?.MediaSource ?? candidate;
    // Owned byte streams still use their reader. An original HTTP input needs
    // its source URL so FFmpeg resolves nested manifests and segments there.
    const url = !owner?.openRead && source.Protocol === 'Http' && /^https?:\/\//iu.test(source.Path ?? '') ? source.Path : null;
    const openRead = owner?.openRead ?? (source.Protocol === 'File'
      ? options => this.fileSystem.openRead(source.Path, options)
      : async ({ signal: readSignal }) => {
        if (!url) throw libraryError(422, 'The tuner source protocol has no byte reader.');
        const controller = new AbortController();
        const combined = AbortSignal.any([readSignal, controller.signal]);
        const result = await fetch(url, { signal: combined, headers: source.RequiredHttpHeaders ?? {} });
        if (!result.ok || !result.body) { controller.abort(); throw libraryError(502, 'The tuner did not supply a recording body.'); }
        return { stream: result.body, close: () => controller.abort() };
      });
    return { source, openRead, url, close: () => owner?.release() };
  }

  async #openOutput(job, timer, { api, directory, basename, seriesPath }, signal) {
    await this.fileSystem.mkdir(directory, { recursive: true, signal });
    const remote = !this.fileSystem.resolve(directory).adapter.openFile;
    if (remote) {
      const spoolRoot = this.#publicationRoot();
      if (!spoolRoot) throw new Error('Recording requires writable spool storage for this destination.');
      await this.fileSystem.mkdir(spoolRoot, { recursive: true, signal });
      job.spool = await this.fileSystem.mkdtemp(pathApi(spoolRoot).join(spoolRoot, 'recording-'));
      job.readPath = pathApi(job.spool).join(job.spool, 'recording.ts');
    }
    for (let suffix = 1; ; suffix++) {
      signal.throwIfAborted();
      const target = api.join(directory, basename + '.ts');
      if (remote) {
        let exists = this.#pathReserved(target, job);
        if (!exists) try { await this.fileSystem.stat(target, { signal }); exists = true; } catch (error) { if (!missing(error)) throw error; }
        if (!exists && !this.#pathReserved(target, job)) {
          job.path = target;
          job.publication = { spool: job.spool, readPath: job.readPath, path: target, seriesPath,
            timer, retryCapture: false, due: 0, readers: job.readers };
          await this.#savePublication(job.publication);
          return this.fileSystem.open(job.readPath, 'wx');
        }
      } else try {
        const handle = await this.fileSystem.open(target, 'wx');
        job.readPath = job.path = target;
        return handle;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      basename += ` - ${suffix}`;
    }
  }

  async #checksum(filename, size, signal) {
    const handle = await this.fileSystem.openRead(filename, { signal });
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
    let suffix = 0, sourceHash;
    for (;;) {
      signal.throwIfAborted();
      const target = publication.path;
      let existing;
      try { existing = await this.fileSystem.stat(target, { signal }); }
      catch (error) { if (!missing(error)) throw error; }
      if (!existing) {
        let handle;
        this.monitor?.reportFileSystemChangeBeginning(target);
        await withCleanup(async () => {
          handle = await this.fileSystem.openRead(publication.readPath, { signal });
          await this.fileSystem.writeFile(target, handle.stream, { flag: 'wx', size, signal });
        }, [() => handle?.close(), () => this.monitor?.reportFileSystemChangeComplete(target, false)], 'Recording publication failed.');
        return;
      }
      if (existing.isFile()) {
        const targetHash = await this.#checksum(target, size, signal);
        if (targetHash !== null) {
          sourceHash ??= await this.#checksum(publication.readPath, size, signal);
          if (targetHash === sourceHash) return;
        }
      }
      do { job.path = api.join(original.dir, `${original.name} - ${++suffix}${original.ext}`); }
      while (this.#pathReserved(job.path, job, publication));
      // A restart must resume the last reserved name, including when the
      // remote write completed but its response or the timer update was lost.
      await this.#savePublication({ ...publication, path: job.path });
      publication.path = job.path;
    }
  }

  async #scanRecording() {
    if (this.#lifetime.signal.aborted) return;
    await this.folders?.reconcile();
    this.queueLibraryScan?.();
  }

  async #finishTimer(timer, filename, retryCapture, { confirm = false } = {}) {
    if (retryCapture) {
      const saved = await this.timers.updateRecordingTimer(timer, { Status: 'New', PrePaddingSeconds: 0,
        StartDate: new Date(Date.now() + 60000).toISOString(), RetryCount: timer.RetryCount + 1 });
      if (confirm && !saved) throw new Error('The recording timer retry could not be saved.');
    } else if (filename) {
      const saved = await this.timers.updateRecordingTimer(timer, { Status: 'Completed', RecordingPath: filename }, { finish: true });
      if (confirm && !saved) throw new Error('The recording timer completion could not be saved.');
      try { await postProcessRecording(await this.configuration.getConfiguration(), filename, { signal: this.#lifetime.signal }); }
      catch (error) { this.#report(error); }
    } else await this.timers.updateRecordingTimer(timer, null);
    if (filename) await this.#scanRecording();
  }

  async #finishPublication(job, publication) {
    const { timer, spool, readPath, seriesPath } = publication, signal = this.#lifetime.signal;
    const current = (await this.timers.readRecordingTimers()).find(candidate => key(candidate.Id) === key(timer.Id));
    if (current?.Status === 'Completed') {
      if (current.RecordingPath !== publication.path) throw new Error('The recording timer was completed with a different file.');
      await this.#scanRecording();
    } else if (publication.retryCapture && current?.RetryCount > timer.RetryCount) {
      await this.#scanRecording();
    } else {
      const size = await this.#publicationBytes(readPath);
      if (size) {
        if (publication.retryCapture) await this.#savePublication(publication);
        await this.#publishRecording(job, publication, size, signal);
        try {
          const configuration = await this.configuration.getConfiguration();
          await this.saveAssets?.({ timer, filename: publication.path, seriesPath, configuration, signal });
          await this.#enforceKeepUpTo(timer.SeriesTimerId, seriesPath);
        } catch (error) { this.#report(error); }
      }
      const retry = publication.retryCapture && current && current.Status !== 'Cancelled' && Date.now() < Date.parse(timer.EndDate);
      await this.#finishTimer(timer, size ? publication.path : null, retry, { confirm: Boolean(size) });
    }
    await Promise.allSettled([...job.readers]);
    await this.fileSystem.rm(spool, { recursive: true, force: true });
    this.#publications.delete(key(timer.Id));
    job.spool = null;
  }

  #enforceKeepUpTo(seriesId, seriesPath) {
    if (!seriesId?.trim() || !seriesPath) return;
    const work = this.#retention.then(() => this.#pruneRecordings(seriesId, seriesPath));
    this.#retention = work.catch(error => this.#report(error));
    return this.#retention;
  }

  async #pruneRecordings(seriesId, seriesPath) {
    if (this.#lifetime.signal.aborted) return;
    const retention = await this.timers.readRecordingRetention(seriesId);
    if (!retention) return;
    const { library, fileSystem } = this;
    const findByPath = (identity, isFolder) => findPostgresLinkedChildByPath({ library, store: library.store,
      itemCreation: library.itemCreation }, identity, isFolder);
    const exists = async identity => {
      try { return (await fileSystem.stat(identity)).isFile(); }
      catch (error) { if (!missing(error)) this.#report(error); return false; }
    };
    let keep = retention.keepPrevious;
    for (const timer of retention.timers) {
      if (this.#lifetime.signal.aborted) return;
      if (!await exists(timer.RecordingPath) || keep-- > 0) continue;
      try {
        const item = await findByPath(timer.RecordingPath, false);
        if (item) await library.deleteItem(item, { DeleteFileLocation: true });
        else await fileSystem.unlink(timer.RecordingPath);
        await this.timers.removeCompletedRecording(timer);
      } catch (error) { this.#report(error); }
    }
    const series = await findByPath(seriesPath, true);
    if (!series) return;
    const episodes = await library.getItemList({ parentId: series.Id, recursive: true, filters: ['IsNotFolder'],
      excludeLocationTypes: ['Virtual'], sortBy: ['DateCreated'], sortOrder: ['Descending'], enableTotalRecordCount: false });
    keep = retention.keepPrevious;
    for (const episode of episodes) {
      if (this.#lifetime.signal.aborted) return;
      const item = await library.itemCreation.getItemById(episode.Id);
      if (!item?.IsFileProtocol || [...this.#jobs.values()].some(active => active.writing && ordinalIgnoreCaseEquals(active.path, item.Path))
        || !await exists(item.Path) || keep-- > 0) continue;
      try { await library.deleteItem(item, { DeleteFileLocation: true }); }
      catch (error) { this.#report(error); }
    }
  }

  async #record(job, timer) {
    const stop = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, job.controller.signal, stop.signal]);
    const end = Date.parse(timer.EndDate) + timer.PostPaddingSeconds * 1000;
    const deadline = () => {
      const remaining = end - Date.now();
      if (remaining <= 0) stop.abort();
      else job.deadline = setTimeout(deadline, Math.min(2147483647, remaining)).unref();
    };
    let input, output, reader, bridge, failure, written = 0;
    const write = async bytes => { await output.writeFile(bytes); written += bytes.length; };
    try {
      deadline();
      if (!signal.aborted) {
        const channel = await this.library.itemCreation.getItemById(guideChannelId('Emby', timer.ChannelId));
        if (channel?.Type !== 'LiveTvChannel') throw libraryError(404, 'The recording channel was not found.');
        const configuration = await this.configuration.getConfiguration();
        const location = recordingLocation(timer, configuration, this.dataPath);
        input = await this.#openInput(channel, signal);
        output = await this.#openOutput(job, timer, location, signal);
        if (!job.spool) this.monitor?.reportFileSystemChangeBeginning(job.path);
        const onStarted = async () => {
          const saved = await this.timers.updateRecordingTimer(timer, { Status: 'InProgress' });
          if (!saved) job.controller.abort();
          signal.throwIfAborted();
          job.writing = true;
          if (job.spool) return;
          job.assets = Promise.resolve().then(async () => {
            await this.saveAssets?.({ timer, filename: job.path, seriesPath: location.seriesPath, configuration, signal: this.#lifetime.signal });
            await this.folders?.reconcile();
            await this.#enforceKeepUpTo(timer.SeriesTimerId, location.seriesPath);
          }).catch(error => this.#report(error));
        };
        const { source } = input;
        if (!source.RequiresLooping && /ts$/iu.test(source.Container ?? '') && ['File', 'Http'].includes(source.Protocol)) {
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
      clearTimeout(job.deadline);
      job.writing = false;
      job.finishing = true;
    }
    for (const release of [() => reader?.close(), () => bridge?.release(), () => input?.close()]) {
      try { await release(); } catch (error) { this.#report(error); }
    }
    await withCleanup(async () => {
      try {
        await withCleanup(async () => { if (written && job.publication) await output.sync?.(); },
          [() => output?.close()], 'Recording output failed to close.');
      }
      catch (error) { written = 0; failure = error; this.#report(error); }
      await job.assets;
      const retryCapture = Boolean(failure && !signal.aborted && Date.now() < Date.parse(timer.EndDate) && timer.RetryCount < 10);
      if (job.publication) {
        job.publication.retryCapture = retryCapture;
        this.#publications.set(key(timer.Id), job.publication);
        await this.#finishPublication(job, job.publication);
        return;
      }
      if (!written && output) await this.fileSystem.rm(job.path, { force: true });
      await this.#finishTimer(timer, written ? job.path : null, retryCapture);
    }, [() => job.path && !job.publication && this.monitor?.reportFileSystemChangeComplete(job.path, false),
      async () => {
        if (!job.spool || job.publication) return;
        await Promise.allSettled([...job.readers]);
        await this.fileSystem.rm(job.spool, { recursive: true, force: true });
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
        handle = await this.fileSystem.open(job.readPath, 'r');
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
