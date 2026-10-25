import { newNativeItemEntity } from '../library/native-item-entity.js';
import { nativeGuid } from '../users/native.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { parseInvariantDate } from '../core/invariant-date-parse.js';
import { parseInvariantDateExact } from '../core/invariant-date-format.js';
import { readLocalXmlStepsStreaming } from './local-xml-stream.js';
import { tryParseClrInt32Enum } from './clr-enum.js';
import { trySetProviderId } from './provider-ids.js';
import { clrTrim } from './whitespace.js';
import { addPerson } from './people.js';

const nativeTypes = { BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet', Playlist: 'MediaBrowser.Controller.Playlists.Playlist' };
const mediaTypes = ['Unknown', 'Video', 'Audio', 'Photo', 'Book'];
const metadataFields = ['Cast', 'Genres', 'ProductionLocations', 'Studios', 'Tags', 'Name', 'Overview', 'Runtime', 'OfficialRating'];
const personKinds = ['Unknown', 'Actor', 'Director', 'Composer', 'Writer', 'GuestStar', 'Producer', 'Conductor', 'Lyricist',
  'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller',
  'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator', 'Narrator'];
const strings = { OriginalTitle: 'OriginalTitle', LocalTitle: 'Name', SortTitle: 'ForcedSortName', Overview: 'Overview',
  Description: 'Overview', Language: 'PreferredMetadataLanguage', CountryCode: 'PreferredMetadataCountryCode',
  ContentRating: 'OfficialRating', MPAARating: 'OfficialRating', CustomRating: 'CustomRating' };
const scalarNames = new Set([...Object.keys(strings), 'Added', 'CriticRating', 'LockedFields', 'PlaceOfBirth', 'RunningTime',
  'AspectRatio', 'LockData', 'Network', 'Director', 'Writer', 'Actors', 'GuestStars', 'Trailer', 'DisplayOrder', 'ProductionYear',
  'Rating', 'IMDBrating', 'BirthDate', 'PremiereDate', 'FirstAired', 'DeathDate', 'EndDate', 'CollectionNumber', 'OwnerUserId', 'Format3D']);
const zeroGuid = '00000000-0000-0000-0000-000000000000';
const numericText = raw => clrTrim(raw).replace(/\0+$/u, '');
const int32 = raw => { const value = numericText(raw); return /^[+-]?\d+$/u.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? Number(value) : null; };

function single(raw, { decimalOnly = false } = {}) {
  const value = numericText(raw), special = /^([+-]?)(NaN|Infinity)$/iu.exec(value);
  if (special) return special[2].toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity;
  const expression = decimalOnly ? /^(?:\d+(?:\.\d*)?|\.\d+)$/u : /^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
  return expression.test(value) ? Math.fround(Number(value.replaceAll(',', ''))) : null;
}

function stringArray(raw) {
  const value = clrTrim(raw), separator = value.includes(',') && !value.includes('|') ? ',' : '|';
  return value.split(separator).filter(entry => clrTrim(entry)).map(clrTrim);
}

function append(item, field, value) {
  if (value && !item[field].some(entry => ordinalIgnoreCaseEquals(entry, value))) item[field] = [...item[field], value];
}
function trailer(item, value) {
  if (value && !item.RemoteTrailers.some(entry => ordinalIgnoreCaseEquals(entry.Url, value))) {
    item.RemoteTrailers = [...item.RemoteTrailers, { Url: value }];
  }
}
function personFromNode(node) {
  const person = { Name: '', Role: '', Type: 'Actor', SortOrder: null, ImageUrl: null, ProviderIds: {} };
  for (const child of node.children) {
    const value = clrTrim(child.text);
    if (['name', 'Name'].includes(child.name)) person.Name = value;
    else if (['role', 'Role'].includes(child.name)) person.Role = value;
    else if (['type', 'Type'].includes(child.name)) person.Type = tryParseClrInt32Enum(value, personKinds, { ignoreCase: true }) ?? 'Unknown';
    else if (['order', 'sortorder', 'SortOrder'].includes(child.name)) { const order = int32(value); if (order != null) person.SortOrder = order; }
    else if (child.name === 'thumb') person.ImageUrl = value;
  }
  return person.Name ? person : null;
}
function linkedChild(node) {
  const child = { Type: 'Manual', ItemId: null, Path: null, LibraryItemId: null };
  for (const field of node.children) {
    if (field.name === 'Path') child.Path = clrTrim(field.text);
    else if (field.name === 'ItemId') child.LibraryItemId = clrTrim(field.text);
  }
  return child.Path || child.LibraryItemId ? child : null;
}
function shareFromNode(node) {
  let userId = null, canEdit = false;
  for (const field of node.children) {
    if (field.name === 'UserId') userId = clrTrim(field.text);
    else if (field.name === 'CanEdit') canEdit = ordinalIgnoreCaseEquals(clrTrim(field.text), 'true');
  }
  try { return userId ? { UserId: nativeGuid(userId).toLowerCase(), CanEdit: canEdit } : null; } catch { return null; }
}

/** Parse the native local XML contract into a fresh typed entity. Supplying a
 * result retains observable partial assignments when XmlReader throws. */
export async function parseLocalXml(xml, { type, externalIdInfos = [], signal, result, linkedChildren, session } = {}) {
  if (!nativeTypes[type]) throw new TypeError(`Unsupported local XML parser type: ${type}`);
  result ??= { Item: newNativeItemEntity(nativeTypes[type]), HasMetadata: false };
  result.People = [];
  const item = result.Item, providerIds = new Map();
  for (const info of externalIdInfos) {
    const key = typeof info === 'string' ? info : info.Key;
    const nodeName = ordinalIgnoreCaseKey(key + 'Id');
    if (!providerIds.has(nodeName)) providerIds.set(nodeName, key);
  }
  providerIds.set(ordinalIgnoreCaseKey('IMDB'), 'Imdb');
  const buffered = new Map();
  const memberWriters = new Map();
  if (!linkedChildren || !session) throw new TypeError('Native XML members require their runtime SQL importer session.');
  // Provider names are ordinal-ignore-case, but all built-in XML nodes are exact.
  const names = name => scalarNames.has(name) || type === 'Playlist' && name === 'PlaylistMediaType'
    || providerIds.has(ordinalIgnoreCaseKey(name));
  try { for await (const step of readLocalXmlStepsStreaming(xml, { scalarNames: names, type })) {
    if (step.type === 'traversal') { signal?.throwIfAborted(); continue; }
    if (step.type === 'container-start') {
      if (['CollectionItems','PlaylistItems'].includes(step.name)) memberWriters.set(step.name,
        await linkedChildren.createWriter({ session, parentId: item.Id }));
      else buffered.set(step.name, []);
      continue;
    }
    if (step.type === 'container-end') {
      const entries = buffered.get(step.name);
      if (step.name === 'Tags') item.Tags = [...new Set(entries)];
      else if (step.name === 'Shares') item.Shares = entries;
      else if (['CollectionItems', 'PlaylistItems'].includes(step.name)) {
        item.LinkedChildren = await memberWriters.get(step.name).finish(); memberWriters.delete(step.name);
        await linkedChildren.flushReleases({ session });
      }
      buffered.delete(step.name); continue;
    }
    if (step.type === 'container-node') {
      const { node, container } = step, value = clrTrim(node.text);
      if (container === 'TagLines' && value) item.Tagline = value;
      else if (container === 'Genres') append(item, 'Genres', value);
      else if (container === 'Studios') append(item, 'Studios', value);
      else if (container === 'Trailers') trailer(item, value);
      else if (container === 'Persons') { const person = personFromNode(node); if (person) addPerson(result.People, person); }
      else if (container === 'Tags' && value) buffered.get(container).push(value);
      else if (container === 'Shares') { const share = shareFromNode(node); if (share) buffered.get(container).push(share); }
      else if (['CollectionItems', 'PlaylistItems'].includes(container)) { const child = linkedChild(node); if (child) await memberWriters.get(container).append(child); }
      continue;
    }
    const { node } = step, value = clrTrim(node.text);
    if (Object.hasOwn(strings, node.name)) item[strings[node.name]] = value;
    else if (node.name === 'Added') { const date = parseInvariantDate(node.text, { offsetMinutes: () => 0 }); if (date != null) item.DateCreated = date; }
    else if (node.name === 'CriticRating') { const rating = single(node.text); if (rating != null) item.CriticRating = rating; }
    else if (node.name === 'LockedFields' && value) item.LockedFields = node.text.split('|').map(value =>
      tryParseClrInt32Enum(value, metadataFields, { ignoreCase: true })).filter(value => value != null);
    else if (node.name === 'RunningTime' && value) { const minutes = int32(value.split(' ')[0]); if (minutes != null) item.RunTimeTicks = BigInt(minutes) * 600000000n; }
    else if (node.name === 'LockData') item.IsLocked = ordinalIgnoreCaseEquals(value, 'true');
    else if (node.name === 'Network') for (const studio of stringArray(node.text)) append(item, 'Studios', studio);
    else if (['Director', 'Writer', 'Actors', 'GuestStars'].includes(node.name)) for (const name of stringArray(node.text)) {
      addPerson(result.People, { Name: name, Type: { Actors: 'Actor', GuestStars: 'GuestStar' }[node.name] ?? node.name,
        Role: null, SortOrder: null, ImageUrl: null, ProviderIds: {} });
    }
    else if (node.name === 'Trailer') trailer(item, value);
    else if (node.name === 'DisplayOrder' && type === 'BoxSet' && value) item.DisplayOrder = value;
    else if (node.name === 'ProductionYear') { const year = int32(node.text); if (year > 1850) item.ProductionYear = year; }
    else if (['Rating', 'IMDBrating'].includes(node.name) && value) { const rating = single(value.replaceAll(',', '.'), { decimalOnly: true }); if (rating != null) item.CommunityRating = rating; }
    else if (['BirthDate', 'PremiereDate', 'FirstAired', 'DeathDate', 'EndDate'].includes(node.name)) {
      const date = parseInvariantDateExact(node.text, 'yyyy-MM-dd');
      if (date != null) {
        if (['DeathDate', 'EndDate'].includes(node.name)) item.EndDate = date;
        else { item.PremiereDate = date; item.ProductionYear = Number(date.slice(0, 4)); }
      }
    }
    else if (node.name === 'CollectionNumber') trySetProviderId(item, 'TmdbCollection', value);
    else if (node.name === 'OwnerUserId' && type === 'Playlist') { try { const id = nativeGuid(value).toLowerCase(); if (id !== zeroGuid) item.OwnerUserId = id; } catch {} }
    else if (node.name === 'PlaylistMediaType' && type === 'Playlist') { const mediaType = tryParseClrInt32Enum(value, mediaTypes); if (mediaType != null) item.PlaylistMediaType = mediaType; }
    else if (providerIds.has(ordinalIgnoreCaseKey(node.name))) trySetProviderId(item, providerIds.get(ordinalIgnoreCaseKey(node.name)), value);
  }
  } finally {
    for (const writer of memberWriters.values()) await writer.abort();
  }
  result.HasMetadata = true;
  return result;
}

export async function fetchLocalXml(read, options) {
  const result = options.result ?? { Item: newNativeItemEntity(nativeTypes[options.type]), HasMetadata: false };
  result.People = [];
  return parseLocalXml(await read(), { ...options, result });
}
