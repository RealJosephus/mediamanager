import { EMPTY_ID, MIN_DATE, dateText, guid, idKey } from './records.js';
import { nativeItemDescriptor, nativeItemJsonDateState, nativeItemTypes, newNativeItemEntity,
  setNativeItemJsonDateState } from './native-item-entity.js';
import { nativeGuid } from '../users/native.js';
import { tokenizeJson } from '../core/json-tokens.js';
import { quoteNativeJsonString as quoteNativeString } from '../core/json.js';

// This contract follows JsonDefaults' actual type metadata. Repository-only
// fields and ignored runtime properties never enter a serialized entity.
const field = (name, kind, nullable = false, readOnly = false) => Object.freeze({ name, kind, nullable, readOnly });
const baseFields = [field('Size', 'long', true), field('Container', 'string', true), field('IsHD', 'bool', false, true),
  field('IsShortcut', 'bool'), field('ShortcutPath', 'string', true), field('Width', 'int'), field('Height', 'int'),
  field('DateLastSaved', 'date'), field('RemoteTrailers', 'MediaUrl[]', true)];
const folderFields = [field('IsRoot', 'bool')];
const videoFields = [field('AdditionalParts', 'string[]', true), field('LocalAlternateVersions', 'string[]', true),
  field('LinkedAlternateVersions', 'LinkedChild[]', true), field('Timestamp', 'Timestamp', true),
  field('SubtitleFiles', 'string[]', true), field('AudioFiles', 'string[]', true), field('HasSubtitles', 'bool'),
  field('IsPlaceHolder', 'bool'), field('DefaultVideoStreamIndex', 'int', true), field('VideoType', 'VideoType'),
  field('IsoType', 'IsoType', true), field('Video3DFormat', 'Video3DFormat', true), field('AspectRatio', 'string', true)];
const audioFields = [field('HasLyrics', 'bool', true), field('LyricFiles', 'string[]', true)];
const photoFields = [field('CameraMake', 'string', true), field('CameraModel', 'string', true), field('Software', 'string', true),
  field('ExposureTime', 'double', true), field('FocalLength', 'double', true), field('Orientation', 'Orientation', true),
  ...['Aperture', 'ShutterSpeed', 'Latitude', 'Longitude', 'Altitude'].map(name => field(name, 'double', true)),
  field('IsoSpeedRating', 'int', true)];
const nestedFields = {
  MediaUrl: [field('Url', 'string', true), field('Name', 'string', true)],
  LinkedChild: [field('Path', 'string', true), field('Type', 'LinkedChildType'), field('LibraryItemId', 'string', true),
    field('ItemId', 'guid', true)],
  PlaylistUserPermissions: [field('UserId', 'guid'), field('CanEdit', 'bool')]
};
const enumValues = {
  VideoType: ['VideoFile', 'Iso', 'Dvd', 'BluRay'], IsoType: ['Dvd', 'BluRay'],
  Video3DFormat: ['HalfSideBySide', 'FullSideBySide', 'FullTopAndBottom', 'HalfTopAndBottom', 'MVC'],
  Timestamp: ['None', 'Zero', 'Valid'], SeriesStatus: ['Continuing', 'Ended', 'Unreleased'],
  DayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  TrailerType: [null, 'ComingSoonToTheaters', 'ComingSoonToDvd', 'ComingSoonToStreaming', 'Archive', 'LocalTrailer'],
  LinkedChildType: ['Manual', 'Shortcut', 'LocalAlternateVersion', 'LinkedAlternateVersion'],
  MediaType: ['Unknown', 'Video', 'Audio', 'Photo', 'Book'],
  Orientation: [null, 'TopLeft', 'TopRight', 'BottomRight', 'BottomLeft', 'LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'],
  CollectionType: Object.assign(['unknown', 'movies', 'tvshows', 'music', 'musicvideos', 'trailers', 'homevideos',
    'boxsets', 'books', 'photos', 'livetv', 'playlists', 'folders'], {
    101: 'tvshowseries', 102: 'tvgenres', 103: 'tvgenre', 104: 'tvlatest', 105: 'tvnextup', 106: 'tvresume',
    107: 'tvfavoriteseries', 108: 'tvfavoriteepisodes', 109: 'movielatest', 110: 'movieresume', 111: 'moviemovies',
    112: 'moviecollection', 113: 'moviefavorites', 114: 'moviegenres', 115: 'moviegenre'
  })
};

