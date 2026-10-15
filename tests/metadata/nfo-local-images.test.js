import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNfo, parseNfoAsync } from '../../plugins/nfo/parser.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const root = new URL('./fixtures/nfo-local-images/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function replaceAll(xml, replacements) {
  for (const [token, value] of Object.entries(replacements)) xml = xml.replaceAll(token, escapeXml(value));
  return xml;
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function normalize(value, sampleRoot) {
  const uriRoot = pathToFileURL(sampleRoot + path.sep).href.replace(/\/$/, '');
  return value.replaceAll(sampleRoot, '$ROOT').replaceAll(uriRoot, '$ROOT_URI');
}

function nativeError(error) {
  if (!error) return null;
  if (error.name === 'AbortError') return 'OperationCanceledException';
  return error.nativeException ?? error.name ?? error.constructor.name;
}

function lookupResult(file) {
  if (!file) return 'missing-or-directory';
  const isFile = typeof file.isFile === 'function' ? file.isFile() : file.kind === 'file';
  return isFile ? 'file' : 'missing-or-directory';
}

function missing(error) {
  return ['ENOENT', 'ENOTDIR', 'not-found'].includes(error?.code);
}

function frozenMissingUnc(value) {
  return /^[\\/]{2,}server[\\/]share(?:[\\/]|$)/iu.test(value);
}

async function prepareSample(base, sample, index) {
  const sampleRoot = path.join(base, String(index).padStart(3, '0'));
  await mkdir(sampleRoot, { recursive: true });
  const locations = {
    present: path.join(sampleRoot, 'present image.jpg'),
    second: path.join(sampleRoot, 'second image.jpg'),
    unicode: path.join(sampleRoot, '圖像-İ-中文.jpg'),
    missing: path.join(sampleRoot, 'missing image.jpg'),
    directory: path.join(sampleRoot, 'directory.jpg'),
    existing: path.join(sampleRoot, 'preexisting image.jpg'),
  };
  await Promise.all([
    writeFile(locations.present, 'present'),
    writeFile(locations.second, 'second'),
    writeFile(locations.unicode, 'unicode'),
    writeFile(locations.existing, 'existing'),
    mkdir(locations.directory),
  ]);
  const xml = replaceAll(sample.xml, {
    '{{PRESENT}}': locations.present,
    '{{SECOND}}': locations.second,
    '{{UNICODE}}': locations.unicode,
    '{{MISSING}}': locations.missing,
    '{{DIRECTORY}}': locations.directory,
    '{{PRESENT_URI}}': pathToFileURL(locations.present).href,
    '{{MISSING_URI}}': pathToFileURL(locations.missing).href,
  });
  return { sampleRoot, locations, xml };
}

function initialState(sample, locations) {
  const images = (sample.existingLocal ?? []).map(Type => ({ Path: locations.existing, Type }));
  const remoteImages = (sample.existingRemote ?? []).map(Type => ({ Url: `https://preexisting.test/${Type.toLowerCase()}.jpg`, Type }));
  const localImageCandidates = (sample.existingCandidates ?? []).map(Type => ({ Url: locations.existing, Type }));
  return { item: { Type: 'Movie', ProviderIds: {} }, images, remoteImages, localImageCandidates };
}

function project(sample, prepared, state, error, hasMetadata, calls) {
  const localImages = [
    ...state.images.map(image => ({ source: image.Path, Type: image.Type })),
    ...state.localImageCandidates.map(image => ({ source: image.Url, Type: image.Type })),
  ].map(image => ({
    path: normalize(image.source, prepared.sampleRoot),
    name: path.win32.basename(image.source),
    exists: true,
    isDirectory: false,
    type: image.Type,
  }));
  const normalized = normalize(prepared.xml, prepared.sampleRoot);
  return {
    name: sample.name,
    providerRuntime: Boolean(sample.providerRuntime),
    raw: { normalizedBytes: Buffer.byteLength(normalized), normalizedSha256: sha256(normalized), normalized },
    exception: nativeError(error),
    hasMetadata,
    item: { Name: state.item.Name ?? null },
    lookups: calls,
    remoteImages: state.remoteImages.map(image => ({ url: image.Url, type: image.Type })),
    localImages,
  };
}

function syncStat(sample, prepared, controller, calls) {
  let count = 0;
  return value => {
    const call = ++count;
    if (call === sample.failLookupAt) {
      calls.push({ path: normalize(value, prepared.sampleRoot), outcome: 'IOException' });
      throw Object.assign(new Error('Injected directory-service failure.'), { nativeException: 'IOException' });
    }
    let file = null;
    if (!frozenMissingUnc(value)) try { file = statSync(value); } catch (error) { if (!missing(error)) throw error; }
    calls.push({ path: normalize(value, prepared.sampleRoot), outcome: lookupResult(file) });
    if (call === sample.cancelAfterLookup) controller.abort();
    return file;
  };
}

function asyncStat(sample, prepared, controller, calls, initialCount = 0) {
  let count = initialCount;
  return async value => {
    const call = ++count;
    if (call === sample.failLookupAt) {
      calls.push({ path: normalize(value, prepared.sampleRoot), outcome: 'IOException' });
      throw Object.assign(new Error('Injected directory-service failure.'), { nativeException: 'IOException' });
    }
    let file = null;
    if (!frozenMissingUnc(value)) try { file = await stat(value); } catch (error) { if (!missing(error)) throw error; }
    calls.push({ path: normalize(value, prepared.sampleRoot), outcome: lookupResult(file) });
    if (call === sample.cancelAfterLookup) controller.abort();
    return file;
  };
}

async function candidate(sample, prepared, asynchronous) {
  const state = initialState(sample, prepared.locations), calls = [], controller = new AbortController();
  if (sample.cancelBefore) controller.abort();
  let error = null, hasMetadata = false;
  if (sample.providerRuntime) {
    calls.push({ path: normalize(path.join(prepared.sampleRoot, 'movie.nfo'), prepared.sampleRoot), outcome: 'file' });
    let storage;
    let item = { Type: 'Movie', Path: path.join(prepared.sampleRoot, 'movie.mkv') };
    let vfs = {
      stat: async () => ({ kind: 'file' }),
      openRead: async () => ({ version: null, stream: (async function* () { yield Buffer.from(prepared.xml); })(), close: async () => {} }),
    };
    let imageAssets = { stat: asyncStat(sample, prepared, controller, calls, 1) };
    if (sample.mappedRuntime) {
      storage = new StorageRegistry();
      storage.registerType('memory', () => new MemoryStorageAdapter());
      await storage.createInstance('nfo-runtime', 'memory', {});
      vfs = new VirtualFileSystem(storage);
      vfs.mount({ path: '/images', instanceId: 'nfo-runtime', capabilities: { create: true, replace: true, delete: true } });
      const bytes = Buffer.from(prepared.xml);
      await vfs.write('/images/movie.nfo', bytes, { overwrite: false, size: BigInt(bytes.length) });
      const identityMap = new IdentityAccessMap();
      identityMap.addPrefix({ identityRoot: 'D:\\library', accessRoot: '/images', style: 'windows', caseSensitive: false,
        returnAccess: 'isolated mapped NFO runtime fixture' });
      item = { Type: 'Movie', Path: 'D:\\library\\movie.mkv', IsFileProtocol: true, IsInMixedFolder: false };
      const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap }).forItem(item, '/images/movie.mkv');
      imageAssets = { stat: async (value, options) => {
        try {
          const file = await assets.stat(value, options);
          calls.push({ path: normalize(value, prepared.sampleRoot), outcome: lookupResult(file) });
          return file;
        } catch (caught) {
          if (['not-found', 'unmapped-path'].includes(caught.code)) {
            calls.push({ path: normalize(value, prepared.sampleRoot), outcome: 'missing-or-directory' });
          }
          throw caught;
        }
      } };
    }
    try {
      const result = await createNfoPlugin({fileSystem: testFileSystem,  vfs }).getMetadata(item, {
        accessPath: sample.mappedRuntime ? '/images/movie.mkv' : '/fixture/movie.mkv',
        containingFolderPath: sample.mappedRuntime ? '/images' : '/fixture', images: state.images,
        remoteImages: state.remoteImages, localImageCandidates: state.localImageCandidates,
        imageAssets, signal: controller.signal,
      });
      hasMetadata = result.HasMetadata;
      return project(sample, prepared, { item: result.Item ?? state.item, images: result.Images ?? [], remoteImages: result.RemoteImages ?? [],
        localImageCandidates: result.LocalImageCandidates ?? [] }, null, hasMetadata, calls);
    } catch (caught) { error = caught; }
    finally { await storage?.close(); }
    return project(sample, prepared, { item: state.item, images: [], remoteImages: [], localImageCandidates: [] }, error, hasMetadata, calls);
  }
  const options = { type: 'Movie', item: state.item, images: state.images, remoteImages: state.remoteImages,
    localImageCandidates: state.localImageCandidates, signal: controller.signal,
    localImageStat: asynchronous ? asyncStat(sample, prepared, controller, calls) : syncStat(sample, prepared, controller, calls) };
  try {
    if (asynchronous) await parseNfoAsync(prepared.xml, options);
    else parseNfo(prepared.xml, options);
    hasMetadata = true;
  } catch (caught) { error = caught; }
  return project(sample, prepared, state, error, hasMetadata, calls);
}

