import test from 'node:test';
import assert from 'node:assert/strict';
import { compareObservations } from '../../src/compat/differential.js';

test('differential detects intentional response, state, event and asset mutations', () => {
  const reference = { status: 200, headers: { 'content-language': 'zh-CN' }, body: { Id: 'a', Ticks: 9007199254740993n },
    database: [{ id: 'a', favorite: true }], assets: { 'a.nfo': Buffer.from('original') }, events: ['changed'] };
  assert.equal(compareObservations(reference, reference).equal, true);
  for (const field of ['status', 'headers', 'body', 'database', 'assets', 'events']) {
    const candidate = structuredClone(reference);
    candidate[field] = null;
    assert.equal(compareObservations(reference, candidate).equal, false, field);
  }
  const candidate = structuredClone(reference);
  candidate.body.Ticks = 9007199254740992n;
  assert.deepEqual(compareObservations(reference, candidate).differences[0].path, ['body', 'Ticks']);
});

test('normalization is explicit and rejects missing fields', () => {
  const rule = { path: ['time'], reason: 'Controlled clock offset', normalize: value => value % 1000 };
  assert.equal(compareObservations({time: 1001}, {time: 2001}, {rules: [rule]}).equal, true);
  assert.throws(() => compareObservations({}, {}, {rules: [rule]}), /Missing/);
});
