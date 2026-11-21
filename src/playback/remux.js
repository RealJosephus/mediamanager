import { startMediaProcess } from '../media-execution/process.js';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { operationFailure, withCleanup } from '../core/operation-failure.js';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { StorageError } from '../storage/errors.js';
import { identityPathStyle } from '../storage/uri.js';
import { subtitleExtensionHint } from './subtitle-source.js';
import { getEncodingThreadCount } from './media-encoder.js';
import { leaseDiscInput, resolveDiscInput } from '../media-execution/disc-input.js';
import { remuxArguments, remuxPlan } from '../media-execution/streaming.js';
import { stageSubtitleBurn } from '../media-execution/subtitle-burn.js';
import { TranscodeJobs, transcodingInfo } from './transcode-jobs.js';
import { TranscodeCache } from './transcode-cache.js';
import { LiveStreamReadBridge } from './live-stream-bridge.js';

export { remuxArguments, remuxPlan };

const failure = (code, message, cause) => Object.assign(new StorageError(code, message), cause === undefined ? {} : { cause });
const cleanupFailure = errors => operationFailure(errors, 'Remux cleanup failed.');
const timeoutFailure = () => failure('timeout', 'Remuxing timed out.');
const maxRetainedBytes = 256 * 1024 * 1024;
const idleTimeoutMs = 10_000;

function vobSubPair(stream) {
  const identity = stream?.Path;
  if (stream?.IsTextSubtitleStream || !/\.(idx|sub)$/iu.test(identity ?? '') || !/(?:dvd_?sub|vobsub)/iu.test(stream.Codec ?? '')) return;
  return { index: identity.replace(/\.sub$/iu, '.idx'), data: identity.replace(/\.idx$/iu, '.sub') };
}

