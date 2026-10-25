import { EventEmitter } from 'node:events';
import path from 'node:path';
import { decodeNativeText } from '../core/native-text.js';
import { idKey, libraryError } from './records.js';
import { createVirtualPathExpander, createVirtualPathReverser, defaultLibraryOptions, parseLibraryOptions } from './options.js';

const imageTypes = ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile'];
const embeddedSubtitles = ['AllowAll', 'AllowText', 'AllowImage', 'AllowNone'];
const typeArrays = ['MetadataFetchers', 'MetadataFetcherOrder', 'ImageFetchers', 'ImageFetcherOrder', 'SimilarItemProviders', 'SimilarItemProviderOrder'];
const arrayFields = new Set(['MetadataSavers', 'DisabledLocalMetadataReaders', 'LocalMetadataReaderOrder', 'DisabledSubtitleFetchers',
  'SubtitleFetcherOrder', 'DisabledMediaSegmentProviders', 'MediaSegmentProviderOrder', 'SubtitleDownloadLanguages',
  'DisabledLyricFetchers', 'LyricFetcherOrder', 'CustomTagDelimiters', 'DelimiterWhitelist']);
const fieldOrder = ['Enabled', 'EnablePhotos', 'EnableRealtimeMonitor', 'EnableLUFSScan', 'EnableChapterImageExtraction',
  'ExtractChapterImagesDuringLibraryScan', 'EnableTrickplayImageExtraction', 'ExtractTrickplayImagesDuringLibraryScan', 'PathInfos',
  'SaveLocalMetadata', 'EnableInternetProviders', 'EnableAutomaticSeriesGrouping', 'EnableEmbeddedTitles', 'EnableEmbeddedExtrasTitles',
  'EnableEmbeddedEpisodeInfos', 'AutomaticRefreshIntervalDays', 'PreferredMetadataLanguage', 'MetadataCountryCode', 'SeasonZeroDisplayName',
  'MetadataSavers', 'DisabledLocalMetadataReaders', 'LocalMetadataReaderOrder', 'DisabledSubtitleFetchers', 'SubtitleFetcherOrder',
  'DisabledMediaSegmentProviders', 'MediaSegmentProviderOrder', 'SkipSubtitlesIfEmbeddedSubtitlesPresent', 'SkipSubtitlesIfAudioTrackMatches',
  'SubtitleDownloadLanguages', 'RequirePerfectSubtitleMatch', 'SaveSubtitlesWithMedia', 'SaveLyricsWithMedia', 'SaveTrickplayWithMedia',
  'DisabledLyricFetchers', 'LyricFetcherOrder', 'PreferNonstandardArtistsTag', 'UseCustomTagDelimiters', 'CustomTagDelimiters',
  'DelimiterWhitelist', 'AutomaticallyAddToCollection', 'AllowEmbeddedSubtitles', 'TypeOptions'];
const defaultValueAttributes = new Set(['SaveLyricsWithMedia', 'SaveTrickplayWithMedia', 'PreferNonstandardArtistsTag', 'UseCustomTagDelimiters']);
const typeDefaults = () => ({ Type: null, ...Object.fromEntries(typeArrays.map(name => [name, []])), ImageOptions: [] });
const copyNonNull = (defaults, source) => Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, structuredClone(source[name] ?? value)]));

// CollectionFolder.SaveLibraryOptions clones through JsonDefaults, whose
// null properties are omitted. Array entries retain their null values.
function cloneOptions(options) {
  const clone = copyNonNull(defaultLibraryOptions(), options);
  clone.PathInfos = clone.PathInfos.map(info => info === null ? null : copyNonNull({ Path: '' }, info));
  clone.TypeOptions = clone.TypeOptions.map(type => {
    if (type === null) return null;
    const copy = copyNonNull(typeDefaults(), type);
    copy.ImageOptions = copy.ImageOptions.map(image => image === null ? null : copyNonNull({ Type: 'Primary', Limit: 1, MinWidth: 0 }, image));
    return copy;
  });
  return clone;
}

