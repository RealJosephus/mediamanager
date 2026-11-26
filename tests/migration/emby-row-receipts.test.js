import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { exchange } from '../../src/migration/emby/exchange.js';
import { fromBlob, toBlob } from '../../src/migration/emby/format.js';
import { exchangeFixture, exchangeId, stoppedEmby, withCatalog } from './emby-exchange-fixture.js';

const insertMovie = (db, id, name) =>
  db.prepare('INSERT INTO MediaItems(Id,guid,type,Name) VALUES(?,?,5,?)').run(id, toBlob(exchangeId(id)), name);
const embyMovies = root => withCatalog(root, 'emby', db =>
  db.prepare('SELECT Id,guid,Name FROM MediaItems ORDER BY Id').all().map(row => [row.Id, fromBlob(row.guid), row.Name]));
const jellyfinMovies = root => withCatalog(root, 'jellyfin', db =>
  db.prepare('SELECT Id,Name FROM BaseItems ORDER BY Id').all().map(row => [row.Id, row.Name]));

async function setup(t) {
  const fixture = await exchangeFixture(t);
  insertMovie(fixture.emby, 1, 'First');
  insertMovie(fixture.emby, 2, 'Second');
  const original = await stoppedEmby(fixture);
  const step = (direction, source, name, template, options) =>
    exchange({ direction, source, output: path.join(fixture.directory, name), template, ...options });
  const items = Object.fromEntries([1, 2, 3].map(id => [exchangeId(id), exchangeId(100 + id)]));
  const first = await step('import', original, 'initial', undefined, { identityMap: { items } });
  return { original, manager: first.output, step };
}

test('target-only movie additions and deletions return once under their mapped native IDs', async t => {
  const { original, manager, step } = await setup(t);
  withCatalog(original, 'emby', db => {
    db.exec('DELETE FROM MediaItems WHERE Id=1');
    insertMovie(db, 3, 'Third');
  });
  const outbound = await step('export', manager, 'outbound', original);
  assert.equal(outbound.changes, 0);
  const inbound = await step('import', outbound.output, 'inbound');
  assert.deepEqual(jellyfinMovies(inbound.output), [[exchangeId(102), 'Second'], [exchangeId(103), 'Third']]);
  assert.equal(inbound.changes, 2);
  const repeated = await step('export', inbound.output, 'repeated');
  assert.deepEqual(embyMovies(repeated.output), [[2, exchangeId(2), 'Second'], [3, exchangeId(3), 'Third']]);
  const replay = await step('import', repeated.output, 'replay');
  assert.deepEqual([repeated.changes, replay.changes], [0, 0]);
  assert.deepEqual([outbound, inbound, repeated, replay].map(result => result.conflicts), [0, 0, 0, 0]);
});

test('editing a movie deleted by the other endpoint keeps both versions and reports the conflict on each return', async t => {
  const { original, manager, step } = await setup(t);
  withCatalog(original, 'emby', db => db.exec("DELETE FROM MediaItems WHERE Id=1; UPDATE MediaItems SET Name='Emby edit' WHERE Id=2"));
  withCatalog(manager, 'jellyfin', db => {
    db.prepare('DELETE FROM BaseItems WHERE Id=?').run(exchangeId(102));
    db.prepare("UPDATE BaseItems SET Name='manager edit' WHERE Id=?").run(exchangeId(101));
  });
  const outbound = await step('export', manager, 'outbound', original);
  const inbound = await step('import', outbound.output, 'inbound');
  assert.deepEqual(embyMovies(outbound.output), [[2, exchangeId(2), 'Emby edit']]);
  assert.deepEqual(jellyfinMovies(inbound.output), [[exchangeId(101), 'manager edit']]);
  assert.deepEqual([outbound.conflicts, inbound.conflicts], [2, 2]);
  withCatalog(inbound.output, 'jellyfin', db => db.exec('DELETE FROM BaseItems'));
  const resolved = await step('export', inbound.output, 'resolved');
  assert.equal(resolved.conflicts, 1);
  assert.deepEqual(embyMovies(resolved.output), embyMovies(outbound.output));
});