export function nativeItemJsonContract(nativeType) {
  const descriptor = nativeItemDescriptor(nativeType);
  let prefix = [];
  switch (descriptor.type) {
    case 'AggregateFolder': prefix = [field('VirtualChildren', 'entity[]', false, true), field('PhysicalLocationsList', 'string[]', true), ...folderFields]; break;
    case 'CollectionFolder': prefix = [field('PhysicalLocationsList', 'string[]', true), field('PhysicalFolderIds', 'guid[]', true),
      field('CollectionType', 'CollectionType', true), ...folderFields]; break;
    case 'UserView': prefix = [field('ViewType', 'CollectionType', true), field('DisplayParentId', 'guid'), field('UserId', 'guid', true), ...folderFields]; break;
    case 'Playlist': prefix = [field('OwnerUserId', 'guid'), field('OpenAccess', 'bool'), field('Shares', 'PlaylistUserPermissions[]', true),
      field('PlaylistMediaType', 'MediaType'), ...folderFields]; break;
    case 'Movie': prefix = [field('TmdbCollectionName', 'string', true), ...videoFields]; break;
    case 'Episode': prefix = [...['AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber', 'IndexNumberEnd']
      .map(name => field(name, 'int', true)), ...videoFields]; break;
    case 'Trailer': prefix = [field('TrailerTypes', 'TrailerType[]', true), ...videoFields]; break;
    case 'Series': prefix = [field('AirDays', 'DayOfWeek[]', true), field('AirTime', 'string', true), field('DisplayOrder', 'string', true),
      field('Status', 'SeriesStatus', true), ...folderFields]; break;
    case 'BoxSet': prefix = [field('DisplayOrder', 'string', true), field('LibraryFolderIds', 'guid[]', true), ...folderFields]; break;
    case 'MusicAlbum': prefix = [field('AlbumArtists', 'string[]', true), field('Artists', 'string[]', true), ...folderFields]; break;
    case 'Photo': prefix = photoFields; break;
    case 'Book': prefix = [field('SupportsPlayedStatus', 'bool', false, true), field('SupportsPositionTicksResume', 'bool', false, true)]; break;
    default: prefix = descriptor.family === 'video' ? videoFields : descriptor.family === 'audio' ? audioFields
      : descriptor.family === 'folder' ? folderFields : [];
  }
  return Object.freeze([...prefix, ...baseFields]);
}

/**
 * Frozen source-of-truth projection consumed by PostgreSQL's typed Data gate.
 * Read-only properties are ignored by Json.NET before conversion, so they are
 * deliberately absent. The SQL validator must validate every occurrence of
 * every remaining known property, including duplicates and nested entries.
 */
export function nativeItemJsonValidationManifest() {
  const property = ({ kind, nullable }) => ({ kind, nullable: Boolean(nullable) });
  return {
    contracts: Object.fromEntries(nativeItemTypes.flatMap(nativeType => {
      if (!nativeItemDescriptor(nativeType).requiresJson) return [];
      return [[nativeType, Object.fromEntries(nativeItemJsonContract(nativeType)
        .filter(entry => !entry.readOnly).map(entry => [entry.name, property(entry)]))]];
    })),
    enums: Object.fromEntries(Object.entries(enumValues).map(([kind, values]) => [kind, [...values]])),
    nested: Object.fromEntries(Object.entries(nestedFields).map(([kind, fields]) =>
      [kind, Object.fromEntries(fields.filter(entry => !entry.readOnly)
        .map(entry => [entry.name, property(entry)]))])),
  };
}

