import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { getNewItemId } from '../../src/core/identity.js';
import { captureCurrentNative, input, recordCandidate } from './fixtures/resolver-io-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
let native;
before(async () => { ({ native } = await captureCurrentNative()); });
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

test('resolver IO observations bind independent current native captures and actual path-derived identities', () => {
  assert.equal(native.results.length, 3);
  assert.equal(input.length, native.results.length);
  assert.equal(native.actualExecution, true);
  assert.equal(native.sqlite.actualResolverUsed, true);
});

function controlledDirectoryGraph(mediaRoot, scenario) {
  const byPath = new Map();
  const children = new Map();
  const add = (relative, kind) => {
    const identityPath = path.join(mediaRoot, relative);
    let value = byPath.get(identityPath);
    if (value) return value;
    value = {
      identityPath,
      accessPath: path.posix.join('/resolver-io-boundary', relative.replaceAll('\\', '/')),
      entry: { kind, name: path.basename(identityPath) }
    };
    byPath.set(identityPath, value);
    const parentPath = path.dirname(identityPath);
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

for (const scenario of input) test(`actual native resolver IO boundary: ${scenario.Name}`, async t => {
  const sample = native.results.find(value => value.Name === scenario.Name);
  assert.ok(sample);
  assert.equal(sample.exception, null);
  const programDataPath = sample.programDataPath;
  const mediaRoot = sample.mediaRoot;
  const parent = {
    Id: sample.parentId,
    NativeType: sample.parentType,
    Path: sample.parentPath,
    IsFolder: true,
    IsRoot: sample.parentIsRoot,
    IsPhysicalRoot: sample.parentIsPhysicalRoot
  };
  const rootPath = path.join(programDataPath, 'root');
  const root = parent.IsPhysicalRoot ? parent : {
    Id: getNewItemId(rootPath, 'MediaBrowser.Controller.Entities.AggregateFolder', {
      programDataPath, enableCaseSensitiveItemIds: true
    }),
    Path: rootPath,
    IsRoot: true,
    IsPhysicalRoot: true
  };
  const children = controlledDirectoryGraph(mediaRoot, scenario);
  const faultPath = path.join(mediaRoot, scenario.Fault.Path);
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
    candidates: children.get(path.join(mediaRoot, 'parent')),
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
  assert.deepEqual(actualItems, sample.items.map(({ derivedId, ...item }) => ({ ...item, Id: idKey(item.Id) })));
  const nativeFaults = sample.trace.filter(event => event.action === 'injected-fault');
  const nativeErrors = sample.trace.filter(event => event.action === 'log' && event.detail.level === 'Error');
  assert.equal(nativeFaults.length, 1);
  assert.equal(faults, nativeFaults.length);
  assert.ok(reports.length > 0);
  for (const report of reports) assert.deepEqual({ code: report.error.code, message: report.error.message },
    { code: failure.code, message: failure.message });
  // CLR logging and Node diagnostic names are retained observations. The
  // surviving item prefix/suffix above establishes the functional catch scope.
  const observation = {
    items: actualItems,
    nativeFault: nativeFaults[0].detail,
    nativeErrors: nativeErrors.map(event => event.detail),
    candidateDiagnostics: reports.map(report => report.context),
    reads
  };
  await recordCandidate(scenario.Name, observation);
  t.diagnostic(JSON.stringify(observation));
});
