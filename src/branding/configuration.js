import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseConfigurationXml } from '../core/configuration-xml.js';
import { escapeXml } from '../core/xml.js';

export const defaultBrandingOptions = () => ({ LoginDisclaimer: null, CustomCss: null, SplashscreenEnabled: false, SplashscreenLocation: null });
export function readBrandingOptions(bytes) {
  return parseConfigurationXml(bytes, 'branding');
}

function writeBrandingOptions(options) {
  return Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<BrandingOptions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
    + Object.entries(options).filter(([, value]) => value != null).map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`).join('') + '</BrandingOptions>\n');
}

async function physicalPath(filename) {
  let ancestor = path.resolve(filename);
  while (true) {
    try {
      const actual = await fs.realpath(ancestor);
      if (path.relative(path.toNamespacedPath(ancestor), path.toNamespacedPath(actual)) !== '') {
        throw Object.assign(new Error('Branding configuration traverses a link or junction.'), { code: 'unsafe-configuration-path', status: 409 });
      }
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
}

export class BrandingConfigurationStore extends EventEmitter {
  #closed = false;
  #tail = Promise.resolve();
  constructor({ configurationDirectoryPath, onError = () => {} } = {}) {
    super();
    if (configurationDirectoryPath != null && !path.isAbsolute(configurationDirectoryPath)) throw new TypeError('Branding configuration requires an absolute native configuration directory.');
    this.filename = configurationDirectoryPath && path.join(configurationDirectoryPath, 'branding.xml');
    this.options = defaultBrandingOptions(); this.onError = onError;
  }
  async initialize() {
    if (!this.filename) return;
    await physicalPath(this.filename);
    let bytes;
    try {
      if (!(await fs.stat(this.filename)).isFile()) return;
      bytes = await fs.readFile(this.filename);
    }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try { this.options = readBrandingOptions(bytes); }
    catch (error) { this.onError(error); }
  }
  save(changes) {
    if (this.#closed) return Promise.reject(Object.assign(new Error('Branding configuration is closing.'), { status: 503 }));
    const operation = this.#tail.then(async () => {
      Object.assign(this.options, changes);
      this.emit('updating', structuredClone(this.options));
      if (!this.filename) throw Object.assign(new Error('Native configuration storage is unavailable.'), { status: 501 });
      await physicalPath(this.filename);
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      await physicalPath(this.filename);
      const bytes = writeBrandingOptions(this.options);
      await fs.writeFile(this.filename, bytes);
      this.emit('updated', structuredClone(this.options));
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  close() { this.#closed = true; return this.#tail; }
}
