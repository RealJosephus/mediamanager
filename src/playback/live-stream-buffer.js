import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withCleanup } from '../core/operation-failure.js';
import { libraryError } from '../library/records.js';

/** One growing transport file per opened tuner input. Readers have independent
 * positions so a paused client cannot delay recording or another viewer. */
export class LiveStreamBuffer {
  #controller = new AbortController();
  #first = Promise.withResolvers();
  #filename;
  #file;
  #size = 0;
  #openedAt;
  #finished = false;
  #failure;
  #work;
  #closing;

  constructor(directory, openRead, onError) {
    this.ready = this.#first.promise;
    void this.ready.catch(() => {});
    this.#work = this.#write(directory, openRead).catch(error => {
      this.#first.reject(error);
      if (!this.#controller.signal.aborted) {
        this.#failure = error;
        onError(error);
      }
    }).finally(() => { this.#finished = true; });
  }

  async #write(directory, openRead) {
    const signal = this.#controller.signal;
    await mkdir(directory, { recursive: true });
    signal.throwIfAborted();
    const filename = path.join(directory, `mediamanager-live-${randomUUID()}.ts`);
    this.#file = await open(filename, 'wx+', 0o600);
    this.#filename = filename;
    const input = await openRead({ signal });
    await withCleanup(async () => {
      for await (const bytes of input.stream) {
        signal.throwIfAborted();
        if (!bytes.length) continue;
        await this.#file.writeFile(bytes);
        this.#size += bytes.length;
        if (this.#openedAt === undefined) {
          this.#openedAt = performance.now();
          this.#first.resolve();
        }
      }
      if (this.#openedAt === undefined) throw libraryError(502, 'The tuner did not supply any stream bytes.');
    }, [() => input.close()], 'Live tuner input and cleanup failed.');
  }

  async openRead({ signal } = {}) {
    const reader = new AbortController();
    const combined = AbortSignal.any([reader.signal, this.#controller.signal, ...(signal ? [signal] : [])]);
    await this.ready;
    combined.throwIfAborted();
    const start = performance.now() - this.#openedAt > 10000 ? Math.max(0, this.#size - 20000) : 0;
    return { stream: this.#read(start, combined), close: () => reader.abort() };
  }

  async *#read(position, signal) {
    while (true) {
      signal.throwIfAborted();
      const available = this.#size - position;
      if (available > 0) {
        const bytes = Buffer.allocUnsafe(Math.min(available, 65536));
        const { bytesRead } = await this.#file.read(bytes, 0, bytes.length, position);
        if (!bytesRead) throw libraryError(502, 'The retained tuner data ended unexpectedly.');
        position += bytesRead;
        yield bytes.subarray(0, bytesRead);
      } else if (this.#finished) {
        if (this.#failure) throw this.#failure;
        return;
      } else await delay(50, undefined, { signal });
    }
  }

  close() {
    this.#controller.abort();
    return this.#closing ??= withCleanup(() => this.#work, [() => this.#file?.close(),
      () => this.#filename && rm(this.#filename, { force: true })], 'Retained tuner data failed to close.');
  }
}
