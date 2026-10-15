import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

const provenanceUrl = new URL('./fixtures/deflate64-archives/provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const native = JSON.parse(await fs.readFile(new URL('native.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Deflate64 observations bind actual runtime, source, upstream asset, MIT license and immutable native execution', async () => {
  const provenance = JSON.parse(await fs.readFile(provenanceUrl));
  for (const file of provenance.files) assert.equal(hash(await fs.readFile(new URL(file.filename, root))), file.sha256, file.filename);
  for (const file of provenance.requiredInputs) assert.equal(hash(await fs.readFile(file.filename)), file.sha256, file.filename);
  const recordBytes = await fs.readFile(provenance.record.filename);
  assert.equal(hash(recordBytes), provenance.record.sha256);
  const record = JSON.parse(recordBytes);
  assert.equal(record.passed, true); assert.equal(record.sourcesUnchanged, true);
  assert.equal(record.sourceFilesSha256, provenance.sourceFilesSha256);
  for (const source of record.sourceFiles) {
    const relative = path.basename(source.filename) === 'Directory.Build.props' ? '../../../Directory.Build.props' : path.basename(source.filename);
    assert.equal(hash(await fs.readFile(new URL(relative, root))), source.sha256);
  }
  assert.equal(hash(await fs.readFile(provenance.rawNative.filename)), hash(await fs.readFile(new URL('native.json', root))));
  assert.equal(native.runtimeVersion, '10.0.12');
  for (const filename of [native.compressionAssembly, native.zipFileAssembly]) {
    assert.ok(provenance.requiredInputs.some(file => path.resolve(file.filename) === path.resolve(filename)));
  }
  const gitAsset = await fs.readFile(new URL('assets/Zip.deflate64.zip', root));
  assert.equal(createHash('sha1').update(Buffer.from('blob ' + gitAsset.length + '\0')).update(gitAsset).digest('hex'), provenance.upstream.gitBlobSha1);
  const license = await fs.readFile(new URL('LICENSE-SharpCompress.txt', root));
  assert.equal(createHash('sha1').update(Buffer.from('blob ' + license.length + '\0')).update(license).digest('hex'), provenance.licenseGitBlobSha1);
  assert.equal(record.comparisons.length, 17); assert.ok(record.comparisons.every(value => value.passed));
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
    const filename = path.basename(sample.filename);
    await t.test(filename, async t => {
      assert.equal(sample.archiveOpened, true); assert.equal(sample.archiveError, null);
      const archive = await fixture.open(filename, { zipOnly: true });
      try {
        assert.deepEqual(archive.entries.map(entry => ({ name: entry.key, size: entry.size })), sample.entries.map(entry => ({ name: entry.name, size: entry.Length })));
        for (const [index, expected] of sample.entries.entries()) {
          await t.test(expected.name, async () => {
            const entry = archive.entries[index]; assert.equal(archive.findEntry(expected.name), entry);
            if (expected.openError) {
              assert.equal(expected.openError.type, 'System.IO.InvalidDataException');
              assert.match(expected.openError.Message, /not supported|unsupported compression/iu);
              assert.equal(expected.opened, false); assert.equal(expected.readError, null);
              await assert.rejects(archive.read(entry), error => error.code === 'invalid-archive' && /compression method.*unsupported|unsupported compression method/iu.test(error.message));
            } else {
              assert.equal(expected.opened, true); assert.equal(expected.readError, null);
              const bytes = await archive.read(entry);
              assert.equal(bytes.length, expected.actualLength); assert.equal(hash(bytes), expected.sha256);
            }
          });
        }
      } finally { await archive.close(); }
      assert.deepEqual(await fs.readdir(fixture.spoolPath), []);
    });
  }
});