test('native local-image fixture binds Windows, culture, inputs and scene order', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(sha256(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  }
  assert.equal(process.platform, 'win32');
  assert.equal(native.schemaVersion, 1);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.recordedAt, '2026-10-08T01:50:45.637Z');
  assert.equal(provenance.command, "node tools/validation/oracle.js tests/metadata/fixtures/nfo-local-images/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-local-images-20261008-v11-literal-identity tests/metadata/fixtures/nfo-local-images/input.json {output}/native.json {output}/filesystem");
  assert.equal(native.environment.isWindows, true);
  assert.equal(native.environment.culture, 'zh-CN');
  assert.equal(provenance.jellyfin.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.jellyfin.root, 'D:/jellyfin');
  assert.equal(provenance.jellyfin.relevantSourceWorktreeClean, true);
  assert.equal(native.frozenJellyfinHead, provenance.jellyfin.head);
  assert.equal(native.inputSha256, sha256(await readFile(new URL('input.json', root))));
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.runtime.platform, 'win32');
  assert.equal(provenance.runtime.os, 'Microsoft Windows NT 10.0.26300.0');
  assert.equal(provenance.runtime.culture, 'zh-CN');
  assert.equal(provenance.runtime.uiCulture, 'zh-CN');
  assert.equal(provenance.runtime.timezone, 'Asia/Taipei');
  assert.equal(provenance.runtime.node, 'v24.16.0');
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.files).map(([name, file]) => [name, file.path])), {
    native: 'tests/metadata/fixtures/nfo-local-images/native.json',
    input: 'tests/metadata/fixtures/nfo-local-images/input.json',
    oracle: 'tests/metadata/fixtures/nfo-local-images/Program.cs',
    project: 'tests/metadata/fixtures/nfo-local-images/Oracle.csproj',
    buildProperties: 'tests/Directory.Build.props',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.files).map(([name, file]) => [name, file.sha256])), {
    native: 'fe521675f87e1c702084d47f8d7230cdbb8c36893c678db77dd48b89f2969c70',
    input: '23c075b07a2700dafff6c001b831d1ea7d2cdbcaa127a24a557dddbe647f9fa9',
    oracle: '724cd59789f49f1ad3ec02c4c861b446582fdba244b4d0a9fe0a782f558745b9',
    project: '56e42cc99a5305248cb523db75850ab8bce9868f3a283101fa0a208332829234',
    buildProperties: 'd13564ee3d33568e7f897c6fe74ea5e71cc5ef9539e16854e628c5295c2319bd',
  });
  assert.equal(provenance.runtime.dotnet.path, 'D:/mediamanager/.tools/dotnet/dotnet.exe');
  assert.equal(provenance.runtime.dotnet.bytes, 167208);
  assert.equal(provenance.runtime.dotnet.sha256, '21a46f1e5235cf4e844b9de5429f0e198b9c97a41f0503a66442f1d639ca3ee6');
  assert.equal(provenance.runtime.jellyfinDll.path, 'D:/mediamanager-validation/20261005/jellyfin-baseline/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll');
  assert.equal(provenance.runtime.jellyfinDll.bytes, 506368);
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.runtime.assemblies).map(([name, file]) => [name, file.bytes])), {
    'MediaBrowser.XbmcMetadata.dll': 84992,
    'MediaBrowser.Controller.dll': 655872,
    'MediaBrowser.Common.dll': 48640,
    'MediaBrowser.Model.dll': 489472,
    'Emby.Server.Implementations.dll': 1673728,
    'Jellyfin.Database.Implementations.dll': 249344,
    'Jellyfin.Extensions.dll': 37888,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.runtime.assemblies).map(([name, file]) => [name, file.sha256])), {
    'MediaBrowser.XbmcMetadata.dll': '82ddd82082f44faf43284258609ba4efce9a94759d24e0f7161ebf5c7d18558e',
    'MediaBrowser.Controller.dll': '051c588a8e85a3a7cdde8dc3d9a1112217fd7e973a86fe2ff90cf765bedb75a8',
    'MediaBrowser.Common.dll': 'c86a38f99a78d9d3b9dd5ba5245fb06bf654cfa3e16ec409d3ba77b1e69ed11e',
    'MediaBrowser.Model.dll': '7b2c1b16721cf7747b572e4de3761de635fad4bd12bec346983545bee73fd92c',
    'Emby.Server.Implementations.dll': '8d369435646570958505c58b9cb17da169855dabc105d0e933524361e9b7b1c8',
    'Jellyfin.Database.Implementations.dll': '5ffd9a90affb635962267da294a36a4cd6972da5f38083b51ecfb4fba4c31ee6',
    'Jellyfin.Extensions.dll': 'db952e3013a6949ad22db9ac3379be2efdf441c139ddc6919e86f8c2abbc7207',
  });
  assert.deepEqual(provenance.jellyfin.sources, {
    'MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs': 'f50fd3439d423330b0bc1c40ab5b413a2c2b3811a14a0955ecd9fbb63b32c152',
    'MediaBrowser.XbmcMetadata/Parsers/MovieNfoParser.cs': 'a48429be9a2e059be6dbde858cb9c423cbe594ba81f24bca661ab541c5778663',
    'MediaBrowser.Controller/Providers/DirectoryService.cs': '46d8feb177e5eeb9332d1bd5d355c33e592fb41ae0ebccf83e7150548ad0b711',
    'MediaBrowser.Controller/Providers/IDirectoryService.cs': 'ba9070b1c1cdd281c7c62dfc785405ffeaaf77a1c5ccaead50caaae86895c310',
    'Emby.Server.Implementations/IO/ManagedFileSystem.cs': '280ea08cf13065d8cd3790edf551b28ddfc9f352f4758d4fe0e62a55dbe0b14e',
    'MediaBrowser.Controller/Providers/MetadataResult.cs': '71fb22c6a4da1e4ec2af9e872eede684af560c5f5dcf17b9dde83dd4f644d856',
    'MediaBrowser.Model/IO/FileSystemMetadata.cs': '966a0dfb22ca20449f046df7ae1452ffff98d89221ff729fff9a84ad1d18ae49',
    'MediaBrowser.Controller/Extensions/XmlReaderExtensions.cs': '45e5ecd70806044d4d803f2d7b9a2b9c370d9ba21c232234f2d7de61f7ca446c',
    'MediaBrowser.XbmcMetadata/Providers/BaseNfoProvider.cs': '3e9cb414ae0efe0752c4d935988f5fce61ec30a26cc31d27b2c436580c94d8bc',
    'MediaBrowser.XbmcMetadata/Providers/BaseVideoNfoProvider.cs': '609b84385a41b03219f4a49b5750ef5e0b010fc3e98c61a84b40a114f4ef0d5c',
  });
  assert.equal(provenance.record.path, 'D:/mediamanager-validation/20261005/results/nfo-local-images-20261008-v11-literal-identity/record.json');
  assert.equal(provenance.record.sourceFilesSha256, '078befc6ca3b39bf6ac3d613a78dac9ab487b99fd0286657e002c5f27f07cae6');
  assert.equal(provenance.record.oracleAssemblySha256, '228908b782f87d4d704bf256c2a381c9d944800a3bea71b7073b82f16d196902');
  assert.equal(provenance.record.sha256, '17703a6bf9055d680430d7293da80604b5fa70f47d9b764caf373e24e1562b90');
  const portableNative = await readFile(new URL('native.json', root));
  assert.equal(provenance.record.rawNativeSha256, 'fe521675f87e1c702084d47f8d7230cdbb8c36893c678db77dd48b89f2969c70');
  assert.equal(provenance.record.portableNativeSha256, 'fe521675f87e1c702084d47f8d7230cdbb8c36893c678db77dd48b89f2969c70');
  assert.equal(provenance.record.portableNativeSha256, provenance.record.rawNativeSha256);
  assert.equal(sha256(portableNative), provenance.record.portableNativeSha256);
  assert.equal(provenance.record.rawNativeBytes, 144396);
  assert.equal(provenance.record.portableNativeBytes, 144396);
  assert.equal(portableNative.length, provenance.record.rawNativeBytes);
  assert.equal(portableNative.length, provenance.record.portableNativeBytes);
  assert.equal(portableNative.includes(13), false);
  assert.equal(provenance.record.rawCarriageReturns, 0);
  assert.equal(provenance.record.portableCarriageReturns, 0);
  assert.equal(portableNative.at(-1), 10);
  assert.equal(provenance.record.rawFinalByte, 10);
  assert.equal(provenance.record.portableFinalByte, 10);
  assert.equal(provenance.record.buildStatus, 0);
  assert.equal(provenance.record.processStatus, 0);
  assert.equal(input.length, 212);
  assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  for (const result of native.results) {
    assert.equal(result.raw.normalizedBytes, Buffer.byteLength(result.raw.normalized), result.name);
    assert.equal(result.raw.normalizedSha256, sha256(result.raw.normalized), result.name);
  }
});

