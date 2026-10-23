import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFileSystem } from '../storage/plugin-files.js';
import { createLocalXmlPlugin, localXmlSavePath, serializeLocalXml } from '../../src/metadata/local-xml.js';
import { saveMetadata, ItemUpdateType } from '../../src/metadata/save-manager.js';
import { setNativePlaylistFileState } from '../../src/library/native-path.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const profileUrl = new URL('./fixtures/local-xml-save-current/current-profile.json', import.meta.url);
export const input = JSON.parse(await readFile(new URL('./fixtures/local-xml-save-current/input.json', import.meta.url), 'utf8'));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const errorRecord = error => ({ name: error.name, message: error.message, code: error.code });
export const functionalReader = reader => ({ failed: reader.failed, validXml: reader.validXml, result: reader.result });
export const functionalSave = saved => ({ saveFailed: saved.saveFailed, fileExists: saved.fileExists,
  changed: saved.changed, relativePath: saved.relativePath, effects: saved.effects });

function memberSnapshot(sample, resources) {
  const paths = sample.paths ?? input.defaultPaths, count = sample.count ?? paths.length;
  return { manualCount: BigInt(count), async *pages({ limit }) {
    for (let start = 0; start < count; start += limit) yield Array.from({ length: Math.min(count - start, limit) },
      (_, offset) => ({ Path: paths[(start + offset) % paths.length] }));
  }, async close() { resources.memberSnapshotClosed = true; } };
}

