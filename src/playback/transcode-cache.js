import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { operationFailure } from '../core/operation-failure.js';

const owners = new Set();

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export class TranscodeCache {
  #owner = { pid: process.pid, id: randomUUID() };

  constructor(kind, onError) {
    this.#owner.kind = `mediamanager-${kind}`;
    this.prefix = `${this.#owner.kind}-`;
    this.onError = onError;
    owners.add(this.#owner.id);
  }

  async prepare(root) {
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(this.prefix) || !/^[A-Za-z0-9_-]+$/u.test(entry.name.slice(this.prefix.length))) continue;
      const directory = path.join(root, entry.name);
      try {
        const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
        if (owner?.kind !== this.#owner.kind || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.id !== 'string') continue;
        if (owner.pid === process.pid ? owners.has(owner.id) : processExists(owner.pid)) continue;
        await this.remove(root, directory);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) this.onError(error);
      }
    }
  }

  async create(root) {
    const directory = await mkdtemp(path.join(root, this.prefix));
    try { await writeFile(path.join(directory, 'owner.json'), JSON.stringify(this.#owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      try { await this.remove(root, directory); }
      catch (cleanup) { throw operationFailure([error, cleanup], 'Transcode directory creation failed.'); }
      throw error;
    }
    return directory;
  }

  remove(root, directory) {
    if (path.dirname(directory) !== root || !path.basename(directory).startsWith(this.prefix)) throw new Error('Invalid transcode cache directory.');
    return rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }

  close() { owners.delete(this.#owner.id); }
}
