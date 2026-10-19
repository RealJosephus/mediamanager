import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { consumerFixture } from './fixture.js';
import { observeComparison } from '../comparison-observations.js';

const fixture = await consumerFixture('date-roundtrip');
const response = ({ rawText, ...value }) => value;
for (const kind of ['taipei', 'shanghai-candidate']) test(`actual current reference HTTP/PG/SQLite/native continuing writes/reimport: ${kind}`, t => {
  const report = fixture[kind];
  assert.equal(report.platform, 'win32'); assert.equal(report.phaseAcceptance, false);
  assert.equal(report.referenceTimezone, 'Taipei Standard Time');
  assert.equal(report.historicalShanghaiHttpVerified, false); assert.equal(report.linuxVerified, false);
  assert.equal(report.nativeReference.length, 2); assert.equal(report.candidate.length, 2);
  assert.equal(report.takeovers.length, 2);
  assert.deepEqual(report.cleanup, { postgresSchemas: [], nativeStopped: true });
  assert.equal(report.processes.length, 3);
  assert.ok(report.processes.every(process => process.stopped && process.exitCode === 0 && process.signalCode === null));
  const realDifferences = [];
  for (const [index, reference] of report.nativeReference.entries()) {
    const candidate = report.candidate[index], takeover = report.takeovers[index];
    assert.equal(candidate.name, reference.name); assert.equal(takeover.name, reference.name);
    for (const field of ['response', 'state']) {
      assert.equal(candidate[field].status, 200); assert.equal(reference[field].status, 200);
      if (!isDeepStrictEqual(response(candidate[field]), response(reference[field])))
        realDifferences.push({ name: reference.name, field, expected: reference[field], actual: candidate[field] });
    }
    assert.deepEqual(candidate.postgres, candidate.sqlite);
    assert.deepEqual(takeover.observations.before.body, candidate.state.body);
    assert.equal(takeover.observations.response.status, 200);
    assert.equal(takeover.observations.after.body.PlayCount, 42);
    assert.equal(takeover.observations.after.body.IsFavorite, true);
    assert.deepEqual(takeover.postgresRows, takeover.nativeRows);
    const row = candidate.postgres.find(row => row.UserId.replaceAll('-', '').toLowerCase() === '5c6b5f77bea94a9a98aafae5909892b7');
    assert.ok(row);
    const after = takeover.postgresRows.find(value => value.UserId === row.UserId && value.ItemId === row.ItemId && value.CustomDataKey === row.CustomDataKey);
    assert.ok(after); assert.equal(after.PlayCount, 42);
    assert.equal(row.LastPlayedDate.replace(' ', 'T') + '.0000000Z', candidate.state.body.LastPlayedDate);
    assert.equal(after.LastPlayedDate.replace(' ', 'T') + '.0000000Z', takeover.observations.after.body.LastPlayedDate);
  }
  assert.deepEqual(realDifferences, report.differences);
  assert.equal(report.compatible, realDifferences.length === 0, 'known-difference regression must retain compatible:false');
  if (kind === 'taipei') assert.deepEqual(realDifferences, []);
  else {
    assert.deepEqual(realDifferences.map(entry => [entry.name, entry.field]), [['date-296', 'response'], ['date-296', 'state']]);
    for (const entry of realDifferences) {
      const expectedCopy = structuredClone(entry.expected);
      assert.equal(expectedCopy.body.LastPlayedDate, '1900-01-01T04:00:00.0000000Z');
      assert.equal(entry.actual.body.LastPlayedDate, '1900-01-01T03:54:17.0000000Z');
      expectedCopy.body.LastPlayedDate = entry.actual.body.LastPlayedDate;
      assert.deepEqual(response(entry.actual), response(expectedCopy));
      observeComparison(t, entry.name + ' real persisted date gap', entry.actual, entry.expected);
    }
  }
  const script = `import { bindUserDataBody } from './src/http/user-data-binding.js';
    const cases = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(cases.map(sample => bindUserDataBody({ LastPlayedDate: sample.input }, JSON.stringify({ LastPlayedDate: sample.input })).LastPlayedDate)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(report.candidate.map(({ input }) => ({ input })))],
    { env: { ...process.env, TZ: report.nodeTimezone }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), report.candidate.map(sample => sample.state.body.LastPlayedDate));
});

test('platform observations retain the Linux and same-zone Shanghai limitations without changing Windows timezone', () => {
  assert.equal(fixture.platform.timezoneChanged, false);
  assert.equal(fixture.platform.timezone.status, 0);
  assert.equal(fixture.platform.timezone.stdout.trim(), 'Taipei Standard Time');
  assert.equal(fixture.platform.linuxVerified, false);
});