test('native local-image fixture freezes URI, duplicate, prefix and cancellation boundaries', () => {
  const byName = new Map(native.results.map(result => [result.name, result]));
  assert.equal(byName.get('existing absolute Windows path adds a primary local image').localImages.length, 1);
  assert.equal(byName.get('existing absolute file URI is passed literally to the Windows filesystem').localImages.length, 0);
  assert.equal(byName.get('relative image path is rejected without a filesystem lookup').lookups.length, 0);
  assert.equal(byName.get('POSIX rooted path is not an absolute URI on Windows').lookups.length, 0);
  assert.equal(byName.get('drive-relative Windows path is invalid without a filesystem lookup').lookups.length, 0);
  assert.deepEqual(byName.get('drive-relative Windows path is invalid without a filesystem lookup').remoteImages, []);
  assert.deepEqual(byName.get('forward-slash UNC path is local and keeps its literal lookup').lookups,
    [{ path: '//server/share/poster.jpg', outcome: 'missing-or-directory' }]);
  assert.equal(byName.get('invalid absolute URI is rejected without a filesystem lookup').lookups.length, 0);
  const remoteUrl = name => byName.get(name).remoteImages[0].url;
  assert.equal(remoteUrl('remote encoded brackets stay escaped'), 'https://example.test/a%5Bb%5D.jpg');
  assert.equal(remoteUrl('remote encoded percent stays escaped'), 'https://example.test/rate%25.jpg');
  assert.equal(remoteUrl('remote encoded space becomes a literal space'), 'https://example.test/poster one.jpg');
  assert.equal(remoteUrl('remote raw space remains a literal space'), 'https://example.test/poster one.jpg');
  assert.equal(remoteUrl('remote Unicode path stays decoded'), 'https://example.test/圖像-İ.jpg');
  assert.equal(remoteUrl('remote escaped slash and hash stay escaped'), 'https://example.test/a%2Fb%23c.jpg');
  assert.equal(remoteUrl('remote escaped ASCII unreserved characters decode'), 'https://example.test/aA~-._.jpg');
  assert.equal(remoteUrl('remote escaped ASCII reserved characters stay escaped'),
    'https://example.test/%3A%40%21%24%26%27%28%29%2A%2B%2C%3B%3D');
  assert.equal(remoteUrl('remote escaped null stays escaped'), 'https://example.test/a%00b.jpg');
  assert.equal(remoteUrl('remote lowercase escaped slash preserves escape casing'), 'https://example.test/a%2fb.jpg');
  assert.equal(remoteUrl('remote query escapes stay encoded'),
    'https://example.test/query.jpg?brackets=%5Bvalue%5D&percent=%25&space= &unicode=圖像&slash=%2F&hash=%23');
  assert.equal(remoteUrl('remote Unicode host uses its U-label'), 'https://例子.测试/海報.jpg');
  assert.equal(remoteUrl('hierarchical URI preserves an explicit empty query delimiter'), 'https://example.test/path?');
  assert.equal(remoteUrl('hierarchical URI preserves an explicit empty fragment delimiter'), 'https://example.test/path#');
  assert.equal(remoteUrl('hierarchical URI preserves explicit empty query and fragment delimiters'), 'https://example.test/path?#');
  assert.equal(remoteUrl('hierarchical userinfo displays unreserved and UTF8 while retaining space and at escapes'),
    'https://uA圖:p~像 %40@example.test/path.jpg');
  assert.equal(remoteUrl('hierarchical userinfo preserves an explicit empty password delimiter'),
    'https://user:@example.test/a');
  assert.equal(remoteUrl('hierarchical authority preserves explicit empty userinfo'), 'https://@example.test/a');
  assert.equal(remoteUrl('hierarchical authority preserves explicit empty username and password'), 'https://:@example.test/a');
  assert.equal(remoteUrl('mailto opaque path uses URI display escaping'), 'mailto:userA圖 %40@example.test');
  assert.equal(remoteUrl('urn opaque path uses URI display escaping'), 'urn:example:aA圖 %2F');
  assert.equal(remoteUrl('IPv6 authority removes the default HTTPS port'), 'https://[2001:db8::1]/path.jpg');
  assert.equal(remoteUrl('IPv6 authority retains a nondefault HTTPS port'), 'https://[2001:db8::1]:8443/path.jpg');
  for (const name of ['edge-000', 'edge-001', 'edge-002', 'edge-003', 'edge-004', 'edge-005', 'edge-006',
    'edge-007', 'edge-013', 'edge-014', 'edge-015', 'edge-017', 'edge-018']) {
    assert.deepEqual(byName.get(name).remoteImages, [], name);
    assert.deepEqual(byName.get(name).lookups, [], name);
  }
  assert.equal(remoteUrl('edge-016'), 'http://example.com/a/b');
  for (const name of ['edge-019', 'edge-020', 'edge-021', 'edge-022', 'edge-023', 'edge-024', 'edge-025',
    'edge-026', 'edge-027', 'edge-028', 'edge-029', 'edge-030', 'edge-031']) {
    assert.deepEqual(byName.get(name).remoteImages, [], name);
    assert.deepEqual(byName.get(name).lookups, [], name);
  }
  assert.deepEqual(byName.get('edge-032').lookups, [{ path: '//server', outcome: 'missing-or-directory' }]);
  assert.deepEqual(byName.get('edge-033').lookups, [{ path: '//server/share', outcome: 'missing-or-directory' }]);
  assert.deepEqual(byName.get('edge-036').lookups, [{ path: '\\\\server\\share', outcome: 'missing-or-directory' }]);
  assert.equal(remoteUrl('edge-042'), 'http://example.com/%25');
  assert.equal(remoteUrl('edge-044'), 'http://example.com/%25zz');
  assert.equal(remoteUrl('edge-047'), 'http://u%zz@example.com/a');
  assert.equal(remoteUrl('query normalizes a nonhex percent escape'), 'http://example.com/a?x=%252G');
  assert.equal(remoteUrl('fragment normalizes a short percent escape'), 'http://example.com/a#%252');
  assert.equal(remoteUrl('opaque URI applies the ASCII display escape matrix'), 'custom:A~ "<>^`{|}%25%40%2F%23');
  assert.equal(remoteUrl('query applies the ASCII display escape matrix'),
    'http://example.com/a?x=A~ "<>^`{|}%25%40%2F%23');
  assert.equal(remoteUrl('fragment applies the ASCII display escape matrix'),
    'http://example.com/a#A~ "<>^`{|}%25%40%2F%23');
  assert.equal(remoteUrl('userinfo applies its ASCII display escape matrix'),
    'http://uA~ "<>^`{|}%25%40:pA~ %40@example.com/a');
  assert.equal(remoteUrl('opaque URI applies its IRI code point matrix'),
    'custom:\u2028-%EE%80%80-%EF%BF%BE-%EF%BF%BD-\u{10000}');
  assert.equal(remoteUrl('query applies its IRI code point matrix'),
    'http://example.com/a?x=\u2028-\uE000-%EF%BF%BE-%EF%BF%BD-\u{10000}');
  assert.equal(remoteUrl('fragment applies its IRI code point matrix'),
    'http://example.com/a#\u2028-%EE%80%80-%EF%BF%BE-%EF%BF%BD-\u{10000}');
  assert.equal(remoteUrl('userinfo applies its IRI code point matrix'),
    'http://u\u2028-%EE%80%80-%EF%BF%BE-%EF%BF%BD-\u{10000}@example.com/a');
  assert.equal(remoteUrl('userinfo standalone encoded space stays escaped'), 'http://u%20@example.com/a');
  assert.equal(remoteUrl('userinfo standalone encoded quote stays escaped'), 'http://u%22@example.com/a');
  assert.equal(remoteUrl('userinfo display escape before unreserved escape shares run state'),
    'http://u"A@example.com/a');
  assert.equal(remoteUrl('userinfo raw unreserved text does not anchor an encoded space'),
    'http://u%20x@example.com/a');
  assert.equal(remoteUrl('userinfo Unicode run retains an encoded at delimiter'), 'http://u圖%40@example.com/a');
  const fileLookupFailure = (name, literal) => {
    const result = byName.get(name);
    assert.equal(result.exception, 'IOException', name);
    assert.deepEqual(result.lookups, [{ path: literal, outcome: 'IOException' }], name);
    assert.deepEqual(result.remoteImages, [], name);
  };
  fileLookupFailure('file URI drive path without slashes is local and keeps its literal lookup', 'file:C:/x');
  fileLookupFailure('file URI drive path with one slash is local and keeps its literal lookup', 'file:/C:/x');
  fileLookupFailure('file URI drive path with three slashes is local and keeps its literal lookup', 'file:///C:/x');
  fileLookupFailure('file URI drive authority form is local and keeps its literal lookup', 'file://C:/x');
  fileLookupFailure('file URI drive backslash path is local and keeps its literal lookup', 'file:C:\\x');
  fileLookupFailure('file URI rooted drive backslash path is local and keeps its literal lookup', 'file:\\C:\\x');
  fileLookupFailure('file URI backslash UNC is local and keeps its literal lookup', 'file:\\\\server\\share\\x');
  fileLookupFailure('file URI authority UNC is local and keeps its literal lookup', 'file://server/share/x');
  fileLookupFailure('file URI four-slash UNC is local and keeps its literal lookup', 'file:////server/share/x');
  fileLookupFailure('empty file URI authority is local and keeps its literal lookup', 'file://');
  fileLookupFailure('empty file URI path with query is local and keeps its literal lookup', 'file:///?q');
  fileLookupFailure('file URI drive path with query and fragment keeps its literal lookup', 'file:///C:/x?q#f');
  fileLookupFailure('file URI mixed authority backslashes follow native classification', 'file://server\\share\\x');
  fileLookupFailure('file URI empty mixed-slash authority follows native classification', 'file:/\\');
  fileLookupFailure('file URI legacy drive separator follows native classification', 'file:C|/x');
  for (const name of ['edge-007', 'file URI single-slash server path is invalid without lookup',
    'file URI drive-relative path is invalid without lookup', 'file scheme without a path is invalid without lookup',
    'file scheme with only a query is invalid without lookup', 'file scheme with only a fragment is invalid without lookup',
    'file URI drive designator without a separator follows native classification',
    'file URI slash drive designator without a separator follows native classification',
    'file URI authority drive designator without a separator follows native classification',
    'file URI single forward root follows native classification', 'file URI single backslash root follows native classification',
    'file URI single backslash server path follows native classification',
    'file URI percent-encoded drive letter follows native classification']) {
    assert.deepEqual(byName.get(name).lookups, [], name);
    assert.deepEqual(byName.get(name).remoteImages, [], name);
  }
  const runtimeFileFailure = byName.get('runtime provider preserves a file URI lookup failure');
  assert.equal(runtimeFileFailure.exception, null);
  assert.equal(runtimeFileFailure.hasMetadata, false);
  assert.deepEqual(runtimeFileFailure.lookups, [
    { path: '$ROOT\\movie.nfo', outcome: 'file' },
    { path: 'file:C:/x', outcome: 'IOException' },
  ]);
  assert.deepEqual(byName.get('runtime provider rejects a relative file URI without an image lookup').lookups,
    [{ path: '$ROOT\\movie.nfo', outcome: 'file' }]);
  const mappedRuntime = byName.get('mapped runtime treats a literal file URI as a missing native path');
  assert.equal(mappedRuntime.exception, null);
  assert.equal(mappedRuntime.hasMetadata, true);
  assert.deepEqual(mappedRuntime.lookups, [
    { path: '$ROOT\\movie.nfo', outcome: 'file' },
    { path: 'file:C:/missing.jpg', outcome: 'missing-or-directory' },
  ]);
  assert.deepEqual(mappedRuntime.localImages, []);
  assert.equal(byName.get('local duplicates keep the first image and skip the second lookup').lookups.length, 1);
  assert.equal(byName.get('missing local does not block a later existing image of the same type').lookups.length, 2);
  assert.deepEqual(byName.get('local and remote images of the same type are independent').localImages.map(image => image.type), ['Primary']);
  assert.deepEqual(byName.get('local and remote images of the same type are independent').remoteImages.map(image => image.type), ['Primary']);
  assert.equal(byName.get('all seven local image types accept only their first existing file').localImages.length, 7);
  assert.deepEqual(byName.get('fanart local descendant defaults to backdrop').localImages.map(image => image.type), ['Backdrop']);
  assert.equal(byName.get('malformed immediate sibling prevents local image commit and lookup').lookups.length, 0);
  assert.equal(byName.get('later malformed XML preserves an earlier local image').localImages.length, 1);
  assert.equal(byName.get('second local filesystem failure preserves the first local prefix').exception, 'IOException');
  assert.equal(byName.get('second local filesystem failure preserves the first local prefix').localImages.length, 1);
  assert.equal(byName.get('pre-cancellation prevents the first image lookup').exception, 'OperationCanceledException');
  assert.equal(byName.get('cancellation after a local lookup preserves that image prefix').localImages.length, 1);
  const runtime = byName.get('runtime provider starts fresh image collections despite caller images');
  assert.equal(runtime.providerRuntime, true);
  assert.deepEqual(runtime.localImages.map(image => image.type), ['Primary']);
  assert.deepEqual(runtime.remoteImages.map(image => image.type), ['Primary']);
  assert.deepEqual(runtime.lookups.map(call => call.path), ['$ROOT\\movie.nfo', '$ROOT\\present image.jpg']);
});

