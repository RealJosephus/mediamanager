import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { exchange } from '../../src/migration/emby/exchange.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { inventory, mergeAssets } from '../../src/migration/emby/files.js';
import { exchangeFixture, exchangeId, stoppedEmby } from './emby-exchange-fixture.js';

const poster = (root, type) => path.join(root, type === 'emby' ? '' : 'data', 'metadata', 'poster.jpg');
const attachments = (root, type) => path.join(root, type === 'emby' ? '' : 'data', 'root', 'default', 'Movies');

async function setup(t) {
  const fixture = await exchangeFixture(t);
  fixture.emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name) VALUES(1,?,5,'First Movie')").run(toBlob(exchangeId(1)));
  const original = await stoppedEmby(fixture);
  const art = poster(original, 'emby'), library = attachments(original, 'emby');
  await mkdir(path.dirname(art), { recursive: true });
  await writeFile(art, 'original artwork');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'before.mblink'), 'old attachment');
  const step = (direction, source, name, template) => exchange({ direction, source, output: path.join(fixture.directory, name), template });
  const first = await step('import', original, 'initial');
  return { original, manager: first.output, step };
}

test('posters and library attachments return from either template and survive another round trip', async t => {
  const { original, manager, step } = await setup(t);
  await writeFile(poster(original, 'emby'), 'Emby artwork');
  const library = attachments(original, 'emby');
  await rm(path.join(library, 'before.mblink'));
  await writeFile(path.join(library, 'after.mblink'), 'new attachment');
  const outbound = await step('export', manager, 'outbound', original);
  const inbound = await step('import', outbound.output, 'inbound');
  assert.equal(await readFile(poster(inbound.output, 'jellyfin'), 'utf8'), 'Emby artwork');
  assert.deepEqual(await readdir(attachments(inbound.output, 'jellyfin')), ['after.mblink']);
  const synced = await step('export', inbound.output, 'synced');
  await writeFile(poster(inbound.output, 'jellyfin'), 'manager artwork');
  const editedTemplate = await step('import', synced.output, 'edited-template', inbound.output);
  const returning = await step('export', editedTemplate.output, 'returning');
  const repeated = await step('import', returning.output, 'repeat');
  for (const [result, type] of [[returning, 'emby'], [repeated, 'jellyfin']]) {
    assert.equal(await readFile(poster(result.output, type), 'utf8'), 'manager artwork');
    const files = attachments(result.output, type);
    assert.deepEqual(await readdir(files), ['after.mblink']);
    assert.equal(await readFile(path.join(files, 'after.mblink'), 'utf8'), 'new attachment');
  }
  assert.deepEqual([outbound, inbound, synced, editedTemplate, returning, repeated].map(result => result.conflicts), [0, 0, 0, 0, 0, 0]);
});

test('divergent artwork stays on each endpoint and is reported until its bytes agree', async t => {
  const { original, manager, step } = await setup(t);
  await writeFile(poster(original, 'emby'), 'Emby artwork');
  await writeFile(poster(manager, 'jellyfin'), 'manager artwork');
  const outbound = await step('export', manager, 'outbound', original);
  const inbound = await step('import', outbound.output, 'inbound');
  for (const [result, type, expected] of [[outbound, 'emby', 'Emby artwork'], [inbound, 'jellyfin', 'manager artwork']]) {
    assert.equal(await readFile(poster(result.output, type), 'utf8'), expected);
    const { issues } = JSON.parse(await readFile(result.report));
    assert.deepEqual(issues.filter(issue => issue.status === 'conflict').map(({ kind, id, field }) => [kind, id, field]),
      [['asset', 'poster.jpg', 'bytes']]);
  }
  await writeFile(poster(inbound.output, 'jellyfin'), 'Emby artwork');
  const resolved = await step('export', inbound.output, 'resolved');
  assert.equal(resolved.conflicts, 0);
  assert.equal((await step('import', resolved.output, 'repeat')).conflicts, 0);
});

test('file-only legacy receipts carry a target file-to-directory change including empty subdirectories', async t => {
  const { directory } = await exchangeFixture(t);
  const source = path.join(directory, 'source'), target = path.join(directory, 'target');
  await mkdir(source);
  await writeFile(path.join(source, 'member'), 'original');
  const report = (...issue) => assert.fail(JSON.stringify(issue));
  const first = await mergeAssets(source, target, undefined, undefined, report);
  await rm(path.join(target, 'member'));
  await mkdir(path.join(target, 'member', 'empty'), { recursive: true });
  await writeFile(path.join(target, 'member', 'attachment'), 'new');
  const held = await mergeAssets(source, target, first.source.members, first.target.members, report);
  assert.deepEqual(held.target.members, first.target.members);
  const applied = await mergeAssets(target, source, held.target, held.source, report);
  assert.deepEqual(await inventory(source), await inventory(target));
  assert.deepEqual(await mergeAssets(source, target, applied.target, applied.source, report),
    { source: applied.target, target: applied.source });
});

test('an older receipt that acknowledged divergent artwork preserves both copies until agreement', async t => {
  const { directory } = await exchangeFixture(t);
  const source = path.join(directory, 'source'), target = path.join(directory, 'target');
  for (const [root, value] of [[source, 'first'], [target, 'second']]) {
    await mkdir(root);
    await writeFile(path.join(root, 'poster'), value);
  }
  const a = await inventory(source), b = await inventory(target), conflicts = [];
  const report = (...issue) => conflicts.push(issue);
  const forward = await mergeAssets(source, target, a.members, b.members, report);
  const reverse = await mergeAssets(target, source, forward.target, forward.source, report);
  assert.deepEqual(conflicts.map(issue => issue.slice(0, 4)), Array(2).fill(['conflict', 'asset', 'poster', 'bytes']));
  assert.deepEqual(await inventory(source), a);
  assert.deepEqual(await inventory(target), b);
  await writeFile(path.join(source, 'poster'), 'second');
  const agreed = await mergeAssets(source, target, reverse.target, reverse.source, report);
  assert.deepEqual(agreed.source, agreed.target);
  assert.equal(conflicts.length, 2);
});

test('a pending attachment retains the recorded native options of a new template library', async t => {
  const { directory } = await exchangeFixture(t);
  const source = path.join(directory, 'source'), target = path.join(directory, 'target');
  await mkdir(source);
  await mkdir(path.join(target, 'Movies'), { recursive: true });
  await writeFile(path.join(target, 'Movies', 'options.xml'), '<LibraryOptions/>');
  await writeFile(path.join(target, 'Movies', 'new.mblink'), 'new');
  const native = await inventory(target);
  const options = { include: name => name !== 'Movies/options.xml' };
  const report = (...issue) => assert.fail(JSON.stringify(issue));
  const held = await mergeAssets(source, target, {}, {}, report, options);
  assert.deepEqual(held.target.directories, ['Movies']);
  assert.deepEqual(Object.entries(held.target.members), [['Movies/options.xml', native.members['Movies/options.xml']]]);
  await mergeAssets(target, source, held.target, held.source, report, options);
  assert.deepEqual(await readdir(path.join(source, 'Movies')), ['new.mblink']);
});
