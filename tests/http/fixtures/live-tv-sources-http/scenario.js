import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { md5Guid } from '../../../../src/core/identity.js';
import { dateTicks } from '../../../../src/library/records.js';
import { guideChannelId } from '../../../../src/library/live-tv-guide-channel.js';
import { tableDefinition } from '../../../../src/database/model.js';
import { nativeItemJsonContract, nativeItemJsonValidationManifest } from '../../../../src/library/native-item-data.js';
import { parseLosslessJson, stringifyNativeJson } from '../../../../src/core/json.js';
import { tokenizeJson } from '../../../../src/core/json-tokens.js';
import { projectItemBody, projectProblemTrace } from '../../../helpers/http-body-projection.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos',
  'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
export const snapshot = async database => Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.rows(table)])));
export async function sqliteSnapshot(root) {
  const source = new SqliteDatabase(databaseFilename(root), { readOnly: true, requireMigrationHistory: true });
  try { return await snapshot(source); } finally { source.close(); }
}
export const bytesDescription = bytes => ({ length: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });
export async function fileDescription(filename) {
  try { return { exists: true, ...bytesDescription(await readFile(filename)) }; }
  catch (cause) { if (cause.code === 'ENOENT') return { exists: false }; throw cause; }
}
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const stamp = value => value.toISOString().replace(/[-:TZ]/gu, '').slice(0, 14) + ' +0000';
export async function prepareSources(root, input) {
  await mkdir(root, { recursive: true });
  const playlist = path.join(root, 'source.m3u'), guide = path.join(root, 'guide.xml'), clock = new Date(); clock.setUTCMilliseconds(0);
  const start = new Date(clock.getTime() + 86400000), end = new Date(start.getTime() + 7200000);
  const m3u = '#EXTM3U\n' + input.channels.map(channel => '#EXTINF:-1 tvg-id="' + channel.guideId + '" tvg-chno="'
    + channel.number + '",' + channel.name + '\n' + channel.url + '\n').join('');
  const document = '<?xml version="1.0" encoding="UTF-8"?><tv>' + input.channels.map(channel => '<channel id="' + channel.providerId
    + '"><display-name>' + xml(channel.providerName) + '</display-name></channel>').join('')
    + input.channels.map(channel => '<programme channel="' + channel.providerId + '" start="' + stamp(start) + '" stop="' + stamp(end) + '">'
      + '<title>' + xml(channel.title) + '</title><desc>Controlled programme overview 中文</desc><category>' + channel.category + '</category></programme>').join('') + '</tv>';
  await writeFile(playlist, m3u, { flag: 'wx' }); await writeFile(guide, document, { flag: 'wx' });
  return { root, playlist, guide, start: start.toISOString(), end: end.toISOString(),
    channels: input.channels.map(channel => { const externalId = 'm3u_' + md5Guid(playlist) + md5Guid(channel.url);
      return { ...channel, externalId, internalId: guideChannelId('Emby', externalId) }; }),
    files: { playlist: bytesDescription(Buffer.from(m3u)), guide: bytesDescription(Buffer.from(document)) } };
}
export const initialConfiguration = days => '<LiveTvOptions><GuideDays>' + days + '</GuideDays><TunerHosts /><ListingProviders /></LiveTvOptions>';
export async function stateFiles(root, cachePath, sources) {
  const files = { configuration: await fileDescription(path.join(root, 'config/livetv.xml')),
    timers: await fileDescription(path.join(root, 'data/data/livetv/timers.json')),
    seriesTimers: await fileDescription(path.join(root, 'data/data/livetv/seriestimers.json')),
    playlist: await fileDescription(sources.playlist), guide: await fileDescription(sources.guide),
    retainedSeed: await fileDescription(sources.retainedSeed),
    countries: await fileDescription(path.join(cachePath, 'sd-countries.json')),
    sentinel: await fileDescription(path.join(path.dirname(cachePath), 'data/source-sentinel_channels')) };
  const cache = {};
  for (const directory of ['', 'xmltv']) {
    let names; try { names = await readdir(path.join(cachePath, directory)); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    for (const name of names.sort()) if (directory === 'xmltv' ? /\.xml(?:\.tmp)?$/u.test(name) : name.endsWith('_channels')) {
      const relative = directory ? directory + '/' + name : name;
      cache[relative] = await fileDescription(path.join(cachePath, directory, name));
    }
  }
  const tasks = {};
  for (const name of (await readdir(path.join(root, 'config/ScheduledTasks'))).filter(value => value.endsWith('.js')).sort()) {
    tasks[name] = await fileDescription(path.join(root, 'config/ScheduledTasks', name));
  }
  return { ...files, cache, tasks };
}
export function storageDocument(root) {
  const style = process.platform === 'win32' ? 'windows' : 'posix';
  return { instances: [{ id: 'source-fixture', type: 'local', config: { root, writable: false } }],
    mounts: [{ path: '/source-fixture', instanceId: 'source-fixture', root: '/', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/source-fixture', style, caseSensitive: style !== 'windows', purpose: 'library',
      returnAccess: 'The same controlled source files remain readable by native and Node.' }] };
}
export const portableMountContract = root => ({ mounts: [{ mountId: 'source-fixture', identityRoot: root,
  accessRoot: '/source-fixture', pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
  caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] });

const creationDates = new Set(['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed', 'DateLastMediaAdded']);
const guidPattern = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const observed = (value, clock) => clock && typeof value === 'string'
  && dateTicks(value) >= BigInt(clock.start) * 10000n + 621355968000000000n
  && dateTicks(value) < BigInt(clock.end + 1) * 10000n + 621355968000000000n;
const date = (value, key, clock) => creationDates.has(key) && observed(value, clock)
  ? '$observed-clock' : { ticks: dateTicks(value).toString() };
const sourceIdentity = (value, ids) => typeof value === 'string' && guidPattern.test(value)
  ? ids[idKey(value)] ?? value : value;

function sourceInfo(value, ids, listing = false) {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === 'Id' ? sourceIdentity(entry, ids)
      : listing && key === 'EnabledTuners' && Array.isArray(entry) ? entry.map(value => sourceIdentity(value, ids)) : entry]));
}
function configuration(value, ids) {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    ['TunerHosts', 'ListingProviders'].includes(key) && Array.isArray(entry) ? entry.map(value => sourceInfo(value, ids, key === 'ListingProviders')) : entry]));
}