for (const asynchronous of [false, true]) test(`production ${asynchronous ? 'async' : 'sync'} NFO local-image reader matches every frozen native result`, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), `nfo-local-${asynchronous ? 'async' : 'sync'}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const differences = [];
  for (const [index, sample] of input.entries()) {
    const prepared = await prepareSample(base, sample, index);
    const actual = await candidate(sample, prepared, asynchronous);
    const expected = native.results[index];
    try { assert.deepEqual(actual, expected); }
    catch { differences.push({ name: sample.name, actual, expected }); }
  }
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_LOCAL_IMAGE_DIFF === '1') {
    process.stdout.write(`NFO_LOCAL_IMAGE_DIFF=${JSON.stringify(differences)}\n`);
  }
  assert.deepEqual(differences, []);
});

test('NFO provider uses its loaded image-assets scope while retaining literal file-URI behavior', async () => {
  const windowsPath = 'D:\\library\\movie\\poster.jpg';
  const missingPath = 'D:\\library\\movie\\missing.jpg';
  const fileUri = 'file:///D:/library/movie/poster.jpg';
  const xml = `<movie><thumb>${fileUri}</thumb><thumb>${missingPath}</thumb><thumb>${windowsPath}</thumb></movie>`;
  const calls = [];
  const vfs = {
    stat: async value => value === '/media/movie.nfo' ? { kind: 'file' } : Promise.reject(Object.assign(new Error('missing'), { code: 'not-found' })),
    openRead: async () => ({ version: null, stream: (async function* () { yield Buffer.from(xml); })(), close: async () => {} }),
  };
  const imageAssets = { stat: async (value, options = {}) => {
    calls.push({ value, literalIdentity: options.literalIdentity ?? false });
    if (value === fileUri) throw Object.assign(new Error('literal file URI is unmapped'), { code: 'unmapped-path' });
    if (value === missingPath) throw Object.assign(new Error('missing'), { code: 'not-found' });
    return { kind: 'file', Path: value };
  } };
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs });
  const result = await plugin.getMetadata({ Type: 'Movie', Path: '/media/movie.mkv' }, { imageAssets });
  assert.deepEqual(calls, [
    { value: fileUri, literalIdentity: true },
    { value: missingPath, literalIdentity: false },
    { value: windowsPath, literalIdentity: false },
  ]);
  assert.deepEqual(result.LocalImageCandidates, [{ Url: windowsPath, Type: 'Primary' }]);
  const error = Object.assign(new Error('unmapped native path'), { code: 'unmapped-path' });
  const unmappedXml = `<movie><thumb>D:\\unmapped\\poster.jpg</thumb></movie>`;
  const unmappedVfs = { ...vfs,
    openRead: async () => ({ version: null, stream: (async function* () { yield Buffer.from(unmappedXml); })(), close: async () => {} }) };
  await assert.rejects(createNfoPlugin({fileSystem: testFileSystem,  vfs: unmappedVfs }).getMetadata({ Type: 'Movie', Path: '/media/movie.mkv' }, {
    accessPath: '/media/movie.mkv', containingFolderPath: '/media', imageAssets: { stat: async () => { throw error; } },
  }), caught => caught === error);
});

test('mapped NFO runtime isolates literal file URIs from native identity mappings', async t => {
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('nfo-literal', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/images', instanceId: 'nfo-literal', capabilities: { create: true, replace: true, delete: true } });
  t.after(() => storage.close());
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'D:\\library', accessRoot: '/images', style: 'windows', caseSensitive: false,
    returnAccess: 'isolated literal file-URI runtime test' });
  const item = { Type: 'Movie', Path: 'D:\\library\\movie.mkv', IsFileProtocol: true, IsInMixedFolder: false };
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap }).forItem(item, '/images/movie.mkv');
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs });
  const load = async value => {
    const bytes = Buffer.from(`<movie><thumb>${value}</thumb></movie>`);
    try { await vfs.delete('/images/movie.nfo'); } catch (error) { if (error.code !== 'not-found') throw error; }
    await vfs.write('/images/movie.nfo', bytes, { overwrite: false, size: BigInt(bytes.length) });
    return plugin.getMetadata(item, { accessPath: '/images/movie.mkv', containingFolderPath: '/images', imageAssets: assets });
  };
  const literal = await load('file:C:/missing.jpg');
  assert.equal(literal.HasMetadata, true);
  assert.deepEqual(literal.LocalImageCandidates, []);
  for (const value of ['E:\\unmapped\\poster.jpg', '\\\\server\\other\\poster.jpg']) {
    await assert.rejects(load(value), error => error.code === 'unmapped-path');
  }
  await assert.rejects(load('D:\\library\\..\\escape.jpg'), error => error.code === 'invalid-path');
});

test('forward UNC uses the Windows identity map and replacement refreshes do not seed the provider result', async t => {
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('nfo-unc', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/images', instanceId: 'nfo-unc', capabilities: { create: true, replace: true, delete: true } });
  t.after(() => storage.close());
  const poster = '//server/share/poster.jpg', oldPoster = '//server/share/old.jpg';
  const xml = Buffer.from(`<movie><thumb>${poster}</thumb></movie>`);
  await vfs.write('/images/movie.nfo', xml, { overwrite: false, size: BigInt(xml.length) });
  await vfs.write('/images/poster.jpg', Buffer.from('poster'), { overwrite: false, size: 6n });
  await vfs.write('/images/old.jpg', Buffer.from('old'), { overwrite: false, size: 3n });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: '//server/share', accessRoot: '/images', style: 'windows',
    returnAccess: 'isolated forward UNC local-image fixture' });
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap });
  assert.deepEqual(({ Path: (await assets.stat(poster)).Path, kind: (await assets.stat(poster)).kind }), { Path: poster, kind: 'file' });
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs }), service = new MetadataImages();
  const item = { Type: 'Movie', Path: '//server/share/movie.mkv', IsFileProtocol: true, IsInMixedFolder: false };
  for (const sourceOptions of [{ ReplaceAllImages: true }, { ReplaceImages: ['Primary'] }]) {
    const calls = [];
    const imageAssets = { stat: async (...args) => { calls.push(args[0]); return assets.stat(...args); } };
    const old = { Type: 'Primary', Path: oldPoster, DateModified: '0001-01-01 00:00:00', Width: 0, Height: 0, Blurhash: null };
    const result = await plugin.getMetadata(item, { accessPath: '/images/movie.mkv', containingFolderPath: '/images', imageAssets,
      images: [old], remoteImages: [{ Type: 'Primary', Url: 'https://old.invalid/poster.jpg' }],
      localImageCandidates: [{ Type: 'Primary', Url: oldPoster }] });
    assert.deepEqual(result.Images, []);
    assert.deepEqual(result.RemoteImages, []);
    assert.deepEqual(result.LocalImageCandidates, [{ Url: poster, Type: 'Primary' }]);
    assert.deepEqual(calls, [poster]);
    const images = [{ ...old }], options = structuredClone(sourceOptions);
    assert.equal(await service.importLocalResult({ item, imageAssets }, result, images, options), true);
    assert.deepEqual(images.map(image => [image.Type, image.Path]), [['Primary', poster]]);
    assert.equal(calls.filter(value => value === poster).length, 2);
    assert.equal(calls.filter(value => value === oldPoster).length, 1);
  }
});
