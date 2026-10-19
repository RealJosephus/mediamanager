import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { getNewItemId } from '../../src/core/identity.js';

const provenanceUrl = new URL('./fixtures/resolver-io-boundary/provenance.json', import.meta.url);
const fixtureRoot = new URL('./', provenanceUrl);
const [nativeBytes, inputBytes, provenanceBytes] = await Promise.all(
  ['native.json', 'input.json', 'provenance.json'].map(name => readFile(new URL(name, fixtureRoot))));
const native = JSON.parse(nativeBytes);
const input = JSON.parse(inputBytes);
const provenance = JSON.parse(provenanceBytes);
const recording = JSON.parse(await readFile(provenance.executionRecord.filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const filenameKey = value => value.replaceAll('\\', '/');

test('resolver IO observations bind actual executed sources, runtime and loaded Oracle dependencies', async () => {
  assert.equal(native.results.length, 3);
  assert.equal(input.length, native.results.length);
  assert.equal(hash(nativeBytes), provenance.rawRecording.sha256);
  assert.equal(hash(inputBytes), native.inputSha256);
  assert.equal(recording.passed, true);
  assert.equal(recording.build.status, 0);
  assert.equal(recording.process.status, 0);
  assert.equal(recording.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(hash(JSON.stringify(recording.sourceFiles)), provenance.sourceFilesSha256);
  assert.equal(recording.oracleAssembly.sha256, provenance.oracleAssembly.sha256);
  assert.equal(recording.jellyfinDll.sha256, provenance.recordedRuntimeSha256);
  assert.equal(provenance.recordedRuntimeSha256, '474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26');
  assert.equal(provenance.originalHost.sha256, '7b2e629fac51b99f0a86883cc540a9fdf82db4ea116d6692191506751585f157');
  for (const file of provenance.files) {
    assert.equal(file.required, true, file.path);
    const bytes = await readFile(new URL(file.path, fixtureRoot));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(hash(bytes), file.sha256, file.path);
  }
  const requiredInputs = new Map(provenance.requiredInputs.map(file => [filenameKey(file.filename), file]));
  for (const file of provenance.requiredInputs) {
    assert.equal(file.required, true, file.filename);
    const bytes = await readFile(file.filename);
    assert.equal(bytes.length, file.bytes, file.filename);
    assert.equal(hash(bytes), file.sha256, file.filename);
  }
  for (const source of recording.sourceFiles) {
    assert.equal(requiredInputs.get(filenameKey(source.filename))?.sha256, source.sha256, source.filename);
  }
  assert.equal(native.assemblies.length, provenance.loadedAssemblies.length);
  for (const observed of native.assemblies) {
    const bound = provenance.loadedAssemblies.find(file => file.name === observed.name);
    assert.equal(bound?.required, true, observed.name);
    assert.equal(filenameKey(bound.filename), filenameKey(observed.path), observed.name);
    assert.equal(bound.sha256, observed.sha256, observed.name);
    assert.equal(requiredInputs.get(filenameKey(observed.path))?.sha256, observed.sha256, observed.name);
  }
});

function controlledDirectoryGraph(mediaRoot, scenario) {
  const byPath = new Map();
  const children = new Map();
  const add = (relative, kind) => {
    const identityPath = path.win32.join(mediaRoot, relative);
    let value = byPath.get(identityPath);
    if (value) return value;
    value = {
      identityPath,
      accessPath: path.posix.join('/resolver-io-boundary', relative.replaceAll('\\', '/')),
      entry: { kind, name: path.win32.basename(identityPath) }
    };
    byPath.set(identityPath, value);
    const parentPath = path.win32.dirname(identityPath);
    if (!children.has(parentPath)) children.set(parentPath, []);
    children.get(parentPath).push(value);
    return value;
  };
  for (const directory of scenario.Directories) {
    const segments = directory.split('/');
    for (let count = 1; count <= segments.length; count++) add(segments.slice(0, count).join('/'), 'directory');
  }
  // The executed Program writes this real control file after constructing the
  // host. Recognition reads its filename; no media decoder reads its bytes.
  add('parent/Broken/VIDEO_TS/VTS_01_1.VOB', 'file');
  return children;
}

for (const sample of native.results) test(`actual native resolver IO boundary: ${sample.Name}`, async t => {
  const scenario = input.find(value => value.Name === sample.Name);
  assert.ok(scenario);
  assert.equal(sample.exception, null);
  const caseRoot = path.win32.join(recording.process.args.at(-1), sample.Name);
  const programDataPath = path.win32.join(caseRoot, 'program');
  const mediaRoot = path.win32.join(caseRoot, 'media');
  const parent = {
    Id: sample.parentId,
    NativeType: sample.parentType,
    Path: sample.parentPath,
    IsFolder: true,
    IsRoot: sample.parentIsRoot,
    IsPhysicalRoot: sample.parentIsPhysicalRoot
  };
  const rootPath = path.win32.join(programDataPath, 'root');
  const root = parent.IsPhysicalRoot ? parent : {
    Id: getNewItemId(rootPath, 'MediaBrowser.Controller.Entities.AggregateFolder', {
      programDataPath, enableCaseSensitiveItemIds: true
    }),
    Path: rootPath,
    IsRoot: true,
    IsPhysicalRoot: true
  };
  const children = controlledDirectoryGraph(mediaRoot, scenario);
  const faultPath = path.win32.join(mediaRoot, scenario.Fault.Path);
  const failure = Object.assign(new Error(`Controlled directory IO failure at ${faultPath}`), { code: 'io' });
  const reports = [];
  const reads = [];
  let faults = 0;
  const pipeline = new DirectoryItemResolverPipeline({
    resolvers: [createVideoFileResolver()],
    programDataPath,
    configuration: { EnableCaseSensitiveItemIds: true },
    onError: (error, context) => reports.push({ error, context })
  });
  const result = await pipeline.resolve({
    parent,
    root,
    collectionContext: { collectionType: 'movies', collectionTypeSource: 'collection-folder' },
    candidates: children.get(path.win32.join(mediaRoot, 'parent')),
    peekDirectory: async candidate => {
      reads.push(candidate.identityPath);
      if (candidate.identityPath === faultPath) {
        faults++;
        throw failure;
      }
      return { listing: { deletionSafe: true }, candidates: children.get(candidate.identityPath) ?? [] };
    }
  });
  const actualItems = result.claims.map(claim => ({
    Id: idKey(claim.Id),
    type: claim.nativeType,
    Name: claim.draft.Name,
    Path: claim.identityPath,
    IsFolder: claim.draft.IsFolder,
    videoType: claim.draft.data?.VideoType ?? null
  }));
  assert.deepEqual(actualItems, sample.items.map(item => ({ ...item, Id: idKey(item.Id) })));
  const nativeFaults = sample.trace.filter(event => event.action === 'injected-fault');
  const nativeErrors = sample.trace.filter(event => event.action === 'log' && event.detail.level === 'Error');
  assert.equal(nativeFaults.length, 1);
  assert.equal(faults, nativeFaults.length);
  assert.equal(reports.length, nativeErrors.length);
  assert.ok(reports.length > 0);
  for (const report of reports) assert.equal(report.error, failure);
  // CLR logging and Node diagnostic names are retained observations. The
  // surviving item prefix/suffix above establishes the functional catch scope.
  t.diagnostic(JSON.stringify({
    nativeFault: nativeFaults[0].detail,
    nativeErrors: nativeErrors.map(event => event.detail),
    candidateDiagnostics: reports.map(report => report.context),
    reads
  }));
});
