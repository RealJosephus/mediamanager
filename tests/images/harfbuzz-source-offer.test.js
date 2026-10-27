import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('../../src/images/system-fonts/harfbuzz/', import.meta.url);

async function assertMaterial(record) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(new URL(record.path, root))) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  assert.equal(bytes, record.bytes, record.path + ': complete source material');
  assert.equal(hash.digest('hex'), record.sha256, record.path + ': recorded content');
}

test('HarfBuzz source materials retain the existing build inputs, patch and licenses without replacing the runtime', async () => {
  const offer = JSON.parse(await readFile(new URL('source-offer.json', root), 'utf8'));
  await assertMaterial(offer.buildRecord);
  const build = JSON.parse(await readFile(new URL(offer.buildRecord.path, root), 'utf8'));
  assert.deepEqual(offer.archives.map(record => ({ ...record, path: path.posix.basename(record.path) })), build.sources);
  assert.equal(offer.patch.operation, build.patch.operation);
  assert.equal(offer.patch.beforeSha256, build.patch.beforeSha256);
  assert.deepEqual({ ...offer.patch.after, path: 'Makefile' }, build.patch.after);
  for (const record of [...offer.archives, offer.patch.after, ...offer.licenses, ...build.runtime]) {
    await assertMaterial(record);
  }
  assert.equal(offer.originalBuild.commit, build.commit);
  assert.equal(offer.originalBuild.runId, build.runId);
  assert.equal(offer.originalBuild.runAttempt, build.runAttempt);
});
