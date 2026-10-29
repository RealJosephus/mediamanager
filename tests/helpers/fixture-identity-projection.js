import { tokenizeJson } from '../../src/core/json-tokens.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeItemJsonValidationManifest } from '../../src/library/native-item-data.js';
import { idKey } from '../../src/library/records.js';
import { projectItemBody } from './http-body-projection.js';

const dataContract = nativeItemJsonValidationManifest();
const viewType = 'MediaBrowser.Controller.Entities.UserView';
const defaultKeyTypes = new Set([viewType, 'MediaBrowser.Controller.Entities.AggregateFolder',
  'MediaBrowser.Controller.Entities.UserRootFolder']);
const snapshotTables = new Map([
  ['baseItems', 'BaseItems'], ['ancestorIds', 'AncestorIds'], ['linkedChildren', 'LinkedChildren'],
  ['itemValues', 'ItemValues'], ['itemValueLinks', 'ItemValuesMap'], ['userData', 'UserData'],
  ['mediaStreamInfos', 'MediaStreamInfos'], ['peoples', 'Peoples'], ['peopleBaseItemMap', 'PeopleBaseItemMap'],
  ['baseItemImageInfos', 'BaseItemImageInfos'], ['baseItemProviders', 'BaseItemProviders'],
  ['baseItemMetadataFields', 'BaseItemMetadataFields'],
]);

export function projectFixtureGuid(value, identities) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(value)
    || !identities.has(idKey(value))) return value;
  const key = idKey(identities.get(idKey(value)));
  const result = value.includes('-')
    ? `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}` : key;
  return value === value.toUpperCase() ? result.toUpperCase() : result;
}

// Data is persistent TEXT. Replace only known relationship tokens; do not
// deserialize/reserialize unknown fields, duplicate properties or numbers.
export function projectItemDataIdentities(text, type, identities, { paths = new Map() } = {}) {
  if (typeof text !== 'string' || !Object.hasOwn(dataContract.contracts, type)) return text;
  let root;
  try { JSON.parse(text); root = tokenizeJson(text); }
  catch { return text; }
  const replacements = [];
  const string = (node, project) => {
    if (typeof node.value !== 'string') return;
    const value = project(node.value);
    if (value !== node.value) replacements.push({ start: node.start, end: node.end, value: JSON.stringify(value) });
  };
  const knownPath = value => paths.get(value) ?? value;
  const fields = (node, contract) => {
    if (!node.properties) return;
    for (const [name, value] of node.properties) {
      if (!Object.hasOwn(contract, name)) continue;
      const field = contract[name];
      const visit = (child, kind) => {
        if (kind === 'guid') string(child, value => projectFixtureGuid(value, identities));
        else if (Object.hasOwn(dataContract.nested, kind)) fields(child, dataContract.nested[kind]);
      };
      if (field.kind.endsWith('[]')) {
        for (const child of value.items ?? []) visit(child, field.kind.slice(0, -2));
      } else visit(value, field.kind);
      if (name === 'PhysicalLocationsList') for (const child of value.items ?? []) string(child, knownPath);
      if (contract === dataContract.nested.LinkedChild && name === 'Path') string(value, knownPath);
    }
  };
  fields(root, dataContract.contracts[type]);
  let result = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return result;
}

/** Bind fixture roles without interpreting descriptive strings as identities. */
export function createFixtureIdentityProjector({ identities, viewRows = [] }) {
  const identity = value => projectFixtureGuid(value, identities);
  const viewPaths = new Map(), metadataPaths = new Map();
  for (const row of viewRows) {
    if (row.Type !== viewType || typeof row.Path !== 'string' || !identities.has(idKey(row.Id))) continue;
    const match = /(?:^|[\\/])views([\\/])([a-f0-9]{32})$/iu.exec(row.Path);
    if (!match || idKey(match[2]) !== idKey(row.Id)) continue;
    const mapped = idKey(identities.get(idKey(row.Id)));
    viewPaths.set(row.Path, row.Path.slice(0, -32) + mapped);
    metadataPaths.set('views/' + match[2], 'views/' + mapped);
  }
  const defaultKey = (value, itemId) => typeof value === 'string' && identities.has(idKey(itemId))
    && idKey(value) === idKey(itemId) ? identity(value) : value;
  const row = (table, source) => {
    const guidFields = new Set(tableDefinition(table).columns
      .filter(column => column.clrType.replace('?', '') === 'Guid').map(column => column.name));
    return Object.fromEntries(Object.entries(source).map(([key, value]) => {
      if (guidFields.has(key)) return [key, identity(value)];
      if (table === 'BaseItems') {
        if (key === 'Data') return [key, projectItemDataIdentities(value, source.Type, identities, { paths: viewPaths })];
        if (key === 'Path' && source.Type === viewType) return [key, viewPaths.get(value) ?? value];
        if (key === 'PresentationUniqueKey' && defaultKeyTypes.has(source.Type)) return [key, defaultKey(value, source.Id)];
      }
      if (table === 'UserData' && key === 'CustomDataKey') return [key, defaultKey(value, source.ItemId)];
      return [key, value];
    }));
  };
  const snapshot = source => {
    if (!source?.database || !source?.filesystem) return source;
    const database = Object.fromEntries(Object.entries(source.database).map(([name, rows]) => [name,
      snapshotTables.has(name) ? rows.map(value => row(snapshotTables.get(name), value)) : rows]));
    const metadata = source.filesystem.metadata;
    return { ...source, database, filesystem: { ...source.filesystem,
      ...(metadata ? { metadata: { ...metadata, entries: metadata.entries.map(entry => {
        for (const [original, mapped] of metadataPaths) {
          if (entry.path === original || entry.path.startsWith(original + '/')) return { ...entry, path: mapped + entry.path.slice(original.length) };
        }
        return entry;
      }) } } : {}),
    } };
  };
  const body = value => projectItemBody(value, { identity, date: value => value,
    path: (value, { owner }) => owner?.Type === 'UserView' && identities.has(idKey(owner.Id))
      ? value.replace(/([\\/]views[\\/])([a-f0-9]{32})$/iu, (match, prefix, id) =>
        idKey(id) === idKey(owner.Id) ? prefix + idKey(identities.get(idKey(owner.Id))) : match) : value,
    item: item => ['UserView', 'AggregateFolder', 'UserRootFolder'].includes(item.Type) && item.UserData
      && Object.hasOwn(item.UserData, 'Key')
      ? { ...item, UserData: { ...item.UserData, Key: defaultKey(item.UserData.Key, item.Id) } } : item,
  });
  const request = (value, route) => {
    if (value?.method !== 'POST' || route?.split('?')[0] !== '/LiveTv/Programs'
      || !value.body || typeof value.body !== 'object' || Array.isArray(value.body)) return value;
    // GetProgramsDto.UserId selects the actual request user. Descriptive and
    // unknown body properties are not identities merely because they match it.
    return { ...value, body: Object.fromEntries(Object.entries(value.body).map(([key, entry]) =>
      [key, key.toLowerCase() === 'userid' ? identity(entry) : entry])) };
  };
  return { identity, row, snapshot, body, request };
}