/** Only this error family triggers native JsonException constructor fallback. */
export class NativeItemJsonError extends Error {
  constructor(code, path, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NativeItemJsonError'; this.code = code; this.path = path;
  }
}
const invalid = (code, path, message) => { throw new NativeItemJsonError(code, path, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const arrayElement = kind => field('', kind, kind === 'string' || kind === 'entity' || Object.hasOwn(nestedFields, kind));
const nativeDoubleValue = Symbol('nativeDoubleValue');
const nativeDateValue = Symbol('nativeDateValue');

function parseTypedJson(text) {
  // Keep JSON.parse as the strict syntax gate; the shared token tree then
  // retains duplicate properties and lossless scalar values in source order.
  JSON.parse(text);
  const occurrences = new WeakMap();
  const materialize = node => {
    if (node.properties) {
      const value = {}, entries = [];
      occurrences.set(value, entries);
      for (const [name, childNode] of node.properties) {
        const child = materialize(childNode);
        entries.push({ name, value: child, source: text.slice(childNode.start, childNode.end) });
        // Define rather than assign so a JSON "__proto__" key remains data.
        Object.defineProperty(value, name, { value: child, enumerable: true, configurable: true, writable: true });
      }
      return value;
    }
    if (node.items) {
      const value = [], entries = [];
      occurrences.set(value, entries);
      for (const [index, childNode] of node.items.entries()) {
        const child = materialize(childNode);
        value.push(child);
        entries.push({ name: String(index), value: child, source: text.slice(childNode.start, childNode.end) });
      }
      return value;
    }
    return node.value;
  };
  return { value: materialize(tokenizeJson(text)), occurrences };
}

const propertyOccurrences = (value, occurrences) => occurrences.get(value)
  ?? Object.entries(value).map(([name, entry]) => ({ name, value: entry, source: undefined }));

function nativeDateParts(value, path) {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,16}))?(?:(Z)|([+-])(\d\d):(\d\d))?$/u.exec(value);
  if (!match) invalid('property-type', path, `Expected an ISO DateTime for ${path}.`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[10] == null ? 0 : Number(match[10]);
  const offsetMinute = match[11] == null ? 0 : Number(match[11]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59
    || offsetHour === 14 && offsetMinute !== 0) {
    invalid('property-type', path, `Invalid ISO DateTime for ${path}.`);
  }
  return { year, month, day, hour, minute, second,
    fraction: (match[7] ?? '').slice(0, 7).padEnd(7, '0'), utc: match[8] === 'Z',
    offsetSign: match[9] ?? null, offsetHour, offsetMinute };
}

const padDatePart = value => String(value).padStart(2, '0');

function utcMilliseconds(parts) {
  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, Number(parts.fraction.slice(0, 3)));
  return value.getTime();
}

function dateWallText(parts) {
  return `${String(parts.year).padStart(4, '0')}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`
    + `T${padDatePart(parts.hour)}:${padDatePart(parts.minute)}:${padDatePart(parts.second)}`;
}

function readNativeDate(value, path) {
  const parts = nativeDateParts(value, path);
  let wall = parts;
  let kind = parts.utc ? 'Utc' : 'Unspecified';
  let offsetMinutes = null;
  if (parts.offsetSign) {
    const parsedOffset = (parts.offsetHour * 60 + parts.offsetMinute) * (parts.offsetSign === '-' ? -1 : 1);
    const instant = new Date(utcMilliseconds(parts) - parsedOffset * 60000);
    if (!Number.isFinite(instant.getTime()) || instant.getFullYear() < 1 || instant.getFullYear() > 9999) {
      invalid('property-type', path, `Invalid ISO DateTime for ${path}.`);
    }
    wall = { year: instant.getFullYear(), month: instant.getMonth() + 1, day: instant.getDate(),
      hour: instant.getHours(), minute: instant.getMinutes(), second: instant.getSeconds(), fraction: parts.fraction };
    kind = 'Local';
    offsetMinutes = -instant.getTimezoneOffset();
  }
  const canonical = `${dateWallText(wall)}.${parts.fraction}Z`;
  return { value: canonical, state: { value: canonical, kind, offsetMinutes } };
}

