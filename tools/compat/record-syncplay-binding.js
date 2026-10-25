import { spawnSync } from 'node:child_process';
import { validationExecutable } from '../validation/paths.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const [oracle, assemblies, output] = process.argv.slice(2);
if (!oracle || !assemblies || !output) throw new Error('Usage: record-syncplay-binding ORACLE ASSEMBLIES NEW_OUTPUT');
const cases = [];
const dates = ['0001-01-01', '9999-12-31T23:59:59.9999999Z', '0000-01-01', '2024-02-29', '2023-02-29', '2024-02-30',
  '2026-09-27T12:34', '2026-09-27T12:34Z', '2026-09-27T12:34:56', '2026-09-27T12:34:56Z',
  '2026-09-27T12:34:56.0000001Z', '2026-09-27T12:34:56.1234567890123456Z', '2026-09-27T12:34:56.12345678901234567Z',
  '2026-09-27T12:34:56.Z', '2026-09-27T12:34:56z', '2026-09-27t12:34:56Z', '2026-09-27 12:34:56', '2026-09-27T24:00:00Z',
  '2026-09-27T12:34:60Z', '2026-09-27T12:34:56+14:00', '2026-09-27T12:34:56-14:00', '2026-09-27T12:34:56+14:01',
  '2026-09-27T12:34:56+08:00', '2026-09-27T12:34:56+00:00', '2026-09-27T12:34:56-07:00', '2026-09-27T12:34:56+0800',
  '2026-09-27T12:34:56+08', '2026-09-27T12:34:56+00:60', '0001-01-01T00:00:00+14:00', '9999-12-31T23:59:59-14:00',
  '0001-01-01T00:00:00+08:00', '1900-01-01T00:00:00+08:00', '1990-06-01T00:00:00+08:00', '2026-09-27T12:34:56.123+08:00'];
for (const date of dates) cases.push({ kind: 'date', source: JSON.stringify(date) });
for (const date of ['2026-09-27Z', '2026-09-27T12:34:56.', '2026-09-27T12:34.1', '2026-09-27T12:34+08', '2026-09-27T12:34-14:00', '2026-09-27T12:34:56.+08',
  '0001-01-01T00:00:00-14:00', '9999-12-31T23:59:59+14:00', '9999-12-31T23:59:59+00:00', '0001-01-01T00:00:00+00:00',
  '9999-12-31T23:59:59.1234567-00:00', '2026-09-27T12:34:56.1234567890123456+08', '2026-09-27T12:34:56.00000000000000000']) cases.push({ kind: 'date', source: JSON.stringify(date) });
for (const source of ['null', 'true', '1', '{}', '[]', '""']) cases.push({ kind: 'date', source });
for (const name of ['NewGroup', 'JoinGroup', 'Play', 'SetPlaylistItem', 'RemoveFromPlaylist', 'MovePlaylistItem', 'Queue', 'Seek', 'Buffer', 'Ready', 'IgnoreWait', 'NextItem', 'PreviousItem', 'SetRepeatMode', 'SetShuffleMode', 'Ping']) {
  for (const source of ['{}', '[]', 'null']) cases.push({ kind: 'dto', name: `${name}RequestDto`, source });
}
for (const [name, body] of [
  ['NewGroup', { GroupName: 12.5 }], ['NewGroup', { GroupName: false }], ['NewGroup', { GroupName: null }],
  ['JoinGroup', { GroupId: null }], ['JoinGroup', { GroupId: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}' }],
  ['Play', { PlayingQueue: [null, '22222222222222222222222222222222'], PlayingItemPosition: '-1', StartPositionTicks: '9223372036854775807' }],
  ['Queue', { ItemIds: [], Mode: 'Queue, QueueNext' }], ['SetRepeatMode', { Mode: 99 }], ['SetShuffleMode', { Mode: 'sorted' }],
  ['IgnoreWait', { IgnoreWait: 'true' }], ['MovePlaylistItem', { NewIndex: 2147483648 }], ['Seek', { PositionTicks: ' 12 ' }],
  ['Ready', { When: '2026-09-27T12:34:56.1234567+08:00', PositionTicks: '9007199254740993' }]
]) cases.push({ kind: 'dto', name: `${name}RequestDto`, source: JSON.stringify(body) });
const result = spawnSync(validationExecutable('dotnet'), [path.resolve(oracle), path.resolve(assemblies)], { input: cases.map(input => JSON.stringify(input)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 10_000_000 });
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
await writeFile(`${output}.jsonl`, result.stdout, { flag: 'wx' });
const lines = result.stdout.trim().split(/\r?\n/).map(line => parseLosslessJson(line));
if (lines.length !== cases.length) throw new Error('Oracle returned an incomplete result.');
await writeFile(output, stringifyNativeJson(cases.map((input, index) => ({ input, result: lines[index] }))), { flag: 'wx' });
console.log(JSON.stringify({ cases: cases.length, dates: cases.filter(entry => entry.kind === 'date').length, dto: cases.filter(entry => entry.kind === 'dto').length }));