// The caller supplies the actual HTTP or typed-file role. Strings in unknown
// objects, provider dictionaries, headers and descriptions remain literal.
export function canonical(value, { ids = {}, clock, role, route = '', status } = {}) {
  if (role === 'configuration') return configuration(value, ids);
  if (role === 'channels') return Array.isArray(value) ? value.map(channel => object(channel)
    ? { ...channel, ...(Object.hasOwn(channel, 'TunerHostId') ? { TunerHostId: sourceIdentity(channel.TunerHostId, ids) } : {}) } : channel) : value;
  const pathname = route.split('?')[0];
  if (role === 'request') {
    if (!object(value) || !Object.hasOwn(value, 'body')) return value;
    const body = ['/LiveTv/TunerHosts', '/LiveTv/ListingProviders'].includes(pathname) ? sourceInfo(value.body, ids, pathname === '/LiveTv/ListingProviders')
      : pathname === '/LiveTv/ChannelMappings' && object(value.body) ? { ...value.body,
        ...(Object.hasOwn(value.body, 'ProviderId') ? { ProviderId: sourceIdentity(value.body.ProviderId, ids) } : {}) } : value.body;
    return { ...value, body };
  }
  if (role !== 'http') return value;
  if (status >= 400) return projectProblemTrace(value, status);
  if (pathname === '/System/Configuration/livetv') return configuration(value, ids);
  if (['/LiveTv/TunerHosts', '/LiveTv/ListingProviders', '/LiveTv/ListingProviders/Default'].includes(pathname)) return sourceInfo(value, ids, pathname !== '/LiveTv/TunerHosts');
  if (['/LiveTv/Channels', '/LiveTv/Programs'].includes(pathname)) return projectItemBody(value,
    { date: (value, { field }) => date(value, field, clock) });
  return value;
}

