import assert from 'node:assert/strict';
import path from 'node:path';
import { parsePasswordHash, verifyPasswordHash } from '../../../../src/core/password.js';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { tableDefinition } from '../../../../src/database/model.js';

const wire = value => parseLosslessJson(JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value));
const pinPattern = /^[0-9A-F]{2}(?:-[0-9A-F]{2}){3}$/u;
const withoutTrace = value => Array.isArray(value) ? value.map(withoutTrace) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, value]) => [key, withoutTrace(value)])) : value;

export function allowedMethods(value) {
  assert.equal(typeof value, 'string');
  if (value === '') return [];
  const methods = value.split(',').map(method => method.replace(/^[\t ]+|[\t ]+$/gu, ''));
  for (const method of methods) assert.match(method, /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
  assert.equal(new Set(methods).size, methods.length);
  return methods.sort();
}

export function normalizeSnapshot(snapshot) {
  return wire(Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.map(row => {
    const value = { ...row };
    for (const column of tableDefinition(table).columns) if (column.clrType === 'bool') {
      assert.ok([true, false, 0, 1].includes(value[column.name])); value[column.name] = value[column.name] === true || value[column.name] === 1;
    }
    return value;
  })])));
}

export async function projectResetObservation(row) {
  const generated = new Map();
  // Interpret the observation's path syntax, including Windows recordings on Unix.
  const observedPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(row.ProgramData) ? path.win32 : path.posix;
  assert.ok(observedPath.isAbsolute(row.ProgramData), row.ProgramData);
  const root = observedPath.resolve(row.ProgramData);
  const rooted = filename => {
    assert.ok(observedPath.isAbsolute(filename), filename);
    assert.equal(observedPath.relative(root, observedPath.dirname(observedPath.resolve(filename))), '', filename);
    return '<instance>/' + observedPath.basename(filename);
  };
  const expiration = (text, observation) => {
    const value = Date.parse(text), start = Date.parse(observation.started), end = Date.parse(observation.finished);
    assert.ok(Number.isFinite(value) && value >= start + 1_800_000 - 1 && value <= end + 1_800_000 + 1, text);
    return '<expiration>';
  };
  for (const observation of row.observations) for (const file of observation.files) {
    if (file.directory) continue;
    let value; try { value = JSON.parse(file.text); } catch { continue; }
    if (value?.PinFile && value?.ExpirationDate && value?.Pin && Math.abs(Date.parse(value.ExpirationDate) - Date.parse(observation.started) - 1_800_000) < 60_000) {
      assert.match(value.Pin, pinPattern); assert.equal(observedPath.basename(value.PinFile), file.name);
      rooted(value.PinFile); expiration(value.ExpirationDate, observation); generated.set(value.Pin, true);
    }
  }
  const pin = value => generated.has(value) ? '<generated-pin>' : [...generated.keys()].some(original => original.replaceAll('-', '') === value)
    ? '<generated-pin-compact>' : value;
  const files = (values, observation) => values.map(file => {
    if (file.directory) return { ...file };
    const { bytesBase64, ...original } = file;
    let content; try { content = JSON.parse(file.text); } catch { return original; }
    if (generated.has(content?.Pin)) content = { ...content, Pin: pin(content.Pin), PinFile: rooted(content.PinFile), ExpirationDate: expiration(content.ExpirationDate, observation) };
    const { text, ...attributes } = original;
    return { ...attributes, content };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const before = normalizeSnapshot(row.before), after = normalizeSnapshot(row.after);
  for (const user of before.Users) {
    const hash = parsePasswordHash(user.Password);
    assert.equal(hash.id, 'PBKDF2-SHA512'); assert.equal(hash.parameters.get('iterations'), '210000');
    assert.equal(hash.salt.length, 16); assert.equal(hash.hash.length, 64);
    const current = after.Users.find(value => value.Id === user.Id);
    const checks = row.passwordChecks.find(value => value.id === user.Id.replaceAll('-', '').toLowerCase());
    assert.equal(checks.changed, current.Password !== user.Password);
    if (!checks.changed) { assert.equal(checks.initialMatches, true); current.Password = '<initial-hash>'; }
    else {
      const changed = parsePasswordHash(current.Password);
      assert.equal(changed.id, 'PBKDF2-SHA512'); assert.equal(changed.parameters.get('iterations'), '210000');
      assert.equal(changed.salt.length, 16); assert.equal(changed.hash.length, 64);
      assert.ok(checks.pinMatches.length > 0);
      for (const requested of checks.pinMatches) assert.equal(await verifyPasswordHash(changed, requested), true);
      current.Password = '<changed-hash>';
    }
    user.Password = '<initial-hash>';
  }
  return { name: row.name, before, after, calls: row.calls, events: row.events, catalogs: row.catalogs,
    passwordChecks: row.passwordChecks.map(checks => ({ ...checks, pinMatches: checks.pinMatches.map(pin) })),
    observations: row.observations.map(observation => {
      let body = observation.json;
      if (body?.Action === 'PinCode') body = { ...body, PinFile: rooted(body.PinFile), PinExpirationDate: expiration(body.PinExpirationDate, observation) };
      return { status: observation.status, contentType: observation.contentType, allow: allowedMethods(observation.allow),
        body: body === null ? observation.body : withoutTrace(body), files: files(observation.files, observation) };
    }) };
}
