import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { XMLValidator } from 'fast-xml-parser';
import { escapeXml } from './xml.js';
import { decodeNativeText } from './native-text.js';

const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

// Update one native element while retaining unrelated configuration content.
function replaceElement(xml, rootName, field, element) {
  if (/<!DOCTYPE\b/iu.test(xml) || XMLValidator.validate(xml) !== true) throw failure('invalid-configuration', 'Invalid native server configuration XML.');
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gu;
  let depth = 0, start, end, rootEnd, root;
  for (const match of xml.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!') || token.startsWith('<?')) continue;
    const name = /^<\/?([^\s/>]+)/u.exec(token)[1];
    if (token.startsWith('</')) {
      depth--;
      if (depth === 1 && name === field && start !== undefined && end === undefined) end = match.index + token.length;
      if (depth === 0) rootEnd = match.index;
    } else {
      if (depth === 0) {
        if (root || name !== rootName) throw failure('invalid-configuration', `A native ${rootName} document is required.`);
        root = match;
      }
      if (depth === 1 && name === field) {
        if (start !== undefined) throw failure('invalid-configuration', `Duplicate ${field} configuration elements are unsupported.`);
        start = match.index;
        if (token.endsWith('/>')) end = match.index + token.length;
      }
      if (!token.endsWith('/>')) depth++;
    }
  }
  if (!root) throw failure('invalid-configuration', `A native ${rootName} document is required.`);
  if (start !== undefined) return xml.slice(0, start) + element + xml.slice(end);
  if (root[0].endsWith('/>')) return xml.slice(0, root.index) + root[0].slice(0, -2) + '>' + element + `</${rootName}>` + xml.slice(root.index + root[0].length);
  return xml.slice(0, rootEnd) + element + xml.slice(rootEnd);
}

export function replaceContentTypes(xml, values) {
  const element = `<ContentTypes>${values.map(pair => `<NameValuePair>${pair.Name == null ? '' : `<Name>${escapeXml(pair.Name)}</Name>`}${pair.Value == null ? '' : `<Value>${escapeXml(pair.Value)}</Value>`}</NameValuePair>`).join('')}</ContentTypes>`;
  return replaceElement(xml, 'ServerConfiguration', 'ContentTypes', element);
}

function configurationText(value) {
  return String(value).replace(/[&<>"\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/gu, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? `&#x${character.codePointAt(0).toString(16).toUpperCase()};`);
}

function replaceValues(xml, rootName, values) {
  for (const [name, value] of Object.entries(values)) xml = replaceElement(xml, rootName, name, `<${name}>${configurationText(value)}</${name}>`);
  return xml;
}

export class ServerConfigurationStore {
  #closed = false;
  #tail = Promise.resolve();
  constructor({ configuration, configurationDirectoryPath, fileSystem = fs }) {
    if (!configuration || !path.isAbsolute(configurationDirectoryPath)) throw new TypeError('Server configuration persistence requires an absolute native configuration directory.');
    Object.assign(this, { configuration, fileSystem, directory: path.resolve(configurationDirectoryPath) });
    this.filename = path.join(this.directory, 'system.xml');
  }

  async #read(filename) {
    const directoryInfo = await this.fileSystem.lstat(this.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !samePath(this.directory, await this.fileSystem.realpath(this.directory))) {
      throw failure('unsafe-configuration-path', 'The configuration directory traverses a link or junction.');
    }
    const info = await this.fileSystem.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(filename, await this.fileSystem.realpath(filename))) {
      throw failure('unsafe-configuration-path', 'Server configuration must be a physical regular file.');
    }
    const bytes = await this.fileSystem.readFile(filename);
    if (bytes.length > 16 * 1024 * 1024) throw failure('invalid-configuration', 'Server configuration exceeds the document size limit.');
    return { bytes, mode: info.mode };
  }

  updateContentTypes(transform) {
    return this.#persist('system.xml', () => {
      const values = transform(structuredClone(this.configuration.ContentTypes ?? []));
      this.configuration.ContentTypes = values;
      return xml => replaceContentTypes(xml, values);
    });
  }

  updateServerValues(values) {
    const fields = new Set(['ServerName', 'UICulture', 'MetadataCountryCode', 'PreferredMetadataLanguage', 'IsStartupWizardCompleted']);
    if (Object.keys(values).some(name => !fields.has(name))) throw new TypeError('Unsupported server configuration field.');
    return this.#persist('system.xml', () => {
      Object.assign(this.configuration, values);
      return xml => replaceValues(xml, 'ServerConfiguration', values);
    });
  }

  updateNetworkValues(values) {
    if (Object.keys(values).some(name => name !== 'EnableRemoteAccess')) throw new TypeError('Unsupported network configuration field.');
    return this.#persist('network.xml', () => {
      Object.assign(this.configuration.NetworkConfiguration ??= {}, values);
      return xml => replaceValues(xml, 'NetworkConfiguration', values);
    });
  }

  #persist(name, change) {
    if (this.#closed) return Promise.reject(failure('closed', 'Server configuration persistence is closing.', 503));
    const operation = this.#tail.then(async () => {
      // The native controller changes the live configuration before calling
      // SaveConfiguration. A persistence failure keeps this live value.
      const render = change(), filename = path.join(this.directory, name);
      const before = await this.#read(filename);
      if (process.platform === 'win32' && !(before.mode & 0o200)) throw failure('EACCES', 'Native configuration is read-only.', 500);
      const xml = decodeNativeText(before.bytes).replace(/^(<\?xml\b[^?]*\bencoding\s*=\s*)(["'])[^"']+\2/iu, '$1$2utf-8$2');
      const bytes = Buffer.from(render(xml));
      const temporary = path.join(this.directory, `.${name}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await this.fileSystem.open(temporary, 'wx', before.mode);
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
        if (!(await this.#read(filename)).bytes.equals(before.bytes)) throw failure('configuration-conflict', 'Server configuration changed during persistence.');
        await this.fileSystem.rename(temporary, filename);
      } finally {
        await handle?.close();
        await this.fileSystem.rm(temporary, { force: true });
      }
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  close() { this.#closed = true; return this.#tail; }
}
