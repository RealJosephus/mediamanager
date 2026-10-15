import assert from 'node:assert/strict';
import { tableDefinition } from '../../../../src/database/model.js';
import { nativeGuid, wireGuid } from '../../../../src/users/native.js';
import { parsePasswordHash, verifyPasswordHash } from '../../../../src/core/password.js';
import { parseLosslessJson } from '../../../../src/core/json.js';

const wire = value => parseLosslessJson(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry));
const withoutTrace = value => Array.isArray(value) ? value.map(withoutTrace) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, withoutTrace(entry)])) : value;
export const startupTables = ['Users', 'Permissions', 'Preferences', 'AccessSchedules', 'ImageInfos'];

export async function projectStartupObservation(row, sample) {
  const originalIds = new Set(row.before.tables.Users.map(user => nativeGuid(user.Id)));
  const generated = new Map(), knownPasswords = new Set((sample.users ?? []).map(user => user.password).filter(value => value != null));
  for (const step of sample.steps ?? [sample]) {
    let body; try { body = JSON.parse(step.body); } catch { continue; }
    if (body?.Password != null && ['string', 'number', 'boolean'].includes(typeof body.Password)) knownPasswords.add(String(body.Password));
  }
  for (const state of [row.before, ...row.observations.map(observation => observation.state)]) for (const user of state.tables.Users) {
    const id = nativeGuid(user.Id);
    if (!originalIds.has(id) && !generated.has(id)) generated.set(id, '$created-user-' + (generated.size + 1));
  }
  const id = value => generated.get(nativeGuid(value)) ?? wireGuid(value);
  const hashes = new Map();
  async function password(value) {
    if (value == null || value === '') return value;
    if (!hashes.has(value)) hashes.set(value, (async () => {
      const parsed = parsePasswordHash(value), matches = [];
      for (const candidate of knownPasswords) if (await verifyPasswordHash(parsed, candidate)) matches.push(candidate);
      assert.ok(matches.length, 'Every persisted hash authenticates an actual supplied password.');
      return { passwords: matches.sort() };
    })());
    return hashes.get(value);
  }
  async function snapshot(state) {
    const tables = {};
    for (const [table, rows] of Object.entries(state.tables)) tables[table] = await Promise.all(rows.map(async row => {
      const result = {};
      for (const column of tableDefinition(table).columns) {
        let value = row[column.name];
        if (value != null && column.clrType.replace('?', '') === 'Guid') value = id(value);
        if (column.clrType === 'bool') { assert.ok([true, false, 0, 1].includes(value)); value = value === true || value === 1; }
        if (table === 'Users' && column.name === 'Password') value = await password(value);
        result[column.name] = value;
      }
      return result;
    }));
    return wire({ tables, live: state.live, networkLive: state.networkLive });
  }
  const observations = [];
  for (const observation of row.observations) observations.push({ status: observation.status, contentType: observation.contentType,
    allow: observation.allow.split(',').map(value => value.trim()).filter(Boolean).sort(),
    body: observation.json == null ? observation.body : withoutTrace(observation.json), state: await snapshot(observation.state) });
  return { name: row.name, before: await snapshot(row.before), observations, after: await snapshot(row.after),
    events: row.events.map(event => ({ ...event, userId: id(event.userId) })) };
}
