import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { discoveryFixture } from './video-discovery-fixture.js';
import { resolveDirectoryVideo, projectDirectoryResolution } from './directory-video-fixture.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/directory-multi-disc-stack/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));
const sourceHashes = Object.fromEntries(provenance.sourceFiles.map(file => [file.path, file.sha256]));
const fixtureHashes = Object.fromEntries(provenance.fixtureFiles.map(file => [file.path, file.sha256]));
const runtimeHashes = Object.fromEntries(Object.entries(provenance.runtime.assemblies)
  .map(([name, value]) => [name, value.sha256]));
const candidateCultureComparer = new Intl.Collator(undefined, { sensitivity: 'variant' });

test('multi-disc directory fixture is a complete actual native recording', async t => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.deepEqual(fixtureHashes, {
    'tests/library/fixtures/directory-multi-disc-stack/input.json': 'b2f0544fd2fce35aa23eb384e75c576af57f7ea5ec607d5bb8a0d1c7ce287665',
    'tests/library/fixtures/directory-multi-disc-stack/Program.cs': '85f03034d1191326ce35600c9da45c28b41947bfac791cc038e4cf03b4cbd287',
    'tests/library/fixtures/directory-multi-disc-stack/Oracle.csproj': 'cbe1a514da582cbf55a443ee14c93f731f84816d10e7672fb713045ac5d78efe',
    'tests/library/fixtures/directory-multi-disc-stack/native.json': '69a9c88749d3298a1928b1be32f9b4b879ad4bd29c6ccdeb595258fc042c274d',
    'tests/Directory.Build.props': 'd13564ee3d33568e7f897c6fe74ea5e71cc5ef9539e16854e628c5295c2319bd'
  });
  assert.equal(native.actualFrozenDirectoryMultiDiscStack, true);
  const portableNative = await readFile(new URL('native.json', root));
  assert.equal(portableNative.includes(13), false);
  assert.equal(portableNative.at(-1), 10);
  assert.equal(createHash('sha256').update(portableNative).digest('hex'), provenance.record.portableNativeSha256);
  assert.equal(createHash('sha256').update(Buffer.concat([
    Buffer.from(portableNative.subarray(0, -1).toString('utf8').replaceAll('\n', '\r\n')),
    Buffer.from('\n')
  ])).digest('hex'), provenance.record.rawNativeSha256);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 19);
  assert.deepEqual(native.currentCulture, provenance.runtime.dotnetCurrentCulture);
  assert.deepEqual(native.currentCulture, {
    name: 'zh-CN',
    compareInfoName: 'zh-CN',
    comparison: { left: 'Film_Disc 1', right: 'Film-Disc 2', result: -1 }
  });
  observeComparison(t, 'Intl options', candidateCultureComparer.resolvedOptions(), {
    locale: 'zh-CN', usage: 'sort', sensitivity: 'variant', ignorePunctuation: false,
    collation: 'default', numeric: false, caseFirst: 'false'
  });
  assert.deepEqual(provenance.runtime.nodeIntlCollator, {
    locale: 'zh-CN', usage: 'sort', sensitivity: 'variant', ignorePunctuation: false,
    collation: 'default', numeric: false, caseFirst: 'false', comparisonResult: -1
  });
  observeComparison(t, 'Intl comparison magnitude', candidateCultureComparer.compare(native.currentCulture.comparison.left,
    native.currentCulture.comparison.right), provenance.runtime.nodeIntlCollator.comparisonResult);
  assert.equal(Math.sign(candidateCultureComparer.compare(native.currentCulture.comparison.left,
    native.currentCulture.comparison.right)), Math.sign(native.currentCulture.comparison.result));
  assert.equal(Math.sign(provenance.runtime.nodeIntlCollator.comparisonResult),
    Math.sign(native.currentCulture.comparison.result));
  assert.match(native.scope, /GetMultiDiscMovie/u);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.capturedAt, '2026-10-07T23:15:30.165Z');
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.reference.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.reference.contentDigest, 'e28a983db179b720c3b16d7416ee4112894a3115c4be6fe43c61c52e0d9a8313');
  assert.equal(provenance.runtime.dotnet.sha256, '21a46f1e5235cf4e844b9de5429f0e198b9c97a41f0503a66442f1d639ca3ee6');
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.deepEqual(runtimeHashes, {
    'MediaBrowser.Controller.dll': '051c588a8e85a3a7cdde8dc3d9a1112217fd7e973a86fe2ff90cf765bedb75a8',
    'Emby.Server.Implementations.dll': '8d369435646570958505c58b9cb17da169855dabc105d0e933524361e9b7b1c8',
    'Jellyfin.Server.Implementations.dll': '4da187af02503e82135eb192351d01490484e8ebc8c653d849f7e2900a177672',
    'Emby.Naming.dll': '55085cf14d1e58a7a1e99e0ffc37bde0545bbe85f7f09995388a6e465cca3a45'
  });
  assert.equal(provenance.record.path,
    'D:/mediamanager-validation/20261005/results/directory-multi-disc-stack-oracle-20261008-v5/record.json');
  assert.equal(provenance.record.sha256, '87e41cf7c49c55a4726be0386b9b3823765bbb102f6ee7193e15b598636fb071');
  assert.equal(provenance.record.sourceFilesSha256, '2eacc0de5274313c0307c84271bbfdbb512ab80a0ace467d7877651db8a5a1e9');
  assert.equal(provenance.record.oracleAssemblySha256, 'ee88653c1c9b5bd1485d72dd252c06c74ebbd6ce1f027547b6e596942e653970');
  assert.equal(provenance.record.rawNativeSha256, '534887c440e28214c69f86d2e6af7177b4a19d0a2c309531c3e0e8d68e797451');
  assert.equal(provenance.record.portableNativeSha256, '69a9c88749d3298a1928b1be32f9b4b879ad4bd29c6ccdeb595258fc042c274d');
  assert.equal(provenance.record.buildStatus, 0);
  assert.equal(provenance.record.processStatus, 0);
  assert.equal(provenance.command,
    'node tools/validation/oracle.js tests/library/fixtures/directory-multi-disc-stack/Oracle.csproj D:/mediamanager-validation/20261005/results/directory-multi-disc-stack-oracle-20261008-v5 tests/library/fixtures/directory-multi-disc-stack/input.json {output}/native.json {output}/state');
  assert.deepEqual(sourceHashes, {
    'Emby.Server.Implementations/Library/Resolvers/Movies/MovieResolver.cs': '0a74d2079340fcfc85c9d72839112d42dbafe4285b286ceab137c0092c3f6e15',
    'Emby.Server.Implementations/Library/Resolvers/BaseVideoResolver.cs': 'bd67ff9d8f91d38923ddb07a7d99a49947a73a8d2a3a844f7bc9c101b43c2dc1',
    'Emby.Naming/Video/StackResolver.cs': 'cf7031594406d71878f821f39903352e0081616925e7049392696e0575a249c6',
    'Emby.Naming/Video/FileStackRule.cs': '378893e93b2c262242fa79c55fbba60335db72117d1ac62103064a34b4a44ed5',
    'Emby.Naming/Common/NamingOptions.cs': '4fc386ee2a335da97314845fcac71d2ffa534fbc37d772d44ae30e2dd4b07c02',
    'Emby.Server.Implementations/Library/LibraryManager.cs': '4729de97560262702a44c5829bf93bbc5deec379e9b3018b231aaa6d65643c44',
    'MediaBrowser.Controller/Library/ItemResolveArgs.cs': '6ccba267faebc220fbe374550eed30921a57587831c2b18d5484364e28032a25'
  });
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native multi-disc directory ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await discoveryFixture(t, dialect, sample);
  const resolved = await resolveDirectoryVideo(value, sample);
  assert.deepEqual(await projectDirectoryResolution(value, sample, resolved),
    native.results.find(result => result.name === sample.name));
});