function readValue(value, spec, path, occurrences, source, onDateState) {
  const kind = spec.kind;
  if (value === null) {
    if (spec.nullable || kind === 'string' || kind.endsWith('[]')) return null;
    if (kind === 'guid') return EMPTY_ID;
    invalid('property-type', path, `A nonnullable ${kind} cannot read null.`);
  }
  // NullableStructConverter consumes an empty string, but nullable GUIDs have
  // their own converter whose Guid.Parse failure is not a JsonException.
  if (spec.nullable && value === '' && kind !== 'string' && kind !== 'guid' && !kind.endsWith('[]')) return null;
  if (kind.endsWith('[]')) {
    if (!Array.isArray(value)) invalid('property-type', path, `Expected an array for ${path}.`);
    const entries = occurrences.get(value);
    return value.map((entry, index) => readValue(entry, arrayElement(kind.slice(0, -2)), `${path}[${index}]`, occurrences,
      entries?.[index]?.source));
  }
  if (kind === 'string') {
    if (typeof value === 'string') return value;
    if (['number', 'bigint', 'boolean'].includes(typeof value)) return source ?? String(value);
    invalid('property-type', path, `A string converter cannot consume the complete object at ${path}.`);
  }
  if (kind === 'bool') {
    if (typeof value !== 'boolean') invalid('property-type', path, `Expected a Boolean for ${path}.`);
    return value;
  }
  if (['int', 'long', 'double'].includes(kind)) {
    const text = typeof value === 'string' ? value : source ?? String(value);
    const numberPattern = typeof value === 'string'
      ? /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u
      : /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
    if (!['string', 'number', 'bigint'].includes(typeof value) || !numberPattern.test(text)) {
      invalid('property-type', path, `Expected a JSON number for ${path}.`);
    }
    if (kind === 'double') {
      const number = Number(text);
      if (!Number.isFinite(number)) invalid('property-type', path, `Out-of-range Double at ${path}.`);
      return number;
    }
    if (!(typeof value === 'string' ? /^[+-]?\d+$/u : /^-?\d+$/u).test(text)) {
      invalid('property-type', path, `Expected an integer for ${path}.`);
    }
    const integer = BigInt(text), limit = kind === 'int' ? 2147483648n : 9223372036854775808n;
    if (integer < -limit || integer >= limit) invalid('property-type', path, `Out-of-range ${kind} at ${path}.`);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
  }
  if (kind === 'guid') {
    if (typeof value !== 'string') invalid('property-type', path, `Expected a GUID string for ${path}.`);
    // Guid.Parse FormatException is intentionally outside the JSON fallback.
    return nativeGuid(value).toLowerCase();
  }
  if (kind === 'date') {
    if (typeof value !== 'string') {
      invalid('property-type', path, `Expected an ISO DateTime for ${path}.`);
    }
    const result = readNativeDate(value, path);
    onDateState?.(result.state);
    return result.value;
  }
  if (enumValues[kind]) {
    const values = enumValues[kind];
    if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
      && (source == null || /^-?(?:0|[1-9]\d*)$/u.test(source))) return values[value] ?? value;
    if (typeof value !== 'string') invalid('property-type', path, `Expected an enum string or integer for ${path}.`);
    const name = value.trim();
    const matching = values.find(entry => entry != null && entry.toLowerCase() === name.toLowerCase());
    if (matching != null) return matching;
    if (name.includes(',')) {
      let combined = 0;
      for (const part of name.split(',')) {
        const component = part.trim();
        const entry = values.findIndex(candidate => candidate != null && candidate.toLowerCase() === component.toLowerCase());
        if (entry >= 0) combined |= entry;
        else if (/^[+-]?\d+$/u.test(component) && Number(component) >= -2147483648 && Number(component) <= 2147483647) {
          combined |= Number(component);
        } else {
          invalid('enum', path, `Unknown ${kind} value at ${path}.`);
        }
      }
      return values[combined] ?? combined;
    }
    if (/^[+-]?\d+$/u.test(name)) {
      const integer = Number(name);
      if (integer >= -2147483648 && integer <= 2147483647) return values[integer] ?? integer;
    }
    invalid('enum', path, `Unknown ${kind} value at ${path}.`);
  }
  if (nestedFields[kind]) {
    if (!isObject(value)) invalid('property-type', path, `Expected a typed ${kind} object for ${path}.`);
    const defaults = kind === 'MediaUrl' ? { Url: null, Name: null } : kind === 'LinkedChild'
      ? { Path: null, Type: 'Manual', LibraryItemId: null, ItemId: null } : { UserId: EMPTY_ID, CanEdit: false };
    const fields = new Map(nestedFields[kind].map(property => [property.name, property]));
    for (const occurrence of propertyOccurrences(value, occurrences)) {
      const property = fields.get(occurrence.name);
      if (!property) continue;
      defaults[property.name] = readValue(occurrence.value, property, `${path}.${property.name}`, occurrences, occurrence.source);
    }
    return defaults;
  }
  throw new TypeError(`Unimplemented native JSON property kind: ${kind}`);
}

