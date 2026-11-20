import { startMediaProcess } from '../media-execution/process.js';
import { once } from 'node:events';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { StorageError } from '../storage/errors.js';
import { getEncodingThreadCount } from './media-encoder.js';
import { leaseDiscInput, resolveDiscInput } from '../media-execution/disc-input.js';
import { remuxArguments, remuxPlan } from '../media-execution/streaming.js';
import { stageSubtitleBurn } from '../media-execution/subtitle-burn.js';
import { TranscodeJobs, transcodingInfo } from './transcode-jobs.js';

export { remuxArguments, remuxPlan };

const failure = (code, message, cause) => Object.assign(new StorageError(code, message), cause === undefined ? {} : { cause });
const checkAbort = signal => { if (signal?.aborted) throw failure('cancelled', 'Remuxing was cancelled.', signal.reason); };
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Remux cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
export class RemuxService {
  #closed = false;
  #closing;
  #jobs = new Set();
  #cleanupErrors = [];
  constructor({ vfs, bridge, mediaEncoder, subtitleBurn, jobs = new TranscodeJobs(), timeoutMs = 21600000, maxConcurrentRemuxes = 4, onProcess = () => {} }) {
    if (!vfs) throw new TypeError('Remuxing requires VFS.');
    if (!mediaEncoder) throw new TypeError('Remuxing requires its startup media encoder.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxConcurrentRemuxes) || maxConcurrentRemuxes < 1) throw new TypeError('Positive remux limits are required.');
    Object.assign(this, { vfs, bridge: bridge ?? new ProbeReadBridge(vfs), ownsBridge: !bridge, mediaEncoder, subtitleBurn,
      jobs, timeoutMs, maxConcurrentRemuxes, onProcess });
  }
  get available() { return this.mediaEncoder.ready; }
  plan(source, options, configuration = this.mediaEncoder.getEncodingOptions()) {
    return remuxPlan(source, options, { configuration, capabilities: this.mediaEncoder.capabilities, version: this.mediaEncoder.version, subtitleBurn: this.subtitleBurn });
  }
  supports(source, options) {
    if (!this.available || this.#closed) return false;
    try { this.plan(source, options); return true; } catch { return false; }
  }
  async stream(source, virtualPath, options, request, response, { signal } = {}) {
    const configuration = this.mediaEncoder.getEncodingOptions();
    const plan = this.plan(source, options, configuration), threads = getEncodingThreadCount(configuration, options.CpuCoreLimit);
    if (!this.available) throw failure('unavailable', 'The ffmpeg remux process is unavailable.');
    if (this.#closed) throw failure('closed', 'Remuxing is closed.');
    checkAbort(signal);
    response.setHeader('Accept-Ranges', 'none');
    response.setHeader('Content-Type', plan.mime);
    if (request.method === 'HEAD') { response.end(); return; }
    if (this.#jobs.size >= this.maxConcurrentRemuxes) throw failure('busy', 'The remux concurrency limit has been reached.');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const job = { controller, options, active: false };
    this.#jobs.add(job);
    this.jobs.register(job, {
      describe: () => transcodingInfo(plan, options, undefined, this.mediaEncoder.getEncodingOptions().HardwareAccelerationType,
        (plan.inputVideo?.BitRate ?? 0) + (plan.audioOutput?.bitrate ?? 0)),
      stop: async () => {
        controller.abort();
        await Promise.allSettled([job.done]);
      },
    });
    const timer = setTimeout(() => controller.abort(failure('timeout', 'Remuxing timed out.')), this.timeoutMs); timer.unref();
    job.done = this.#stream(source, virtualPath, plan, threads, response, job);
    try { await job.done; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#jobs.delete(job); this.jobs.unregister(job); }
  }
  async #stream(source, virtualPath, plan, threads, response, job) {
    const { signal } = job.controller;
    const disc = plan.discInput ? await resolveDiscInput(this.vfs, source.VideoType, virtualPath, signal) : undefined;
    const before = disc ? undefined : await this.vfs.stat(virtualPath, { signal });
    const lifetime = { signal, expiresInMs: this.timeoutMs };
    const lease = disc ? await leaseDiscInput(this.bridge, disc, this.mediaEncoder, lifetime)
      : await this.bridge.lease(virtualPath, { ...lifetime, version: before.version });
    let child, done, failed, primary, killTimer, subtitles;
    const cleanupErrors = [];
    const kill = () => { try { child?.kill(); } catch (error) { cleanupErrors.push(error); } };
    const abort = () => { failed ??= signal.reason?.code === 'timeout' ? signal.reason : failure('cancelled', 'Remuxing was cancelled.', signal.reason); kill(); };
    try {
      checkAbort(signal);
      subtitles = await stageSubtitleBurn(this.subtitleBurn, source, plan.burnSubtitle, virtualPath, signal);
      const args = remuxArguments(lease.url, plan, threads, this.mediaEncoder.version, subtitles);
      const overrides = plan.videoOutput?.hardware?.environment;
      const environment = overrides ? { ...(this.mediaEncoder.environment ?? process.env), ...overrides } : this.mediaEncoder.environment;
      try { child = startMediaProcess(this.mediaEncoder.encoderPath, args, { environment, cwd: subtitles?.cwd }); }
      catch (error) { throw failure('unavailable', 'The remux process could not start.', error); }
      const started = Promise.withResolvers();
      done = new Promise(resolve => {
        child.once('spawn', started.resolve);
        child.once('error', error => {
          const startup = failure('unavailable', 'The remux process could not start.', error);
          failed = failed === undefined ? startup : operationFailure([failed, startup]); started.reject(failed);
        });
        child.once('close', resolve);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stderr.on('data', () => {});
      try {
        await started.promise;
        checkAbort(signal);
        job.active = true;
        this.jobs.activate(job);
        this.onProcess({ pid: child.pid, args: args.map(value => value === lease.url ? '[private source]' : value) });
        let received = false;
        for await (const bytes of child.stdout) {
          checkAbort(signal); received = true;
          if (!response.write(bytes)) await once(response, 'drain', { signal });
        }
        await done;
        if (failed) throw failed;
        if (child.exitCode !== 0 || !received) throw failure('invalid-response', 'The selected streams could not be processed.');
        if (disc) await disc.verify(signal);
        else {
          const after = await this.vfs.stat(virtualPath, { signal });
          if (before.version != null && before.version !== after.version) throw failure('version-changed', 'The source changed during remuxing.');
        }
        response.end();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          kill(); killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { cleanupErrors.push(error); } }, 1000); killTimer.unref();
        }
        await done;
      }
    } catch (error) { primary = failed?.code === 'timeout' && error.code !== 'timeout' ? operationFailure([failed, error]) : error; }
    finally {
      clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (done) await done;
      try { await subtitles?.release(); } catch (error) { cleanupErrors.push(error); }
      try { await lease.release(); } catch (error) { cleanupErrors.push(error); }
      this.#cleanupErrors.push(...cleanupErrors);
    }
    const errors = primary === undefined ? cleanupErrors : [primary, ...cleanupErrors];
    if (errors.length) throw operationFailure(errors);
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const completion = Promise.withResolvers(); this.#closing = completion.promise;
    for (const job of this.#jobs) job.controller.abort(failure('closed', 'Remuxing is closed.'));
    (async () => {
      await Promise.allSettled([...this.#jobs].map(job => job.done));
      const errors = [...this.#cleanupErrors];
      if (this.ownsBridge) try { await this.bridge.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw operationFailure(errors);
    })().then(completion.resolve, completion.reject);
    return this.#closing;
  }
}
