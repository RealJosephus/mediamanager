import { nativeGuid } from '../../users/native.js';
import { itemTypes } from './format.js';
import { getNewItemId } from '../../core/identity.js';
import path from 'node:path';

export function readIdentityMap(value = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['items', 'users'].includes(k))
  )
    throw new Error('Invalid identity mapping');
  const result = {};
  for (const group of ['items', 'users']) {
    const entries = value[group] ?? {};
    if (typeof entries !== 'object' || Array.isArray(entries))
      throw new Error('Expected a GUID mapping for ' + group);
    const pairs = Object.entries(entries).map(([a, b]) => [nativeGuid(a), nativeGuid(b)]);
    if (
      new Set(pairs.map(([id]) => id)).size !== pairs.length ||
      new Set(pairs.map(([, id]) => id)).size !== pairs.length
    )
      throw new Error('Identity map must be one-to-one');
    result[group] = Object.fromEntries(pairs);
  }
  return result;
}
export function activeSystemRoots(rows, report) {
  const result = new Map(rows),
    references = new Map();
  for (const [key, r] of rows) {
    if (!key.startsWith('item/')) continue;
    for (const id of [r.ParentId, ...r.Members, ...(r.PhysicalFolders ?? [])])
      if (id) references.set(id, 1 + (references.get(id) ?? 0));
  }
  for (const type of [itemTypes[1], itemTypes[2]]) {
    const candidates = [...rows].filter(([key, r]) => key.startsWith('item/') && r.type === type);
    if (candidates.length < 2) continue;
    const live = candidates.filter(([key]) => references.has(key.slice(5)));
    if (live.length !== 1) throw new Error('Ambiguous active system roots for ' + type);
    for (const [key] of candidates) {
      if (key === live[0][0]) continue;
      result.delete(key);
      report('origin-only', 'item', key.slice(5), 'system root', 'detached duplicate root');
    }
  }
  return result;
}
export function alignIdentities(source, target, previous, explicit, freshManager) {
  const map = { items: {}, users: {} };
  for (const group of Object.keys(map)) {
    for (const [a, b] of Object.entries(previous?.[group] ?? {})) map[group][b] = a;
    Object.assign(map[group], explicit?.[group]);
  }
  for (const type of [itemTypes[1], itemTypes[2]]) {
    const ids = (rows) =>
      [...rows]
        .filter(([key, row]) => key.startsWith('item/') && row.type === type)
        .map(([key]) => key.slice(5));
    const a = ids(source),
      b = ids(target);
    if (freshManager && a.length === 1 && !b.length && !map.items[a[0]]) {
      const programDataPath = path.join(freshManager, 'data');
      const location = path.join(programDataPath, 'root', type === itemTypes[1] ? '' : 'default');
      map.items[a[0]] = nativeGuid(getNewItemId(location, type, { programDataPath }));
    }
    if (a.length === 1 && b.length === 1 && a[0] !== b[0] && !map.items[a[0]]) map.items[a[0]] = b[0];
  }
  return readIdentityMap(map);
}
export function translatedKey(key, map) {
  const [kind, id, user] = key.split('/');
  if (kind === 'user') return 'user/' + (map.users[id] ?? id);
  const item = map.items[id] ?? id;
  return kind === 'item' ? 'item/' + item : [kind, item, map.users[user] ?? user].join('/');
}
export function translatedRows(rows, map, target, initialize) {
  if (!Object.keys(map.items).length && !Object.keys(map.users).length) return rows;
  const mapped = new Map();
  for (const [key, value] of rows) {
    const [kind, id] = key.split('/');
    const k = translatedKey(key, map);
    let record = value;
    if (kind === 'item') {
      record = {
        ...value,
        ParentId: map.items[value.ParentId] ?? value.ParentId,
        SeriesId: map.items[value.SeriesId] ?? value.SeriesId,
        Members: value.Members.map((child) => map.items[child] ?? child),
        People: value.People.map((person) => ({ ...person, Id: map.items[person.Id] ?? person.Id })),
        ...(value.PhysicalFolders
          ? { PhysicalFolders: value.PhysicalFolders.map((child) => map.items[child] ?? child) }
          : {}),
      };
      if (initialize && map.items[id] && [itemTypes[1], itemTypes[2]].includes(value.type) && target.has(k))
        record = target.get(k);
    } else if (kind === 'user') {
      if (initialize && map.users[id] && target.has(k)) record = { ...value, Username: target.get(k).Username };
    }
    if (mapped.has(k)) throw new Error('Mapped identities collide: ' + k);
    mapped.set(k, record);
  }
  return mapped;
}
