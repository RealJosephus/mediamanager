import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withCleanup } from '../core/operation-failure.js';
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
  #bridge = new LiveStreamReadBridge();
  #lifetime = new AbortController();
  #retention = Promise.resolve();
  #wake;
  #starting;
  #closing;
  #generation = 0;

  constructor(options) { Object.assign(this, options); }

  start() {
    return this.#starting ??= (async () => {
      const generation = this.#generation;
      const timers = await this.timers.readRecordingTimers();
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
    if (!this.#starting || this.#lifetime.signal.aborted) return;
    let next = Infinity;
    const now = Date.now();
    for (const [id, timer] of this.#timers) {
      if (this.#jobs.has(id)) continue;
      const due = Date.parse(timer.StartDate) - 1000 * timer.PrePaddingSeconds;
      if (!Number.isFinite(due)) continue;
      if (due > now) { next = Math.min(next, due); continue; }
      const job = { controller: new AbortController(), readers: new Set(), finishing: false, writing: false };
      this.#jobs.set(id, job);
      job.done = Promise.resolve().then(() => this.runBackground(() => this.#record(job, timer))).catch(error => {
        if (this.#timers.get(id)?.StartDate === timer.StartDate) this.#timers.delete(id);
        this.#report(error);
      }).finally(() => {
        this.#jobs.delete(id);
        this.#schedule();
      });
    }
    if (Number.isFinite(next)) this.#wake = setTimeout(() => this.#schedule(), Math.min(2147483647, next - now)).unref();
  }

  isActive(id) { return Boolean(id && this.#jobs.get(key(id))?.writing); }

  async #openInput(channel, signal) {
    const [candidate] = await this.mediaSources.getMediaSources(channel, { signal });
    if (!candidate) throw libraryError(404, 'The recording channel has no media source.');
    const owner = candidate.RequiresOpening && await this.liveStreams.openOwned({ ItemId: channel.Id, OpenToken: candidate.OpenToken }, { signal });
    const source = owner?.MediaSource ?? candidate;
    const openRead = owner?.openRead ?? (source.Protocol === 'File'
      ? options => this.fileSystem.openRead(source.Path, options)
      : async ({ signal: readSignal }) => {
        if (!/^https?:\/\//iu.test(source.Path ?? '')) throw libraryError(422, 'The tuner source protocol has no byte reader.');
        const controller = new AbortController();
        const combined = AbortSignal.any([readSignal, controller.signal]);
        const result = await fetch(source.Path, { signal: combined, headers: source.RequiredHttpHeaders ?? {} });
        if (!result.ok || !result.body) { controller.abort(); throw libraryError(502, 'The tuner did not supply a recording body.'); }
        return { stream: result.body, close: () => controller.abort() };
      });
    return { source, openRead, close: () => owner?.release() };
  }

  async #openOutput(job, { api, directory, basename }, signal) {
    await this.fileSystem.mkdir(directory, { recursive: true, signal });
    const remote = !this.fileSystem.resolve(directory).adapter.openFile;
    if (remote) {
      const spoolRoot = this.fileSystem.spoolRoot;
      if (!spoolRoot) throw new Error('Recording requires writable spool storage for this destination.');
      job.spool = await this.fileSystem.mkdtemp(pathApi(spoolRoot).join(spoolRoot, 'recording-'));
      job.readPath = pathApi(job.spool).join(job.spool, 'recording.ts');
    }
    for (let suffix = 1; ; suffix++) {
      signal.throwIfAborted();
      const target = api.join(directory, basename + '.ts');
      if (remote) {
        const reserved = [...this.#jobs.values()].some(active => ordinalIgnoreCaseEquals(active.path, target));
        let exists = reserved;
        if (!exists) try { await this.fileSystem.stat(target); exists = true; } catch (error) { if (!missing(error)) throw error; }
        if (!exists && ![...this.#jobs.values()].some(active => ordinalIgnoreCaseEquals(active.path, target))) {
          job.path = target;
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
        output = await this.#openOutput(job, location, signal);
        this.monitor?.reportFileSystemChangeBeginning(job.path);
        const onStarted = async () => {
          const saved = await this.timers.updateRecordingTimer(timer, { Status: 'InProgress' });
          if (!saved) job.controller.abort();
          signal.throwIfAborted();
          job.writing = true;
          job.assets = Promise.resolve().then(async () => {
            await this.saveAssets?.({ timer, filename: job.path, seriesPath: location.seriesPath, configuration, signal: this.#lifetime.signal });
            if (!job.spool) await this.folders?.reconcile();
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
      try { await output?.close(); }
      catch (error) { written = 0; failure = error; this.#report(error); }
      await job.assets;
      if (written && job.spool) {
        try {
          const stream = this.fileSystem.createReadStream(job.readPath);
          await withCleanup(() => this.fileSystem.writeFile(job.path, stream, { flag: 'wx', size: BigInt(written) }),
            [() => stream.destroy()], 'Recording publication failed.');
        } catch (error) { written = 0; failure = error; this.#report(error); }
      }
      if (!written && output && !job.spool) await this.fileSystem.rm(job.path, { force: true });
      if (failure && !signal.aborted && Date.now() < Date.parse(timer.EndDate) && timer.RetryCount < 10) {
        await this.timers.updateRecordingTimer(timer, { Status: 'New', PrePaddingSeconds: 0, StartDate: new Date(Date.now() + 60000).toISOString(),
          RetryCount: timer.RetryCount + 1 });
      } else if (written) {
        await this.timers.updateRecordingTimer(timer, { Status: 'Completed', RecordingPath: job.path }, { finish: true });
        try {
          await postProcessRecording(await this.configuration.getConfiguration(), job.path, { signal: this.#lifetime.signal });
        } catch (error) { this.#report(error); }
      } else await this.timers.updateRecordingTimer(timer, null);
      if (written && !this.#lifetime.signal.aborted) {
        await this.folders?.reconcile();
        this.queueLibraryScan?.();
      }
    }, [() => job.path && this.monitor?.reportFileSystemChangeComplete(job.path, false),
      async () => {
        if (!job.spool) return;
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
