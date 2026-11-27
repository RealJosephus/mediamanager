import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { exchange } from '../../src/migration/emby/exchange.js';
import { mergeAssets } from '../../src/migration/emby/files.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { exchangeFixture, exchangeId, stoppedEmby } from './emby-exchange-fixture.js';

test('Emby imports and returns metadata root, directory and file permissions and modification times', async t => {
  const f = await exchangeFixture(t);
  f.emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name) VALUES(1,?,5,'Movie')").run(toBlob(exchangeId(1)));
  const source = await stoppedEmby(f);
  const metadata = path.join(source, 'metadata'), directory = path.join(metadata, 'custom-posters');
  const stamp = new Date('2022-03-04T00:00:00Z');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'poster.txt'), 'cover');
  if (process.platform === 'linux') {
    await writeFile(path.join(directory, 'marked-cover'), 'alternate');
    await chmod(path.join(directory, 'marked-cover'), 0o1640);
    await writeFile(path.join(source, 'ordinary-instance-file'), 'instance');
    await chmod(path.join(source, 'ordinary-instance-file'), 0o4750);
  }
  const members = root => [root, path.join(root, 'custom-posters'), path.join(root, 'custom-posters', 'poster.txt')];
  async function setAttributes(root, modes, date) {
    for (const [index, name] of members(root).entries()) {
      await chmod(name, modes[index]);
      await utimes(name, date, date);
    }
  }
  async function attributes(root) {
    return Promise.all(members(root).map(async name => {
      const info = await stat(name, { bigint: true });
      return [Number(info.mode & 0o777n), info.mtimeNs / 1000n];
    }));
  }
  await setAttributes(metadata, [0o750, 0o750, 0o640], stamp);
  const result = await exchange({ direction: 'import', source, output: path.join(f.directory, 'manager') });
  const imported = path.join(result.output, 'data', 'metadata');
  assert.deepEqual(await attributes(imported), await attributes(metadata));
  const updated = new Date('2025-02-02T03:04:05.125Z');
  await setAttributes(imported, [0o700, 0o700, 0o600], updated);
  const returned = await exchange({ direction: 'export', source: result.output, output: path.join(f.directory, 'returned') });
  assert.equal(returned.conflicts, 0);
  const outbound = path.join(returned.output, 'metadata');
  assert.equal(await readFile(members(outbound)[2], 'utf8'), 'cover');
  assert.deepEqual(await attributes(outbound), await attributes(imported));
  if (process.platform !== 'win32') assert.deepEqual((await attributes(outbound)).map(([mode]) => mode), [0o700, 0o700, 0o600]);
  if (process.platform === 'linux') {
    assert.equal((await stat(path.join(outbound, 'custom-posters', 'marked-cover'))).mode & 0o7777, 0o1640);
    assert.equal((await stat(path.join(returned.output, 'ordinary-instance-file'))).mode & 0o7777, 0o750);
  }
});

test('independent metadata attributes merge and divergent times remain in conflict on the reverse trip', async t => {
  const { directory } = await exchangeFixture(t);
  const left = path.join(directory, 'left'), right = path.join(directory, 'right');
  const file = root => path.join(root, 'poster');
  await mkdir(left);
  await writeFile(file(left), 'poster');
  await chmod(file(left), 0o640);
  const issues = [], report = (...issue) => issues.push(issue);
  const options = { attributes: true };
  const base = await mergeAssets(left, right, undefined, undefined, report, options);
  await chmod(file(left), 0o600);
  const first = new Date('2024-01-02T00:00:00Z');
  await writeFile(file(right), 'updated poster');
  await utimes(file(right), first, first);
  const forward = await mergeAssets(left, right, base.source, base.target, report, options);
  assert.equal(await readFile(file(right), 'utf8'), 'updated poster');
  assert.equal((await stat(file(right))).mode & 0o777, (await stat(file(left))).mode & 0o777);
  assert.equal((await stat(file(right))).mtimeMs, first.getTime());
  const reverse = await mergeAssets(right, left, forward.target, forward.source, report, options);
  assert.equal(await readFile(file(left), 'utf8'), 'updated poster');
  assert.equal((await stat(file(left))).mtimeMs, first.getTime());
  assert.equal((await stat(file(right))).mode & 0o777, (await stat(file(left))).mode & 0o777);
  assert.deepEqual(issues, []);
  const second = new Date('2025-02-01T00:00:00Z'), third = new Date('2025-03-01T00:00:00Z');
  await utimes(file(left), second, second);
  await utimes(file(right), third, third);
  const held = await mergeAssets(left, right, reverse.target, reverse.source, report, options);
  await mergeAssets(right, left, held.target, held.source, report, options);
  assert.deepEqual(issues.map(issue => issue.slice(0, 4)), Array(2).fill(['conflict', 'asset', 'poster', 'mtimeUs']));
  assert.equal((await stat(file(left))).mtimeMs, second.getTime());
  assert.equal((await stat(file(right))).mtimeMs, third.getTime());
});

test('digest-only metadata receipts retain differing timestamps until both endpoints agree', async t => {
  const { directory } = await exchangeFixture(t);
  const left = path.join(directory, 'left'), right = path.join(directory, 'right');
  await mkdir(left);
  await writeFile(path.join(left, 'poster'), 'cover');
  const issues = [], report = (...issue) => issues.push(issue);
  const options = { attributes: true };
  const base = await mergeAssets(left, right, undefined, undefined, report, options);
  const older = new Date('2023-04-01T00:00:00Z'), newer = new Date('2024-04-01T00:00:00Z');
  await utimes(path.join(left, 'poster'), older, older);
  await utimes(path.join(right, 'poster'), newer, newer);
  const first = await mergeAssets(left, right, base.source.members, base.target.members, report, options);
  const saved = JSON.parse(JSON.stringify(first));
  const second = await mergeAssets(right, left, saved.target, saved.source, report, options);
  assert.deepEqual(issues.map(issue => issue.slice(0, 4)), Array(2).fill(['conflict', 'asset', 'poster', 'mtimeUs']));
  assert.equal((await stat(path.join(left, 'poster'))).mtimeMs, older.getTime());
  assert.equal((await stat(path.join(right, 'poster'))).mtimeMs, newer.getTime());
  await utimes(path.join(left, 'poster'), newer, newer);
  issues.length = 0;
  const agreed = await mergeAssets(left, right, second.target, second.source, report, options);
  assert.deepEqual(issues, []);
  assert.deepEqual(agreed.source.attributes.poster, agreed.target.attributes.poster);
});