const escapedText = value => String(value).replace(/[&<>"\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/gu,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? `&#x${character.charCodeAt(0).toString(16).toUpperCase()};`);

/** Preserve a readable document prefix if enum serialization fails. */
export function serializeLibraryOptions(options) {
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n', failure;
  const stack = [];
  const open = (name, attributes = '') => { xml += `<${name}${attributes}>`; stack.push(name); };
  const close = () => { xml += `</${stack.pop()}>`; };
  const nil = name => { xml += `<${name} xsi:nil="true"/>`; };
  const scalar = (name, value) => { if (value != null) { open(name); xml += escapedText(value); close(); } };
  const strings = (name, values) => {
    if (values == null) return;
    open(name); for (const value of values) value == null ? nil('string') : scalar('string', value); close();
  };
  const enumValue = (value, names) => {
    const name = typeof value === 'number' ? names[value] : value;
    if (!names.includes(name)) throw Object.assign(new Error('A library option contains an invalid XML enum value.'), { code: 'invalid-library-option-enum' });
    return name;
  };
  open('LibraryOptions', ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"');
  try {
    for (const name of fieldOrder) {
      const value = options[name];
      if (defaultValueAttributes.has(name) && value === false) continue;
      if (arrayFields.has(name)) strings(name, value);
      else if (name === 'PathInfos') {
        open(name); for (const info of value) { if (info === null) nil('MediaPathInfo'); else { open('MediaPathInfo'); scalar('Path', info.Path); close(); } } close();
      } else if (name === 'TypeOptions') {
        open(name);
        for (const type of value) {
          if (type === null) { nil('TypeOptions'); continue; }
          open('TypeOptions'); scalar('Type', type.Type);
          for (const field of typeArrays.slice(0, 4)) strings(field, type[field]);
          open('ImageOptions');
          for (const image of type.ImageOptions) {
            if (image === null) { nil('ImageOption'); continue; }
            open('ImageOption'); scalar('Type', enumValue(image.Type, imageTypes)); scalar('Limit', image.Limit); scalar('MinWidth', image.MinWidth); close();
          }
          close(); for (const field of typeArrays.slice(4)) strings(field, type[field]); close();
        }
        close();
      } else scalar(name, name === 'AllowEmbeddedSubtitles' ? enumValue(value, embeddedSubtitles) : value);
    }
  } catch (error) { failure = error; }
  while (stack.length) close();
  return { bytes: Buffer.from(xml + '\n'), failure };
}

const identityPathApi = value => /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(value) ? path.win32 : path.posix;

export class LibraryOptionsStore extends EventEmitter {
  #closed = false;
  #tail = Promise.resolve();
  #cache = new Map();
  #directories = new Map();
  constructor(options = {}) {
    const { fileSystem, programDataPath, optionsById = new Map(), onError = () => {} } = options;
    super(); this.fileSystem = fileSystem;
    if (!programDataPath || !path.isAbsolute(programDataPath)) throw new TypeError('Library options require an absolute native program-data path.');
    this.root = path.resolve(programDataPath);
    this.expandPath = createVirtualPathExpander(options);
    this.reversePath = createVirtualPathReverser(options);
    Object.assign(this, { optionsById, onError });
  }
  #enqueue(operation) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Library options storage is closing.'));
    const result = this.#tail.then(operation); this.#tail = result.catch(() => {}); return result;
  }
  #publishRegistered(directory, options) {
    for (const [key, registered] of this.#directories) if (registered === directory) {
      if (this.optionsById instanceof Map) this.optionsById.set(key, options); else this.optionsById[key] = options;
    }
  }
  #publish(directory, options) {
    this.#cache.set(directory, options);
    this.#publishRegistered(directory, options);
  }
  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Cache invalidation reporting cannot change its result. */ }
  }
  async #filename(directory) {
    const api = identityPathApi(directory);
    if (typeof directory !== 'string' || !api.isAbsolute(directory)) throw libraryError(400, 'An absolute library identity path is required.');
    const filename = api.join(directory, 'options.xml');
    // Identity paths may belong to another operating system or instance root.
    // Only an explicit storage mapping authorizes their backend; adapters and
    // mount capabilities enforce link rejection and write permissions.
    try { this.fileSystem.resolve(filename); }
    catch (error) {
      if (error.code !== 'not-found') throw error;
      throw Object.assign(libraryError(501, 'Library options require an explicit storage mapping.'), { code: 'unmapped-path', cause: error });
    }
    return filename;
  }
  async #get(directory) {
    if (this.#cache.has(directory)) return this.#cache.get(directory);
    const filename = await this.#filename(directory);
    let options;
    try { options = parseLibraryOptions(decodeNativeText(await this.fileSystem.readFile(filename)), { expandPath: this.expandPath }); }
    catch (error) {
      if (!['ENOENT', 'EISDIR', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) this.#report(error);
      options = defaultLibraryOptions();
    }
    this.#publish(directory, options); return options;
  }
  async #reload(directory) {
    let filename;
    try { filename = await this.#filename(directory); }
    catch (error) {
      this.#report(error);
      const options = defaultLibraryOptions();
      // Keep unsafe paths out of the directory cache so a later direct get
      // still performs the authoritative path check and rejects them.
      this.#publishRegistered(directory, options);
      return options;
    }
    let options;
    try { options = parseLibraryOptions(decodeNativeText(await this.fileSystem.readFile(filename)), { expandPath: this.expandPath }); }
    catch (error) {
      if (!['ENOENT', 'EISDIR', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) this.#report(error);
      options = defaultLibraryOptions();
    }
    this.#publish(directory, options); return options;
  }
  get(directory) { return this.#enqueue(() => this.#get(directory)); }
  bind(id, directory) {
    return this.#enqueue(async () => {
      this.#directories.set(idKey(id), directory);
      const options = await this.#get(directory); this.#publish(directory, options); return options;
    });
  }
  save(directory, options) {
    return this.#enqueue(async () => {
      this.#publish(directory, options);
      const clone = cloneOptions(options);
      for (const info of clone.PathInfos) if (info.Path != null && info.Path !== '') info.Path = this.reversePath(info.Path);
      const filename = await this.#filename(directory), handle = await this.fileSystem.open(filename, 'w');
      try {
        const { bytes, failure } = serializeLibraryOptions(clone);
        await handle.writeFile(bytes);
        if (failure) throw failure;
      } finally { await handle.close(); }
      this.emit('updated', { LibraryPath: directory, LibraryOptions: options });
    });
  }
  clear() {
    return this.#enqueue(async () => {
      this.#cache.clear();
      for (const directory of new Set(this.#directories.values())) await this.#reload(directory);
    });
  }
  close() { this.#closed = true; return this.#tail; }
}
