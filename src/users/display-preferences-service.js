import { md5Guid, lowerInvariant } from '../core/identity.js';
import { domainError, nativeGuid, enumName } from './native.js';
import { tryParseClrInt32Enum } from '../metadata/clr-enum.js';
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

export const displayPreferenceEnums = Object.freeze({
  ScrollDirection: ['Horizontal', 'Vertical'], SortOrder: ['Ascending', 'Descending'],
  IndexingKind: ['PremiereDate', 'ProductionYear', 'CommunityRating'], ChromecastVersion: ['Stable', 'Unstable'],
  HomeSectionType: ['None', 'SmallLibraryTiles', 'LibraryButtons', 'ActiveRecordings', 'Resume', 'ResumeAudio', 'LatestMedia', 'NextUp', 'LiveTv', 'ResumeBook'],
  ViewType: ['Albums', 'AlbumArtists', 'Artists', 'Channels', 'Collections', 'Episodes', 'Favorites', 'Genres', 'Guide', 'Movies', 'Networks',
    'Playlists', 'Programs', 'Recordings', 'Schedule', 'Series', 'Shows', 'Songs', 'Suggestions', 'Trailers', 'Upcoming', 'Authors', 'Books',
    'Folders', 'Mixed', 'Photos', 'PhotoAlbums', 'SeriesTimers', 'Studios', 'Videos']
});
const emptyGuid = nativeGuid('00000000000000000000000000000000');
const sectionDefaults = [1, 4, 5, 9, 8, 7, 6, 0];
const booleanWhitespace = new RegExp(`^[${clrWhitespace}\\u0000]+|[${clrWhitespace}\\u0000]+$`, 'gu');
const parseEnum = (value, type) => tryParseClrInt32Enum(value, displayPreferenceEnums[type], { ignoreCase: true });
const enumNumber = (value, type) => typeof value === 'number' ? value : displayPreferenceEnums[type].indexOf(value);
const enumText = (value, type) => String(enumName(value, displayPreferenceEnums[type]));
const present = value => value != null && value !== '';

function parseInteger(value) {
  const text = value.replace(/\0+$/u, '');
  if (!/^[\x09-\x0d\x20]*[+-]?[0-9]+[\x09-\x0d\x20]*$/u.test(text)) throw new TypeError('Invalid display preference integer.');
  const number = BigInt(text);
  if (number < -2147483648n || number > 2147483647n) throw new RangeError('Display preference integer is out of range.');
  return Number(number);
}

function itemIdentity(value) {
  try { return nativeGuid(value); } catch { return nativeGuid(md5Guid(value)); }
}

async function* pages(database, table, where) {
  let after;
  while (true) {
    const rows = await database.rows(table, { where, limit: 128, ...(after && { after }) });
    for (const row of rows) yield row;
    if (rows.length < 128) return;
    after = { Id: rows.at(-1).Id };
  }
}

export class DisplayPreferencesService {
  #pending = new Set();
  #closed = false;
  #closing;

  constructor({ store, onError = () => {} } = {}) {
    if (!store) throw new TypeError('Display preferences require a PostgreSQL store.');
    Object.assign(this, { store, onError });
  }

  #run(operation) {
    if (this.#closed) return Promise.reject(domainError(503, 'Display preferences are closed.'));
    const pending = this.store.run(operation);
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }

  async #display(database, where) {
    const current = (await database.rows('DisplayPreferences', { where, limit: 1 }))[0];
    if (current) return current;
    return this.#createDisplay(where);
  }

  #createDisplay(where) {
    return this.store.transaction(database => database.insert('DisplayPreferences', {
      ...where, ShowSidebar: false, ShowBackdrop: true, ScrollDirection: 0, IndexBy: null,
      SkipForwardLength: 30000, SkipBackwardLength: 10000, ChromecastVersion: 0,
      EnableNextVideoInfoOverlay: false, DashboardTheme: null, TvHome: null
    }));
  }

  async #item(database, where) {
    const current = (await database.rows('ItemDisplayPreferences', { where, limit: 1 }))[0];
    if (current) return current;
    // The native manager persists an empty ItemId until a POST saves this entity.
    return this.store.transaction(database => database.insert('ItemDisplayPreferences', {
      ...where, ItemId: emptyGuid, ViewType: 0, RememberIndexing: false, IndexBy: null,
      RememberSorting: false, SortBy: 'SortName', SortOrder: 0
    }));
  }

  get(displayPreferencesId, userId, client) {
    const where = { UserId: nativeGuid(userId), ItemId: itemIdentity(displayPreferencesId), Client: client };
    return this.#run(async database => {
      const custom = new Map();
      let display = await database.transaction(async database => {
        const current = (await database.rows('DisplayPreferences', { where, limit: 1 }))[0];
        if (current) for await (const section of pages(database, 'HomeSection', { DisplayPreferencesId: current.Id })) {
          custom.set('homesection' + section.Order, lowerInvariant(enumText(section.Type, 'HomeSectionType')));
        }
        return current;
      }, { readOnly: true, isolation: 'repeatable-read' });
      display ??= await this.#createDisplay(where);
      const item = await this.#item(database, where);
      custom.set('chromecastVersion', lowerInvariant(enumText(display.ChromecastVersion, 'ChromecastVersion')));
      custom.set('skipForwardLength', String(display.SkipForwardLength));
      custom.set('skipBackLength', String(display.SkipBackwardLength));
      custom.set('enableNextVideoInfoOverlay', display.EnableNextVideoInfoOverlay ? 'True' : 'False');
      custom.set('tvhome', display.TvHome); custom.set('dashboardTheme', display.DashboardTheme);
      await database.transaction(async database => {
        for await (const entry of pages(database, 'CustomItemDisplayPreferences', where)) {
          if (!custom.has(entry.Key)) custom.set(entry.Key, entry.Value);
        }
      }, { readOnly: true, isolation: 'repeatable-read' });
      return { Id: display.ItemId.toLowerCase(), SortBy: item.SortBy,
        IndexBy: display.IndexBy == null ? null : enumText(display.IndexBy, 'IndexingKind'),
        RememberIndexing: item.RememberIndexing, PrimaryImageHeight: 250, PrimaryImageWidth: 250,
        CustomPrefs: custom, ScrollDirection: enumName(display.ScrollDirection, displayPreferenceEnums.ScrollDirection),
        ShowBackdrop: display.ShowBackdrop, RememberSorting: item.RememberSorting,
        SortOrder: enumName(item.SortOrder, displayPreferenceEnums.SortOrder), ShowSidebar: display.ShowSidebar, Client: display.Client };
    });
  }

  update(displayPreferencesId, userId, client, input) {
    const where = { UserId: nativeGuid(userId), ItemId: itemIdentity(displayPreferencesId), Client: client };
    return this.#run(async database => {
      const display = await this.#display(database, where);
      display.IndexBy = parseEnum(input.IndexBy, 'IndexingKind');
      if (display.IndexBy != null) display.IndexBy = enumNumber(display.IndexBy, 'IndexingKind');
      display.ShowBackdrop = input.ShowBackdrop; display.ShowSidebar = input.ShowSidebar;
      display.ScrollDirection = enumNumber(input.ScrollDirection, 'ScrollDirection');
      const custom = new Map(input.CustomPrefs);
      const chromecast = custom.get('chromecastVersion');
      const parsed = present(chromecast) ? parseEnum(chromecast, 'ChromecastVersion') : 'Stable';
      if (parsed == null) {
        const numeric = clrTrim(chromecast).replace(/\0+$/u, '');
        if (/^[+-]?\d+$/u.test(numeric) && (Number(numeric) < -2147483648 || Number(numeric) > 2147483647)) {
          throw new RangeError('Chromecast version is out of range.');
        }
        throw domainError(400, 'Invalid Chromecast version.');
      }
      display.ChromecastVersion = enumNumber(parsed, 'ChromecastVersion'); custom.delete('chromecastVersion');
      const overlay = custom.get('enableNextVideoInfoOverlay');
      const boolean = present(overlay) ? overlay.replace(booleanWhitespace, '') : 'true';
      if (!ordinalIgnoreCaseEquals(boolean, 'true') && !ordinalIgnoreCaseEquals(boolean, 'false')) throw new TypeError('Invalid next video overlay preference.');
      display.EnableNextVideoInfoOverlay = ordinalIgnoreCaseEquals(boolean, 'true'); custom.delete('enableNextVideoInfoOverlay');
      for (const [key, field] of [['skipBackLength', 'SkipBackwardLength'], ['skipForwardLength', 'SkipForwardLength']]) {
        display[field] = present(custom.get(key)) ? parseInteger(custom.get(key)) : 15000; custom.delete(key);
      }
      display.DashboardTheme = custom.has('dashboardTheme') ? custom.get('dashboardTheme') : ''; custom.delete('dashboardTheme');
      display.TvHome = custom.has('tvhome') ? custom.get('tvhome') : ''; custom.delete('tvhome');
      const sections = [];
      for (const [key, value] of custom) {
        if (!ordinalIgnoreCaseEquals(key.slice(0, 'homesection'.length), 'homesection')) continue;
        const order = parseInteger(key.slice('homesection'.length));
        let type = parseEnum(value, 'HomeSectionType');
        if (type == null) {
          if (order < 0) throw new RangeError('Home section order is out of range.');
          type = order < 8 ? sectionDefaults[order] : 0;
        } else type = enumNumber(type, 'HomeSectionType');
        custom.delete(key); sections.push({ DisplayPreferencesId: display.Id, Order: order, Type: type });
      }
      for (const [key, value] of custom) {
        if (!ordinalIgnoreCaseEquals(key.slice(0, 'landing-'.length), 'landing-')) continue;
        if (!present(value)) custom.delete(key);
        else if (parseEnum(value, 'ViewType') == null) {
          this.onError(new Error(`Invalid ViewType: ${value}`)); custom.delete(key);
        }
      }
      const item = await this.#item(database, where);
      Object.assign(item, { SortBy: input.SortBy ?? 'SortName', SortOrder: enumNumber(input.SortOrder, 'SortOrder'),
        RememberIndexing: input.RememberIndexing, RememberSorting: input.RememberSorting, ItemId: where.ItemId });
      // ExecuteDelete commits before SaveChanges inserts the replacement dictionary.
      await this.store.transaction(database => database.deleteWhere('CustomItemDisplayPreferences', where));
      await this.store.transaction(async database => {
        for (const [Key, Value] of custom) await database.insert('CustomItemDisplayPreferences', { ...where, Key, Value });
      });
      await this.store.transaction(database => database.update('ItemDisplayPreferences', { Id: item.Id }, item));
      await this.store.transaction(async database => {
        await database.update('DisplayPreferences', { Id: display.Id }, display);
        // Detached native HomeSections are appended; previous rows remain persisted.
        for (const section of sections) await database.insert('HomeSection', section);
      });
    });
  }

  close() {
    this.#closed = true;
    return this.#closing ??= Promise.allSettled([...this.#pending]).then(() => {});
  }
}