async function prepareCandidate(root) {
  const results = [];
  for (const sample of input.cases) {
    const directory = path.join(root, sample.name); await mkdir(directory, { recursive: true });
    const itemPath = path.join(directory, sample.type === 'Playlist' ? 'Road.m3u' : 'collection');
    if (sample.filePlaylist) await writeFile(itemPath, '#EXTM3U\n', { flag: 'wx' }); else await mkdir(itemPath);
    const item = { ...input.item, Type: sample.type, Path: itemPath, SupportsLocalMetadata: true,
      Overview: sample.fault === 'xml-null' ? 'Before \0 after' : sample.fault === 'xml-control' ? 'Before \u0001 after' : input.item.Overview };
    if (sample.type === 'Playlist') { delete item.DisplayOrder; setNativePlaylistFileState(item, Boolean(sample.filePlaylist)); }
    const filename = localXmlSavePath(item, { playlistFile: Boolean(sample.filePlaylist) });
    const previous = Buffer.from(input.previous);
    if (sample.existing) await writeFile(filename, previous, { flag: 'wx' });
    const spoolRoot = path.join(directory, 'spool'); await mkdir(spoolRoot);
    const effects = [], resources = {}, diagnostics = [], writes = [];
    const context = { localRoot: directory, localPath: itemPath,
      getPeople() { if (sample.fault === 'people') throw new Error('Controlled people lookup failure'); return []; },
      prepareLinkedXmlItems() {
        if (['links', 'unused-links'].includes(sample.fault)) throw new Error('Controlled member lookup failure');
        return memberSnapshot(sample, resources);
      } };
    let failure;
    try {
      if (sample.mode === 'remote') {
        const vfs = { capabilities: () => ({ create: true, replace: true, conditionalWrite: true, atomicReplace: true }),
          async write(destination, stream, options) {
            const chunks = []; for await (const bytes of stream) chunks.push(bytes);
            const body = Buffer.concat(chunks);
            writes.push({ destination, options, file: { bytes: body.length, sha256: sha(body) } });
            await writeFile(filename, body);
          } };
        const saver = createLocalXmlPlugin({ fileSystem: testFileSystem, vfs, spoolRoot }).providers.find(value => value.id === 'BoxSetXmlSaver');
        await saver.save(item, { ...context, localPath: undefined, accessPath: '/box',
          vfsWriteOptions: { ifMatch: 'explicit-version', atomic: true } });
      } else if (sample.mode === 'prepared') {
        const prepared = await serializeLocalXml(item, { ...context, fileSystem: testFileSystem, spoolRoot });
        try {
          const file = await open(filename, 'wx'); let length = 0n;
          try { for await (const bytes of prepared.stream()) {
            let offset = 0;
            while (offset < bytes.length) {
              const written = await file.write(bytes, offset, bytes.length - offset);
              assert.ok(written.bytesWritten > 0); offset += written.bytesWritten;
            }
            length += BigInt(bytes.length);
          } }
          finally { await file.close(); }
          assert.equal(length, prepared.size);
          const abandoned = prepared.stream(); await abandoned.next(); await prepared.close(); await abandoned.return();
          await assert.rejects(prepared.stream().next()); resources.closedPreparedStreamRejectsRead = true;
        } finally { await prepared.close(); }
      } else {
        const saver = createLocalXmlPlugin({ fileSystem: testFileSystem }).providers.find(value => value.id === sample.type + 'XmlSaver');
        if (sample.mode === 'manager') {
          const outcomes = await saveMetadata(item, ItemUpdateType.MetadataEdit, [saver, {
            id: 'Other', name: 'Other', isEnabledFor: () => true, save: async () => effects.push('other'),
          }], { context, libraryOptions: { MetadataSavers: ['Emby Xml', 'Other'] },
            logger: { error: error => { effects.push('logged-failure'); diagnostics.push(errorRecord(error)); } },
            monitor: { reportFileSystemChangeBeginning(destination) { assert.equal(destination, filename); effects.push('begin'); },
              reportFileSystemChangeComplete(destination, refresh) { assert.equal(destination, filename); assert.equal(refresh, false); effects.push('complete'); } } });
          resources.saverOutcomes = outcomes.map(outcome => ({ failed: Boolean(outcome.error) }));
        } else await saver.save(item, context);
      }
    } catch (error) { failure = errorRecord(error); }
    const bytes = await readFile(filename);
    await rename(filename, filename + '.closed'); await rename(filename + '.closed', filename);
    resources.fileReleased = true; resources.spoolEntries = await readdir(spoolRoot);
    results.push({ name: sample.name, type: sample.type, filename, relativePath: path.relative(directory, filename).replaceAll('\\', '/'),
      saveFailed: Boolean(failure), failure, fileExists: true, changed: !sample.existing || !bytes.equals(previous),
      file: { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') }, effects, diagnostics, resources, writes });
  }
  return results;
}

let pending;
export const currentLocalXml = () => pending ??= captureCurrentLocalXml();

async function captureCurrentLocalXml() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  const output = path.join(validationOutputRoot(), 'local-xml-save-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], nativeExecutionRecorded: false,
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
      assert.equal(actual.available, true); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256);
      report.inputs.push({ role: expected.role, ...actual });
    }
    assert.equal(input.cases.length, profile.cases); assert.equal(new Set(input.cases.map(sample => sample.name)).size, profile.cases);
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relative); assert.ok(pinned, relative);
      const source = await describeFile(path.join(build.root, 'source', relative)); assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const candidate = await prepareCandidate(path.join(output, 'candidate'));
    const inputFile = path.join(output, 'consumer-input.json'), bytes = Buffer.from(json({ input, candidate }));
    await writeFile(inputFile, bytes, { flag: 'wx' }); report.consumerInput = await describeFile(inputFile);
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
    const directory = path.join(output, 'native');
    const record = await recordOracle({ project, output: directory, args: [inputFile, '{output}/native.json', '{output}/state'] });
    const nativeFile = path.join(directory, 'native.json'), nativeBytes = await readFile(nativeFile), native = JSON.parse(nativeBytes);
    report.capture = { record, observation: await describeFile(nativeFile) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === nativeFile)?.sha256, sha(nativeBytes));
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha(bytes));
    assert.equal(native.actualXmlSavers, true); assert.equal(native.actualXmlParsers, true); assert.equal(native.actualProviderManager, true);
    for (const assembly of native.assemblies) {
      const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.name);
    }
    assert.equal(native.observations.length, 2);
    for (const observation of native.observations) assert.deepEqual(observation.results.map(value => value.name), input.cases.map(sample => sample.name));
    assert.deepEqual(native.candidateReads.map(value => value.name), candidate.map(value => value.name));
    for (const [index, value] of candidate.entries()) {
      assert.deepEqual(await readFile(value.filename), Buffer.from(value.file.base64, 'base64'));
      assert.deepEqual(native.candidateReads[index].file, value.file, 'The Native reader must consume the complete unchanged Node output.');
    }
    report.nativeExecutionRecorded = true;
    const comparisonFile = path.join(output, 'comparison.json');
    const comparisons = [];
    const recordComparison = async comparison => { comparisons.push(comparison); await writeFile(comparisonFile, json(comparisons)); };
    return { input, native, candidate, output, report, recordComparison };
  } catch (error) { report.error = { ...errorRecord(error), stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
