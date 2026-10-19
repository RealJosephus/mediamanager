import assert from 'node:assert/strict';

const uuid = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/u;
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
    assert.match(key.AccessToken, uuid, 'An API key comes from a version-four UUID.');
    const id = generated.size, date = dateIdentity(key.DateCreated);
    const time = Date.parse(date + 'Z');
    assert.ok(time >= Date.parse(observation.started) && time <= Date.parse(observation.completed), 'Creation time belongs to the successful request.');
    generated.set(key.AccessToken, { date, id });
    tokens.set(key.AccessToken, '$key-' + id); tokens.set(key.AccessToken.toUpperCase(), '$key-' + id + '-uppercase');
  }
  const state = rows => normalizeKeyRows(rows).map(row => {
    const current = generated.get(row.AccessToken);
    if (!current) return row;
    assert.equal(dateIdentity(row.DateCreated), current.date, 'The creation date stays bound to its key.');
    return { ...row, AccessToken: tokens.get(row.AccessToken), DateCreated: '$date-' + current.id };
  });
  const project = value => {
    if (typeof value === 'string') {
      if (tokens.has(value)) return tokens.get(value);
      return value;
    }
    if (Array.isArray(value)) return value.map(project);
    if (value && typeof value === 'object') {
      const generatedKey = generated.get(value.AccessToken ?? value.accessToken);
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => {
        if (generatedKey && ['DateCreated', 'dateCreated'].includes(key)) {
          assert.equal(dateIdentity(entry), generatedKey.date, 'The DTO creation date comes from its persisted key.');
          return [key, '$date-' + generatedKey.id];
        }
        return [key, project(entry)];
      }));
    }
    return value;
  };
  return { name: record.name, before: state(record.before), after: state(record.after), calls: project(record.calls),
    observations: record.observations.map(observation => ({ status: observation.status, contentType: observation.contentType,
      allow: observation.allow.split(',').map(value => value.trim()).filter(Boolean).sort(),
      ...(observation.json == null ? { body: observation.body } : { json: project(observation.json) }), state: state(observation.state) })) };
}
