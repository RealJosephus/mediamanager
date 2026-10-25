import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeGuid } from '../users/native.js';
import { decodeNativeText } from './native-text.js';

export function isServerIdentity(value) {
  if (typeof value !== 'string') return false;
  try { nativeGuid(value); return true; } catch { return false; }
}

export function decodeServerIdentity(bytes) {
  const value = decodeNativeText(bytes);
  if (!isServerIdentity(value)) throw new Error('The instance server identity is invalid.');
  return value;
}

export async function readServerIdentity(dataPath, { fileSystem = fs } = {}) {
  const filename = path.join(dataPath, 'device.txt');
  return decodeServerIdentity(await fileSystem.readFile(filename));
}

export class ServerIdentity {
  #value;
  constructor({ dataPath, fileSystem = fs, onError = () => {} }) {
    if (!path.isAbsolute(dataPath)) throw new TypeError('Server identity requires an absolute instance data path.');
    this.filename = path.join(dataPath, 'device.txt'); this.fileSystem = fileSystem; this.onError = onError;
  }
  getValue() { return this.#value ??= this.#load(); }
  async #load() {
    const { fileSystem, filename } = this;
    try { return decodeServerIdentity(await fileSystem.readFile(filename)); }
    catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
    const value = randomUUID().replaceAll('-', '');
    try {
      await fileSystem.mkdir(path.dirname(filename), { recursive: true });
      await fileSystem.writeFile(filename, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(value)]));
    } catch (error) {
      this.onError(error);
    }
    return value;
  }
}