export class RemuxService {
  #closing;
  #jobs = new Map();
  #lifetime = new AbortController();
  #preparing = new Set();
  #retiring = new Set();
  #cache;
  #cacheReady;
  #liveBridge;
  #cleanupErrors = [];
  constructor({ vfs, bridge, identityMap, mediaEncoder, subtitleBurn, getCacheDirectory = tmpdir,
    jobs = new TranscodeJobs(), timeoutMs = 21600000, maxConcurrentRemuxes = 4, onError = () => {}, onProcess = () => {} }) {
    if (!vfs) throw new TypeError('Remuxing requires VFS.');
    if (!mediaEncoder) throw new TypeError('Remuxing requires its startup media encoder.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxConcurrentRemuxes) || maxConcurrentRemuxes < 1) throw new TypeError('Positive remux limits are required.');
    Object.assign(this, { vfs, bridge: bridge ?? new ProbeReadBridge(vfs), ownsBridge: !bridge, identityMap, mediaEncoder, subtitleBurn,
      jobs, timeoutMs, maxConcurrentRemuxes, getCacheDirectory, onError, onProcess });
    this.#cache = new TranscodeCache('progressive', onError);
  }
  get available() { return this.mediaEncoder.ready; }
  get canOpenSidecar() { return Boolean(this.identityMap); }
  plan(source, options, configuration = this.mediaEncoder.getEncodingOptions()) {
    return remuxPlan(source, options, { configuration, capabilities: this.mediaEncoder.capabilities, version: this.mediaEncoder.version,
      subtitleBurn: this.subtitleBurn, canOpenSidecar: this.canOpenSidecar });
  }
  #sidecarPath(identityPath) {
    return this.identityMap.resolve({ identityPath, style: identityPathStyle(identityPath) });
  }
  leaseSidecar(identityPath, lifetime) {
    return this.bridge.lease(this.#sidecarPath(identityPath), lifetime);
  }
  async #leaseEmbeddedSubtitle(stream, lifetime, sidecars) {
    const identity = stream.Path;
    const pair = vobSubPair(stream);
    if (pair) {
      const { index, data } = pair;
      try { return await this.leaseSidecar(index, { ...lifetime, version: sidecars.get(index)?.version, relatedPaths: [this.#sidecarPath(data)] }); }
      catch (error) { if (index === identity || error.code !== 'not-found') throw error; }
    }
    return this.leaseSidecar(identity, { ...lifetime, version: sidecars.get(identity)?.version, extensionHint: subtitleExtensionHint(stream) });
  }
  supports(source, options) {
    if (!this.available || this.#lifetime.signal.aborted) return false;
    try { this.plan(source, options); return true; } catch { return false; }
  }

  async #cacheDirectory(signal) {
    const directory = path.resolve(await this.getCacheDirectory());
    signal.throwIfAborted();
    if (this.#cacheReady?.directory !== directory) {
      const ready = { directory, promise: this.#cache.prepare(directory) };
      this.#cacheReady = ready;
      ready.promise.catch(() => { if (this.#cacheReady === ready) this.#cacheReady = undefined; });
    }
    await this.#cacheReady.promise;
    return directory;
  }

  async #inputSnapshot(source, virtualPath, plan, signal, openRead) {
    const disc = plan.discInput ? await resolveDiscInput(this.vfs, source.VideoType, virtualPath, signal) : undefined;
    const before = disc || openRead ? undefined : await this.vfs.stat(virtualPath, { signal });
    const identities = new Set([plan.externalAudio?.path, plan.externalSubtitle?.Path, plan.burnSubtitle?.Path].filter(Boolean));
    for (const stream of [plan.externalSubtitle, plan.burnSubtitle]) {
      const pair = vobSubPair(stream);
      if (pair) { identities.add(pair.index); identities.add(pair.data); }
    }
    const sidecars = new Map(await Promise.all([...identities].map(async identity => {
      const virtualPath = this.#sidecarPath(identity);
      let info;
      try { info = await this.vfs.stat(virtualPath, { signal }); }
      catch (error) {
        const pair = vobSubPair(plan.externalSubtitle);
        if (error.code !== 'not-found' || pair?.index !== identity || pair.data !== plan.externalSubtitle.Path) throw error;
      }
      return [identity, { path: virtualPath, version: info?.version ?? null, reliable: this.vfs.capabilities(virtualPath).reliableVersion }];
    })));
    const cacheable = !plan.live && !source.LiveStreamId && (disc ? disc.version != null : before?.version != null && this.vfs.capabilities(virtualPath).reliableVersion)
      && [...sidecars.values()].every(value => value.version != null && value.reliable);
    return { disc, before, sidecars, cacheable, openRead };
  }

  async #prepare(source, virtualPath, plan, signal, openRead) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutFailure()), this.timeoutMs); timer.unref();
    const preparing = AbortSignal.any([signal, controller.signal]);
    const pending = (async () => {
      const directory = await this.#cacheDirectory(preparing);
      preparing.throwIfAborted();
      const input = await this.#inputSnapshot(source, virtualPath, plan, preparing, openRead);
      preparing.throwIfAborted();
      return { directory, input };
    })();
    this.#preparing.add(pending);
    try { return await pending; }
    catch (error) { if (preparing.aborted) throw preparing.reason; throw error; }
    finally { clearTimeout(timer); this.#preparing.delete(pending); }
  }

  async stream(source, virtualPath, options, request, response, { signal, userId, openRead } = {}) {
    const configuration = this.mediaEncoder.getEncodingOptions();
    const plan = this.plan(source, options, configuration), threads = getEncodingThreadCount(configuration, options.CpuCoreLimit);
    if (!this.available) throw failure('unavailable', 'The ffmpeg remux process is unavailable.');
    const lifetime = this.#lifetime.signal;
    signal = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    signal.throwIfAborted();
    response.setHeader('Accept-Ranges', 'none');
    response.setHeader('Content-Type', plan.mime);
    if (request.method === 'HEAD') { response.end(); return; }
    const deadline = performance.now() + this.timeoutMs;
    const { directory, input } = await this.#prepare(source, virtualPath, plan, signal, openRead);
    signal.throwIfAborted();
    const { disc, before, sidecars } = input;
    // As in Native, a seek or a different requested codec in the same session
    // can read the existing output. Its VFS inputs still have to match.
    const key = JSON.stringify([directory, source.LiveStreamId, source.Path, virtualPath, disc?.version ?? before?.version,
      request.headers['user-agent'], options.DeviceId, options.PlaySessionId, plan.container, userId,
      options.PermitAudioEncoding, options.PermitVideoEncoding, [...sidecars].map(([identity, input]) => [identity, input.path, input.version])]);
    let job = this.#jobs.get(key);
    while (job?.error || job?.controller.signal.aborted) {
      await this.#remove(job);
      signal.throwIfAborted();
      job = this.#jobs.get(key);
    }
    if (!job) {
      const remaining = plan.live ? this.timeoutMs : Math.ceil(deadline - performance.now());
      if (remaining < 1) throw timeoutFailure();
      job = this.#start(key, directory, source, virtualPath, plan, threads, options, input, remaining);
    }
    clearTimeout(job.idle); job.idle = undefined;
    const reader = this.#deliver(job, response, signal);
    job.readers.add(reader);
    try { await reader; }
    finally {
      job.readers.delete(reader);
      if (job.readers.size === 0 && !job.removing) {
        if (signal.aborted && !job.size) await this.#remove(job);
        else await this.#idle(job);
      }
    }
  }

  #start(key, directory, source, virtualPath, plan, threads, options, input, timeoutMs) {
    const active = [...this.#jobs.values(), ...this.#retiring].filter(job => !job.finished || job.readers.size > 0).length;
    if (active >= this.maxConcurrentRemuxes) throw failure('busy', 'The remux concurrency limit has been reached.');
    const controller = new AbortController();
    const job = { key, directory, controller, options, cacheable: input.cacheable, size: 0, readers: new Set() };
    this.#jobs.set(key, job);
    this.jobs.register(job, {
      describe: () => transcodingInfo(plan, options, undefined, this.mediaEncoder.getEncodingOptions().HardwareAccelerationType,
        (plan.inputVideo?.BitRate ?? 0) + (plan.audioOutput?.bitrate ?? 0)),
      stop: () => this.#remove(job),
      ping: () => { if (job.idle && !job.finished) this.#armIdle(job); },
    });
    job.watchdog = setTimeout(() => controller.abort(timeoutFailure()), timeoutMs).unref();
    job.done = this.#produce(source, virtualPath, plan, threads, job, input, timeoutMs)
      .catch(error => { job.error = controller.signal.aborted ? controller.signal.reason : error; })
      .finally(() => {
        clearTimeout(job.watchdog);
        job.finished = true;
        if (job.readers.size === 0 && !job.removing) this.#idle(job).catch(this.onError);
      });
    return job;
  }

  #armIdle(job) {
    clearTimeout(job.idle);
    job.idle = setTimeout(() => { this.#remove(job).catch(this.onError); }, idleTimeoutMs);
    job.idle.unref();
  }

  async #idle(job) {
    if (job.error || !job.cacheable || job.controller.signal.aborted) return this.#remove(job);
    this.#armIdle(job);
    let bytes = 0, entries = 0;
    for (const candidate of [...this.#jobs.values()].reverse()) {
      if (!candidate.finished || candidate.readers.size) continue;
      if (entries >= this.maxConcurrentRemuxes || bytes + candidate.size > maxRetainedBytes) this.#remove(candidate).catch(this.onError);
      else { entries++; bytes += candidate.size; }
    }
  }

  async #deliver(job, response, signal) {
    signal = AbortSignal.any([signal, job.controller.signal]);
    try {
      let position = 0;
      while (true) {
        signal.throwIfAborted();
        const available = job.size - position;
        if (available > 0) {
          const buffer = Buffer.allocUnsafe(Math.min(available, 65536));
          const { bytesRead } = await job.file.read(buffer, 0, buffer.length, position);
          signal.throwIfAborted();
          if (!bytesRead) throw failure('invalid-response', 'The progressive output ended unexpectedly.');
          position += bytesRead;
          if (!response.write(buffer.subarray(0, bytesRead))) await once(response, 'drain', { signal });
        } else if (job.finished) {
          if (job.error) throw job.error;
          response.end(); return;
        } else await delay(50, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
  }

  async #produce(source, virtualPath, plan, threads, job, { disc, before, sidecars, openRead }, timeoutMs) {
    const { signal } = job.controller;
    job.workspace = await this.#cache.create(job.directory);
    job.file = await open(path.join(job.workspace, 'output'), 'wx+', 0o600);
    signal.throwIfAborted();
    const lifetime = { signal, expiresInMs: plan.live ? null : timeoutMs };
    if (source.LiveStreamId && source.BufferMs > 0) await delay(source.BufferMs, undefined, { signal });
    let lease;
    if (openRead) {
      this.#liveBridge ??= new LiveStreamReadBridge();
      lease = await this.#liveBridge.lease(openRead, { signal });
    } else lease = disc ? await leaseDiscInput(this.bridge, disc, this.mediaEncoder, lifetime)
      : await this.bridge.lease(virtualPath, { ...lifetime, version: before.version });
    let child, done, failed, primary, killTimer, subtitles, externalAudio, externalSubtitle;
    const cleanupErrors = [];
    const kill = () => {
      if (killTimer || !child || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(); } catch (error) { cleanupErrors.push(error); }
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill('SIGKILL'); } catch (error) { cleanupErrors.push(error); }
      }, 1000); killTimer.unref();
    };
    const abort = () => { failed ??= signal.reason; kill(); };
    const verifySidecars = () => Promise.all([...sidecars.values()].filter(value => value.version != null).map(async ({ path, version }) => {
      if ((await this.vfs.stat(path, { signal })).version !== version) throw failure('version-changed', 'A sidecar changed during remuxing.');
    }));
    try {
      signal.throwIfAborted();
      subtitles = await stageSubtitleBurn(this.subtitleBurn, source, plan.burnSubtitle, virtualPath, signal);
      if (plan.externalSubtitle) externalSubtitle = await this.#leaseEmbeddedSubtitle(plan.externalSubtitle, lifetime, sidecars);
      if (plan.externalAudio) externalAudio = await this.leaseSidecar(plan.externalAudio.path, { ...lifetime, version: sidecars.get(plan.externalAudio.path)?.version });
      await verifySidecars();
      signal.throwIfAborted();
      const args = remuxArguments(lease.url, plan, threads, this.mediaEncoder.version, subtitles, externalAudio?.url, externalSubtitle?.url);
      const overrides = plan.videoOutput?.hardware?.environment;
      const environment = overrides ? { ...(this.mediaEncoder.environment ?? process.env), ...overrides } : this.mediaEncoder.environment;
      try { child = startMediaProcess(this.mediaEncoder.encoderPath, args, { environment, cwd: subtitles?.cwd }); }
      catch (error) { throw failure('unavailable', 'The remux process could not start.', error); }
      const started = Promise.withResolvers();
      done = new Promise(resolve => {
        child.once('spawn', started.resolve);
        child.once('error', error => {
          const startup = failure('unavailable', 'The remux process could not start.', error);
          failed = failed === undefined ? startup : cleanupFailure([failed, startup]); started.reject(failed);
        });
        child.once('close', resolve);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stderr.on('data', () => {});
      try {
        await started.promise;
        signal.throwIfAborted();
        job.active = true;
        this.jobs.activate(job);
        const inputUrls = new Set([lease.url, externalSubtitle?.url, externalAudio?.url]);
        this.onProcess({ pid: child.pid, args: args.map(value => inputUrls.has(value) ? '[private source]' : value) });
        for await (const bytes of child.stdout) {
          signal.throwIfAborted();
          for (let offset = 0; offset < bytes.length;) {
            const { bytesWritten } = await job.file.write(bytes, offset, bytes.length - offset, job.size);
            if (!bytesWritten) throw failure('invalid-response', 'The progressive output could not be written.');
            offset += bytesWritten;
            job.size += bytesWritten;
          }
          if (plan.live && !signal.aborted) job.watchdog.refresh();
        }
        await done;
        if (failed) throw failed;
        if (child.exitCode !== 0 || !job.size) throw failure('invalid-response', 'The selected streams could not be processed.');
        if (disc) await disc.verify(signal);
        else if (before) {
          const after = await this.vfs.stat(virtualPath, { signal });
          if (before.version != null && before.version !== after.version) throw failure('version-changed', 'The source changed during remuxing.');
        }
        await verifySidecars();
      } finally {
        kill();
        await done;
      }
    } catch (error) { primary = error; }
    finally {
      clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (done) await done;
      try { await subtitles?.release(); } catch (error) { cleanupErrors.push(error); }
      try { await externalSubtitle?.release(); } catch (error) { cleanupErrors.push(error); }
      try { await externalAudio?.release(); } catch (error) { cleanupErrors.push(error); }
      try { await lease.release(); } catch (error) { cleanupErrors.push(error); }
      this.#cleanupErrors.push(...cleanupErrors);
    }
    const errors = primary === undefined ? cleanupErrors : [primary, ...cleanupErrors];
    if (errors.length) throw cleanupFailure(errors);
  }

  #remove(job) {
    if (job.removing) return job.removing;
    job.controller.abort(failure('cancelled', 'Remuxing was stopped.'));
    clearTimeout(job.idle);
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    this.jobs.unregister(job);
    this.#retiring.add(job);
    job.removing = withCleanup(async () => { await job.done; await Promise.allSettled([...job.readers]); },
      [() => job.file?.close(), () => job.workspace && this.#cache.remove(job.directory, job.workspace)], 'Remux output cleanup failed.');
    job.removing.then(() => this.#retiring.delete(job), error => {
      this.#retiring.delete(job); this.#cleanupErrors.push(error);
    });
    return job.removing;
  }

  close() {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers(); this.#closing = completion.promise;
    this.#lifetime.abort(failure('closed', 'Remuxing is closed.'));
    (async () => {
      const jobs = [...this.#jobs.values(), ...this.#retiring];
      await Promise.allSettled(jobs.map(job => this.#remove(job)));
      await Promise.allSettled([...this.#preparing]);
      this.#cache.close();
      const errors = [...this.#cleanupErrors];
      try { await this.#liveBridge?.close(); } catch (error) { errors.push(error); }
      if (this.ownsBridge) try { await this.bridge.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw cleanupFailure(errors);
    })().then(completion.resolve, completion.reject);
    return this.#closing;
  }
}