const dataManifest = nativeItemJsonValidationManifest();
function unknownData(node, contract) {
  if (node.value === null) return false;
  if (!node.properties) return true;
  return node.properties.some(([name, child]) => {
    if (!Object.hasOwn(contract, name)) return true;
    const kind = contract[name].kind.replace(/\[\]$/u, ''), nested = dataManifest.nested[kind];
    if (!nested) return false;
    return contract[name].kind.endsWith('[]') ? (child.items ?? []).some(value => unknownData(value, nested))
      : child.value === null ? false : unknownData(child, nested);
  });
}
function itemData(text, row, { clock, baselineItems } = {}) {
  if (typeof text !== 'string' || !clock || !Object.hasOwn(dataManifest.contracts, row.Type)
    || baselineItems?.get(idKey(row.Id))?.Data === text) return text;
  let root;
  try { parseLosslessJson(text); root = tokenizeJson(text); } catch { return text; }
  if (!root.properties) return text;
  const saved = root.properties.some(([name, child]) => name === 'DateLastSaved' && observed(child.value, clock));
  if (!saved) return text;
  const contract = Object.fromEntries(nativeItemJsonContract(row.Type).map(field => [field.name, field]));
  const replacements = [];
  for (const [name, child] of root.properties) {
    if (contract[name]?.kind !== 'date' || typeof child.value !== 'string') continue;
    replacements.push({ start: child.start, end: child.end, value: JSON.stringify(date(child.value, name, clock)) });
  }
  let projected = text;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    projected = projected.slice(0, replacement.start) + replacement.value + projected.slice(replacement.end);
  }
  // Original/unknown TEXT keeps its token spelling, duplicates and order. A
  // newly saved typed document with only known fields may use JSON layout that
  // differs between producers; its actual values still compare in full.
  const names = root.properties.map(([name]) => name);
  return !unknownData(root, contract) && new Set(names).size === names.length ? parseLosslessJson(projected) : projected;
}
export const stable = value => stringifyNativeJson(ordered(value));
export function canonicalRows(values, options) {
  const ids = { ...options?.ids };
  if (options?.inheritedItemValueIds) {
    const identities = new Set();
    for (const row of values.ItemValues) {
      const identity = JSON.stringify([row.Type, row.Value]); assert.ok(!identities.has(identity), 'ItemValues (Type, Value) must identify one actual row.'); identities.add(identity);
      assert.ok(guidPattern.test(row.ItemValueId));
      if (!options.inheritedItemValueIds.has(idKey(row.ItemValueId))) ids[idKey(row.ItemValueId)] = '$item-value:' + identity;
    }
    const actual = new Set(values.ItemValues.map(row => idKey(row.ItemValueId)));
    for (const row of values.ItemValuesMap) assert.ok(actual.has(idKey(row.ItemValueId)), 'A captured item-value relation must resolve its actual unique referent.');
  }
  return Object.fromEntries(Object.entries(values).map(([table, rows]) => {
    const columns = new Map(tableDefinition(table).columns.map(column => [column.name, column]));
    return [table, rows.map(row => stable(Object.fromEntries(Object.entries(row).map(([key, value]) => {
      const type = columns.get(key)?.clrType.replace('?', '');
      if (type === 'Guid' && typeof value === 'string' && guidPattern.test(value)) return [key, ids[idKey(value)] ?? idKey(value)];
      if (type === 'DateTime' && typeof value === 'string') return [key, date(value, key, options?.clock)];
      if (table === 'BaseItems' && key === 'Data') return [key, itemData(value, row, options)];
      return [key, value];
    })))).sort()];
  }));
}
