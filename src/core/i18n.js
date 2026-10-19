import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { compositeFields, formatComposite } from './composite-format.js';

const canonical = locale => String(locale ?? '').replaceAll('_', '-').toLowerCase();
const nonempty = value => value !== null && value !== undefined && value !== '';

export class Localization {
  #resources = new Map();
  #context = new AsyncLocalStorage();
  constructor({ serverCulture = 'en-US', supportedCultures = ['en-US', 'zh-CN'] } = {}) {
    this.serverCulture = serverCulture || 'en-US';
    this.supportedCultures = [...supportedCultures];
    this.diagnostics = [];
  }

  register(namespace, resources) {
    if (this.#resources.has(namespace)) throw new Error(`Duplicate localization namespace: ${namespace}`);
    const dictionary = new Map();
    for (const [key, value] of Object.entries(resources)) {
      if (typeof value !== 'string') throw new TypeError(`Invalid resource value: ${namespace}.${key}`);
      if (dictionary.has(key.toLowerCase())) throw new Error(`Duplicate resource key: ${namespace}.${key}`);
      dictionary.set(key.toLowerCase(), value);
      try { compositeFields(value); }
      catch (error) { this.diagnostics.push({ namespace, key, problem: error.message }); }
    }
    this.#resources.set(namespace, dictionary);
  }

  get context() { return this.#context.getStore() ?? { culture: this.serverCulture, uiCulture: this.serverCulture }; }
  run(context, callback) { return this.#context.run(Object.freeze({ ...context }), callback); }
  bind(callback) { const context = this.context; return (...args) => this.run(context, () => callback(...args)); }
  runBackground(callback) { return this.run({ culture: this.serverCulture, uiCulture: this.serverCulture }, callback); }

  text(key, { namespace = 'core' } = {}) { return this.#resources.get(namespace)?.get(key.toLowerCase()) ?? key; }

  format(key,values,options) { return formatComposite(this.text(key,options),values); }

  negotiate({ url = '/', headers = {} } = {}) {
    const query = new URL(url, 'http://localhost').searchParams;
    const header = new Headers(headers);
    const supported = new Map(this.supportedCultures.map(value => [canonical(value), value]));
    const match = values => {
      for (let value of values) {
        for (let depth = 0; value && depth <= 5; depth++) {
          const key = String(value).toLowerCase();
          if (supported.has(key)) return supported.get(key);
          const separator = value.lastIndexOf('-');
          value = separator < 0 ? '' : value.slice(0, separator);
        }
      }
      return undefined;
    };
    const queryGet = name => {
      const values = [...query].filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
      return values.length ? [values.join(',')] : [];
    };
    const providers = [];
    let cultures = queryGet('culture');
    let uiCultures = queryGet('ui-culture');
    if (cultures.length || uiCultures.length) providers.push({ cultures: cultures.length ? cultures : uiCultures, uiCultures: uiCultures.length ? uiCultures : cultures });
    // ASP.NET's cookie collection uses case-insensitive names, the last nonempty
    // duplicate, and URI unescaping (not form-url-encoded '+' replacement).
    let cultureCookie;
    for (const pair of (header.get('cookie') ?? '').split(';')) {
      const cookie = /^[ \t]*([!#$%&'*+\-.^_`|~A-Za-z0-9]+)=((?:[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*|"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"))[ \t]*$/.exec(pair);
      if (cookie?.[1].toLowerCase() !== '.aspnetcore.culture' || !cookie[2]) continue;
      cultureCookie = cookie[2].replace(/(?:%[0-9a-f]{2})+/gi, sequence => {
        let decoded = '';
        for (let offset = 0; offset < sequence.length;) {
          let character;
          let length;
          for (length = 3; length <= 12 && offset + length <= sequence.length; length += 3) {
            try { character = decodeURIComponent(sequence.slice(offset, offset + length)); break; } catch { /* Invalid UTF-8 remains percent-escaped. */ }
          }
          if (character === undefined) { decoded += sequence.slice(offset, offset + 3); offset += 3; }
          else { decoded += character; offset += length; }
        }
        return decoded;
      });
    }
    if (cultureCookie) {
      const parts = cultureCookie.split('|');
      if (parts.length === 2 && parts[0].startsWith('c=') && parts[1].startsWith('uic=')) {
        let culture = parts[0].slice(2); let uiCulture = parts[1].slice(4);
        if (!culture) culture = uiCulture; if (!uiCulture) uiCulture = culture;
        if (culture) providers.push({ cultures: [culture], uiCultures: [uiCulture] });
      }
    }
    // StringWithQualityHeaderValue's tolerant list parser retries one character
    // after a failed parse. A malformed parameter can therefore become a later
    // token and consume one of the provider's first three candidates.
    const acceptLanguage = header.get('accept-language') ?? '';
    const whitespace = index => { while (acceptLanguage[index] === ' ' || acceptLanguage[index] === '\t') index++; return index; };
    const skipSeparators = index => {
      index = whitespace(index);
      let separator = false;
      while (acceptLanguage[index] === ',') { separator = true; index = whitespace(index + 1); }
      return { index, separator };
    };
    const parseLanguage = index => {
      let current = skipSeparators(index).index;
      if (current === acceptLanguage.length) return { next: current };
      const language = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+/.exec(acceptLanguage.slice(current))?.[0];
      if (!language) return null;
      current = whitespace(current + language.length);
      let quality = 1;
      if (acceptLanguage[current] === ';') {
        current = whitespace(current + 1);
        if (!['q', 'Q'].includes(acceptLanguage[current])) return null;
        current = whitespace(current + 1);
        if (acceptLanguage[current] !== '=') return null;
        current = whitespace(current + 1);
        const number = /^[01](?:\.[0-9]*)?/.exec(acceptLanguage.slice(current))?.[0];
        if (!number || number.length > 10 || /[0-9]/.test(acceptLanguage[current + number.length] ?? '')) return null;
        quality = Number(number);
        if (quality > 1) return null;
        current = whitespace(current + number.length);
      }
      const next = skipSeparators(current);
      if (!next.separator && next.index < acceptLanguage.length) return null;
      return { next: next.index, language, quality };
    };
    const parsedLanguages = [];
    for (let index = 0; index < acceptLanguage.length && parsedLanguages.length < 3;) {
      const parsed = parseLanguage(index);
      if (!parsed) { index++; continue; }
      index = parsed.next;
      if (parsed.language) parsedLanguages.push(parsed);
    }
    const languages = parsedLanguages.sort((a, b) => b.quality - a.quality || Number(a.language === '*') - Number(b.language === '*')).map(value => value.language);
    if (languages.length) providers.push({ cultures: languages, uiCultures: languages });
    for (const provider of providers) {
      const culture = match(provider.cultures); const uiCulture = match(provider.uiCultures);
      if (culture || uiCulture) return { culture: culture ?? this.serverCulture, uiCulture: uiCulture ?? this.serverCulture };
    }
    return { culture: this.serverCulture, uiCulture: this.serverCulture };
  }
}

export async function createCoreLocalization(options) {
  const localization = new Localization(options);
  const resources = JSON.parse(await readFile(new URL('./resources/en-US.json', import.meta.url), 'utf8'));
  localization.register('core', resources);
  return localization;
}

export function metadataLocale({ item = {}, parents = [], collectionFolders = [], library = {}, server = {} } = {}) {
  function inherit(field, fallbackField, fallback) {
    const inherited = [item[field], ...parents.map(parent => parent[field]), ...collectionFolders.map(folder => folder[field]), library[fallbackField]].find(nonempty);
    return inherited ?? (Object.hasOwn(server,fallbackField) ? server[fallbackField] : fallback);
  }
  return { language: inherit('PreferredMetadataLanguage', 'PreferredMetadataLanguage', 'en'),
    country: inherit('PreferredMetadataCountryCode', 'MetadataCountryCode', 'US') };
}
