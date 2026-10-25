import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { captureCurrentNative, originalRoot as root, input, recordCandidate } from './fixtures/deflate64-current/capture.js';

let native;
before(async () => { ({ native } = await captureCurrentNative()); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Deflate64 current native reads bind original upstream bytes, MIT license and every independently encoded plaintext', async () => {
  assert.equal(native.actualExecution, true);
  assert.equal(native.archives.length, 9);
  assert.equal(native.archives.flatMap(sample => sample.entries).length, 30);
  const gitAsset = await fs.readFile(new URL('assets/Zip.deflate64.zip', root));
  assert.equal(createHash('sha1').update(Buffer.from('blob ' + gitAsset.length + '\0')).update(gitAsset).digest('hex'), input.upstreamGitBlobSha1);
  const license = await fs.readFile(new URL('LICENSE-SharpCompress.txt', root));
  assert.equal(createHash('sha1').update(Buffer.from('blob ' + license.length + '\0')).update(license).digest('hex'), input.licenseGitBlobSha1);
  const generated = JSON.parse(await fs.readFile(new URL('generated-inputs.json', root)));
  const actual = native.archives.find(sample => sample.name === 'generated-boundaries.zip').entries;
  assert.equal(generated.entries.length, 17);
  assert.equal(actual.length, generated.entries.length);
  for (const expected of generated.entries) {
    const observed = actual.find(entry => entry.name === expected.name);
    assert.ok(observed, expected.name);
    assert.equal(observed.openError, null); assert.equal(observed.readError, null);
    assert.equal(observed.actualLength, expected.generatedLength); assert.equal(observed.sha256, expected.generatedSha256);
  }
});

async function setup(t) {
  const output = validationOutputRoot(); await fs.mkdir(output, { recursive: true });
  const directory = assertValidationOutputChild(await fs.mkdtemp(path.join(output, 'deflate64-archives-')));
  const spoolPath = path.join(directory, 'spool'), identityMap = new IdentityAccessMap();
  identityMap.bind('deflate64-book', '/original-book');
  let archivePath, opens = 0, closes = 0;
  const vfs = { async openRead(access, { signal } = {}) {
    assert.equal(access, '/original-book'); opens++;
    const stream = createReadStream(archivePath, { signal, highWaterMark: 32768 }); let closed = false;
    return { stream, async close() { if (!closed) { closed = true; closes++; stream.destroy(); } } };
  } };
  const service = new BookArchiveService({ vfs, identityMap, spoolPath });
  t.after(async () => {
    try { await service.close(); assert.equal(opens, closes); assert.deepEqual(await fs.readdir(spoolPath), []); }
    finally { assertValidationOutputChild(directory); await fs.rm(directory, { recursive: true }); }
  });
  return { async open(filename, options) {
    archivePath = fileURLToPath(new URL('assets/' + filename, root));
    return service.openArchive({ Id: 'deflate64-book', Path: 'Z:\\OriginalBook\\different-host-path.epub' }, options);
  }, spoolPath };
}

test('real BookArchiveService matches native ZIP-only selected bytes, Deflate64 history and compression admission', async t => {
  const fixture = await setup(t);
  for (const sample of native.archives) {
    const filename = sample.name;
    await t.test(filename, async t => {
      assert.equal(sample.archiveOpened, true); assert.equal(sample.archiveError, null);
      const archive = await fixture.open(filename, { zipOnly: true });
      const observations = [];
      try {
        assert.deepEqual(archive.entries.map(entry => ({ name: entry.key, size: entry.size })), sample.entries.map(entry => ({ name: entry.name, size: entry.Length })));
        for (const [index, expected] of sample.entries.entries()) {
          await t.test(expected.name, async () => {
            const entry = archive.entries[index]; assert.equal(archive.findEntry(expected.name), entry);
            if (expected.openError) {
              assert.equal(expected.opened, false); assert.equal(expected.readError, null);
              await assert.rejects(archive.read(entry), error => error.code === 'invalid-archive' && /compression method.*unsupported|unsupported compression method/iu.test(error.message));
              observations.push({ name: entry.key, size: entry.size, failed: true });
            } else {
              assert.equal(expected.opened, true); assert.equal(expected.readError, null);
              const bytes = await archive.read(entry);
              assert.equal(bytes.length, expected.actualLength); assert.equal(hash(bytes), expected.sha256);
              observations.push({ name: entry.key, size: entry.size, failed: false, bytes: bytes.length, sha256: hash(bytes) });
            }
          });
        }
      } finally { await archive.close(); }
      assert.deepEqual(await fs.readdir(fixture.spoolPath), []);
      await recordCandidate(filename, { entries: observations, spool: await fs.readdir(fixture.spoolPath) });
    });
  }
});
