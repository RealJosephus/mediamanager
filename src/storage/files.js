import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { StorageError } from './errors.js';

const nativeCodes = { 'not-found': 'ENOENT', 'not-directory': 'ENOTDIR', 'is-directory': 'EISDIR',
  'already-exists': 'EEXIST', 'permission-denied': 'EACCES', 'not-empty': 'ENOTEMPTY', 'not-supported': 'ENOTSUP' };
const nativeError = error => {
  if (!nativeCodes[error.code]) return error;
  return Object.assign(new Error(error.message, { cause: error }), { code: nativeCodes[error.code], storageCode: error.code });
};
const dateNs = value => {
  if (!value) return 0n;
  const milliseconds = Date.parse(value), fraction = /\.(\d+)/u.exec(value)?.[1] ?? '';
  return BigInt(milliseconds - ((milliseconds % 1000) + 1000) % 1000) * 1000000n
    + BigInt(fraction.padEnd(9, '0').slice(0, 9));
};

/** Identity paths belong to the database. Only this facade resolves them to a
 * storage instance; it never falls back to the host operating system. */
export class StorageFileSystem {
  constructor({ vfs, identityMap }) { Object.assign(this, { vfs, identityMap }); }
  accessPath(identity) {
    return this.identityMap.resolve({ identityPath: identity,
      style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identity) ? 'windows' : 'posix' });
  }
  resolve(identity) { return this.vfs.resolve(this.accessPath(identity)); }
  async #run(work) { try { return await work(); } catch (error) { throw nativeError(error); } }
  async stat(identity, options = {}) { return this.#run(async () => {
    const resolved = this.resolve(identity);
    if (resolved.adapter.fileStat) return resolved.adapter.fileStat(resolved.path, options);
    const value = await this.vfs.stat(this.accessPath(identity), options), big = options.bigint === true;
    const mtimeNs = dateNs(value.modified), birthtimeNs = dateNs(value.created ?? value.modified);
    return { size: big ? value.size ?? 0n : Number(value.size ?? 0n), mtimeNs, birthtimeNs, ctimeNs: mtimeNs,
      mtimeMs: big ? mtimeNs / 1000000n : Number(mtimeNs) / 1000000,
      birthtimeMs: big ? birthtimeNs / 1000000n : Number(birthtimeNs) / 1000000,
      mtime: new Date(Number(mtimeNs / 1000000n)), birthtime: new Date(Number(birthtimeNs / 1000000n)),
      isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'file', isSymbolicLink: () => false };
  }); }
  lstat(identity, options) { return this.stat(identity, options); }
  async realpath(identity) { await this.stat(identity); return path.resolve(identity); }
  async readdir(identity, options = {}) { return this.#run(async () => {
    const { entries } = await this.vfs.list(this.accessPath(identity), options);
    return options.withFileTypes ? entries.map(value => ({ name: value.name,
      isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'file', isSymbolicLink: () => false })) : entries.map(value => value.name);
  }); }
  async readFile(identity, options = {}) { return this.#run(async () => {
    const encoding = typeof options === 'string' ? options : options.encoding;
    const handle = await this.vfs.openRead(this.accessPath(identity), typeof options === 'string' ? {} : options);
    try {
      const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); return encoding ? bytes.toString(encoding) : bytes;
    } finally { await handle.close(); }
  }); }
  createReadStream(identity, options = {}) {
    const owner = this;
    return Readable.from((async function* () {
      const handle = await owner.vfs.openRead(owner.accessPath(identity), options);
      try { yield* handle.stream; } finally { await handle.close(); }
    })());
  }
  async writeFile(identity, data, options = {}) { return this.#run(async () => {
    if (typeof options === 'string') options = { encoding: options };
    const bytes = typeof data === 'string' ? Buffer.from(data, options.encoding ?? 'utf8') : data;
    await this.vfs.write(this.accessPath(identity), bytes, { signal: options.signal,
      overwrite: !options.flag?.includes('x'), size: bytes instanceof Uint8Array ? BigInt(bytes.length) : options.size });
  }); }
  async mkdir(identity, options = {}) { return this.#run(async () => {
    const access = this.accessPath(identity);
    if (options.recursive) {
      try { const info = await this.vfs.stat(access, options); if (info.kind === 'directory') return;
        throw new StorageError('already-exists', 'The requested directory is a file.');
      } catch (error) { if (error.code !== 'not-found') throw error; }
      await this.mkdir(path.dirname(identity), options);
    }
    await this.vfs.mkdir(access, options);
  }); }
  async mkdtemp(prefix) { const name = prefix + randomUUID(); await this.mkdir(name); return name; }
  unlink(identity) { return this.#run(() => this.vfs.delete(this.accessPath(identity))); }
  rmdir(identity) { return this.unlink(identity); }
  async rm(identity, options = {}) { return this.#run(async () => {
    try { await this.vfs.delete(this.accessPath(identity), options); }
    catch (error) { if (!(options.force && error.code === 'not-found')) throw error; }
  }); }
  rename(identity, destination) { return this.#run(() => this.vfs.rename(this.accessPath(identity), this.accessPath(destination), { overwrite: true })); }
  async copyFile(identity, destination) { return this.#run(async () => {
    const handle = await this.vfs.openRead(this.accessPath(identity));
    try { await this.vfs.write(this.accessPath(destination), handle.stream, { overwrite: true, size: handle.size }); }
    finally { await handle.close(); }
  }); }
  async open(identity, flags = 'r') { return this.#run(async () => {
    const resolved = this.vfs.resolveFileHandle(this.accessPath(identity), flags);
    if (resolved.adapter.openFile) return resolved.adapter.openFile(resolved.path, flags);
    // Sequential metadata files can use the ordinary storage write contract.
    // Random access and synchronous spool handles are explicitly optional.
    if (!['w', 'wx'].includes(flags) || !this.spoolRoot) throw new StorageError('not-supported', 'This storage does not expose random file handles.');
    const temporary = path.join(this.spoolRoot, `file-${randomUUID()}.tmp`);
    const spool = this.vfs.resolveFileHandle(this.accessPath(temporary), 'wx');
    if (!spool.adapter.openFile) throw new StorageError('not-supported', 'The configured spool storage must expose file handles.');
    const file = await spool.adapter.openFile(spool.path, 'wx'), owner = this; let closed = false;
    return { write: (...args) => file.write(...args), writeFile: (...args) => file.writeFile(...args),
      writeSync: (...args) => file.writeSync(...args), async close() {
        if (closed) return; closed = true;
        let handle;
        try { await file.close(); handle = await owner.vfs.openRead(owner.accessPath(temporary));
          await owner.vfs.write(owner.accessPath(identity), handle.stream, { overwrite: flags !== 'wx', size: handle.size }); }
        finally { try { await handle?.close(); } finally { await owner.rm(temporary, {force:true}); } }
      } };
  }); }
}
