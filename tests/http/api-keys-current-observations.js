import assert from 'node:assert/strict';
import { MIMEType } from 'node:util';
import { dateTicks } from '../../src/library/records.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

const tokenFormat = /^[0-9a-f]{32}$/u;
const dateIdentity = value => {
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z?$/u.exec(value);
  assert.ok(match, 'A generated key date retains the native UTC format.');
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(7, '0')}`;
};

export function normalizeKeyRows(rows) {
  return rows.map(row => ({ Id: Number(row.Id), DateCreated: row.DateCreated, DateLastActivity: row.DateLastActivity,
    Name: row.Name, AccessToken: row.AccessToken }));
}

export function projectKeyObservation(record) {
  const seeds = new Set(record.before.map(row => row.AccessToken)), tokens = new Map();
  const generated = new Map();
  for (const observation of record.observations) for (const key of observation.state) {
    if (seeds.has(key.AccessToken) || generated.has(key.AccessToken)) continue;
    assert.match(key.AccessToken, tokenFormat, 'A generated API key has the public token format.');
    const id = generated.size, date = dateIdentity(key.DateCreated);
    const time = dateTicks(date + 'Z');
    assert.ok(time >= dateTicks(observation.started) && time <= dateTicks(observation.completed), 'Creation time belongs to the successful request.');
    generated.set(key.AccessToken, { date, id });
    tokens.set(key.AccessToken, '$key-' + id); tokens.set(key.AccessToken.toUpperCase(), '$key-' + id + '-uppercase');
  }
  const state = rows => normalizeKeyRows(rows).map(row => {
    const current = generated.get(row.AccessToken);
    if (!current) return row;
    assert.equal(dateIdentity(row.DateCreated), current.date, 'The creation date stays bound to its key.');
    return { ...row, AccessToken: tokens.get(row.AccessToken), DateCreated: '$date-' + current.id };
  });
  const project = observation => {
    const value = projectProblemTrace(observation.json, observation.status);
    if (observation.status !== 200 || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    const camel = new MIMEType(observation.contentType).params.get('profile') === 'CamelCase',
      items = camel ? 'items' : 'Items', accessToken = camel ? 'accessToken' : 'AccessToken', dateCreated = camel ? 'dateCreated' : 'DateCreated';
    if (!Array.isArray(value[items])) return value;
    return { ...value, [items]: value[items].map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const token = entry[accessToken], generatedKey = generated.get(token), projected = { ...entry };
      if (tokens.has(token)) projected[accessToken] = tokens.get(token);
      if (generatedKey && Object.hasOwn(entry, dateCreated)) {
        assert.equal(dateIdentity(entry[dateCreated]), generatedKey.date, 'The DTO creation date comes from its persisted key.');
        projected[dateCreated] = '$date-' + generatedKey.id;
      }
      return projected;
    }) };
  };
  return { name: record.name, before: state(record.before), after: state(record.after),
    observations: record.observations.map(observation => ({ status: observation.status, contentType: observation.contentType,
      allow: observation.allow.split(',').map(value => value.trim()).filter(Boolean).sort(),
      ...(observation.json == null ? { body: observation.body } : { json: project(observation) }), state: state(observation.state) })) };
}