export function deserializeNativeItemData(fullName, data, { skip = false, onJsonError, onUnknownType } = {}) {
  let descriptor;
  try { descriptor = nativeItemDescriptor(fullName); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    onUnknownType?.({ fullName }); return null;
  }
  let item = newNativeItemEntity(fullName);
  if (skip || !descriptor.requiresJson || data == null) return item;
  try {
    let parsed;
    try { parsed = typeof data === 'string' ? parseTypedJson(data) : { value: data, occurrences: new WeakMap() }; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new NativeItemJsonError('syntax', '$', 'Invalid native entity JSON.', error);
    }
    if (parsed.value === null) return item;
    if (!isObject(parsed.value)) invalid('root-type', '$', 'A native entity requires a JSON object.');
    const contract = nativeItemJsonContract(fullName);
    const fields = new Map(contract.map(property => [property.name, property]));
    const values = new Map();
    for (const occurrence of propertyOccurrences(parsed.value, parsed.occurrences)) {
      const property = fields.get(occurrence.name);
      if (!property || property.readOnly) continue;
      let dateState = null;
      const value = readValue(occurrence.value, property, '$.' + property.name, parsed.occurrences,
        occurrence.source, state => { dateState = state; });
      item[property.name] = value;
      if (dateState) setNativeItemJsonDateState(item, property.name, dateState);
      values.set(property.name, value);
    }
    const accepted = {};
    for (const property of contract) if (values.has(property.name)) accepted[property.name] = values.get(property.name);
    item.Data = accepted;
    return item;
  } catch (error) {
    if (!(error instanceof NativeItemJsonError)) throw error;
    onJsonError?.({ fullName, data, error });
    item = newNativeItemEntity(fullName);
    return item;
  }
}

function dateOffsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${padDatePart(Math.floor(absolute / 60))}:${padDatePart(absolute % 60)}`;
}

function writeNativeDate(value, state) {
  const canonical = dateText(value ?? MIN_DATE);
  const fraction = canonical.slice(20, 27);
  // JsonDateTimeConverter uses a literal Z whenever the millisecond component
  // is zero, even when the DateTime Kind is Local or Unspecified.
  if (fraction.slice(0, 3) === '000') return canonical;
  const digits = fraction.replace(/0+$/u, '');
  const suffix = state?.value === canonical && state.kind === 'Unspecified' ? ''
    : state?.value === canonical && state.kind === 'Local' ? dateOffsetText(state.offsetMinutes) : 'Z';
  return `${canonical.slice(0, 19)}.${digits}${suffix}`;
}

function writeValue(value, spec, owner) {
  if (value == null) return null;
  if (spec.kind.endsWith('[]')) {
    if (!Array.isArray(value)) throw new TypeError(`Native ${spec.name} must be a typed array.`);
    return value.map(entry => writeValue(entry, arrayElement(spec.kind.slice(0, -2))));
  }
  if (spec.kind === 'guid') return spec.nullable && idKey(value) === idKey(EMPTY_ID) ? null : idKey(guid(value));
  if (spec.kind === 'date') {
    return { [nativeDateValue]: writeNativeDate(value, nativeItemJsonDateState(owner, spec.name)) };
  }
  if (enumValues[spec.kind]) {
    if (typeof value === 'number') return enumValues[spec.kind][value] ?? value;
    return readValue(value, spec, '$.' + spec.name, new WeakMap());
  }
  if (nestedFields[spec.kind]) return writeObject(value, nestedFields[spec.kind]);
  if (spec.kind === 'entity') return writeObject(value, nativeItemJsonContract(value.NativeType));
  if (spec.kind === 'double') return { [nativeDoubleValue]: value };
  return value;
}

function writeObject(item, fields) {
  const output = {};
  for (const property of fields) {
    const value = item[property.name];
    if (value == null) continue;
    output[property.name] = writeValue(value, property, item);
  }
  return output;
}

function encodeNativeDouble(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Non-finite native JSON number.');
  if (Object.is(value, -0)) return '-0';
  const negative = value < 0;
  const source = Math.abs(value).toString().toLowerCase();
  if (source === '0') return '0';
  let digits;
  let exponent;
  if (source.includes('e')) {
    const [coefficient, sourceExponent] = source.split('e');
    digits = coefficient.replace('.', '').replace(/0+$/u, '');
    exponent = Number(sourceExponent);
  } else {
    const [integer, fraction = ''] = source.split('.');
    const combined = integer + fraction;
    const first = combined.search(/[1-9]/u);
    digits = combined.slice(first).replace(/0+$/u, '');
    exponent = integer.length - first - 1;
  }
  let encoded;
  if (exponent < -4 || exponent > 16) {
    encoded = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '')
      + `E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  } else {
    const decimal = exponent + 1;
    encoded = decimal <= 0 ? `0.${'0'.repeat(-decimal)}${digits}`
      : decimal >= digits.length ? digits + '0'.repeat(decimal - digits.length)
        : `${digits.slice(0, decimal)}.${digits.slice(decimal)}`;
  }
  return negative ? '-' + encoded : encoded;
}

function encodeNativeData(value) {
  if (value === null) return 'null';
  if (isObject(value) && Object.hasOwn(value, nativeDoubleValue)) return encodeNativeDouble(value[nativeDoubleValue]);
  // Utf8JsonWriter's typed DateTime path preserves the offset '+', unlike its
  // string encoder. Only the validated ISO text from a declared date field
  // takes this path; date-looking string fields still use native escaping.
  if (isObject(value) && Object.hasOwn(value, nativeDateValue)) return JSON.stringify(value[nativeDateValue]);
  if (typeof value === 'string') return quoteNativeString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite native JSON number.');
    return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(encodeNativeData).join(',') + ']';
  if (isObject(value)) return '{' + Object.entries(value).map(([key, entry]) => quoteNativeString(key) + ':' + encodeNativeData(entry)).join(',') + '}';
  throw new TypeError('Unsupported native JSON value.');
}

export function serializeNativeItemData(item, { allTypes = false } = {}) {
  const descriptor = nativeItemDescriptor(item.NativeType);
  if (!allTypes && !descriptor.requiresJson) return null;
  return encodeNativeData(writeObject(item, nativeItemJsonContract(item.NativeType)));
}
