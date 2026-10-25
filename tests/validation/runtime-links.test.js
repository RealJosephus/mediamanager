import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeFile } from '../../tools/validation/inventory.js';

test('runtime identity binds contained framework links and rejects root and external links without relaxing ordinary inputs', async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'runtime-links-')));
  try {
    const root = path.join(temporary, 'runtime'), outside = path.join(temporary, 'outside');
    for (const name of ['versions/1', 'versions/2']) await mkdir(path.join(root, name), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'external'), 'outside the bound runtime');
    for (const name of ['1', '2']) await writeFile(path.join(root, 'versions', name, 'library'), 'same bytes');
    const link = path.join(root, 'Current');
    const target = name => process.platform === 'win32' ? path.join(root, 'versions', name) : `versions/${name}`;
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(target('1'), link, type);
    assert.equal((await describeFile(root)).available, false);
    const first = await describeFile(root, { containedLinks: root });
    assert.equal(first.available, true);
    const description = first.entries.find(entry => entry.name === 'Current');
    assert.equal(description.kind, 'runtime-link');
    assert.equal(description.resolvedTarget, 'versions/1');
    assert.equal(description.targetKind, 'directory');
    await unlink(link);
    await symlink(target('2'), link, type);
    const redirected = await describeFile(root, { containedLinks: root });
    assert.equal(redirected.available, true);
    assert.notEqual(redirected.entriesSha256, first.entriesSha256, 'Link identity matters even when target bytes are identical.');
    await writeFile(path.join(root, 'versions/2/library'), 'changed bytes');
    assert.notEqual((await describeFile(root, { containedLinks: root })).entriesSha256, redirected.entriesSha256);
    const alias = path.join(temporary, 'runtime-alias');
    await symlink(root, alias, type);
    assert.equal((await describeFile(alias, { containedLinks: alias })).available, false);
    await symlink(outside, path.join(root, 'external'), type);
    const escaped = await describeFile(root, { containedLinks: root });
    assert.equal(escaped.available, false);
    assert.equal(escaped.entries.find(entry => entry.name === 'external').kind, 'symbolic-link');
    assert.equal((await describeFile(root)).available, false);
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('runtime-links-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
