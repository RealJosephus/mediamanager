import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { createChannelDynamicImagePlugin } from '../../src/metadata/channel-dynamic-image-provider.js';
import { makeInput } from './fixtures/channels/input.js';
import { hash, errorRecord, comparable, openScenario, observe, plain, observeHttp, removeOwnedDirectory } from './fixtures/channels/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('installed Channel catalog, Features, Views and lazy display match actual native consumers with PostgreSQL and the real SDK host', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const input = makeInput(); input.imageBase64 = (await readFile(new URL('../images/fixtures/http/poster.png', import.meta.url))).toString('base64');
  // This is a fixture document, not a native response: explicit null provider
  // collections must reach both consumers unchanged.
  const bytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'channels-' + randomUUID()); await mkdir(output);
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const privateRoot = path.join(output, 'private'); await mkdir(privateRoot);
  const report = { comparisons: [], differences: [], hardFailures: [], cleanup: {}, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    boundary: { actualNative: ['ChannelManager', 'ChannelsController', 'DtoService', 'UserViewManager', 'ChannelImageProvider', 'MVC binding/authorization/exception middleware'],
      node: ['PostgreSQL catalog query', 'bounded typed cohorts', 'PluginHost/SDK', 'ItemCreationService', 'MetadataRefreshHost', 'HTTP application'],
      controlledNative: ['library lookup', 'repository ID selection', 'creation persistence', 'metadata refresh callback', 'user/user-data lookup', 'empty chapter repository', 'empty physical and user roots'],
      excluded: ['native database queries', 'external item catalog fetch', 'latest execution', 'deletion execution', 'scheduled Channel refresh', 'media execution'] } };
  let current, failure;
  const runCase = (name, options, operation) => t.test(name, options, async () => {
    try { await operation(); }
    catch (error) { report.hardFailures.push({ name, error: errorRecord(error) }); throw error; }
  });
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); }
  };
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Channels/ChannelManager.cs', 'src/Jellyfin.LiveTv/Channels/ChannelImageProvider.cs',
      'Jellyfin.Api/Controllers/ChannelsController.cs', 'Jellyfin.Api/Controllers/UserViewsController.cs', 'Emby.Server.Implementations/Library/UserViewManager.cs',
      'MediaBrowser.Controller/Channels/IChannel.cs', 'MediaBrowser.Controller/Channels/InternalChannelFeatures.cs', 'MediaBrowser.Controller/Channels/Channel.cs',
      'MediaBrowser.Controller/Channels/IDisableMediaSourceDisplay.cs', 'MediaBrowser.Controller/Channels/ISupportsLatestMedia.cs', 'MediaBrowser.Controller/Channels/ISupportsDelete.cs',
      'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
      'Emby.Server.Implementations/Chapters/ChapterManager.cs', 'MediaBrowser.Controller/Persistence/IChapterRepository.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'src/Jellyfin.Drawing/ImageProcessor.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channels/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] });
    assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(bytes)); assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const flag of ['actualChannelManager', 'actualChannelsController', 'actualDtoService', 'actualUserViewManager', 'actualLibraryIdentityAndViewSorter', 'nativeLibraryLookupAndPersistenceControlled', 'nativeMvcBindingExecuted', 'actualChannelImageProvider', 'actualChapterManager', 'actualMediaSourcePathProtocol']) assert.equal(native[flag], true, flag);
    assert.equal(native.EnableCaseSensitiveItemIds, true, 'Both fixture consumers use the actual default case-sensitive Channel identity.');
    for (const flag of ['nativeDatabaseOpened', 'mediaExecutionStarted']) assert.equal(native[flag], false, flag);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    for (const [index, sample] of input.cases.entries()) await runCase(sample.name, { timeout: 240000 }, async () => {
      const expected = native.results[index]; assert.equal(expected.name, sample.name);
      const expectedFailures = { catalog: sample.catalogFail, internalResult: sample.internalFail ?? (sample.query.StartIndex < 0 || sample.query.StartIndex > 0 && !sample.providers.length ? 400
        : sample.catalogFail && sample.user === false && sample.query.IsFavorite != null ? 400 : undefined), allFeatures: sample.featuresFail,
      feature: sample.scalarFail ?? (sample.featuresFail && sample.providers.length === 1 ? sample.featuresFail : undefined), views: sample.viewFail };
      for (const [stage, status] of Object.entries(expectedFailures)) {
        if (!expected[stage]) continue;
        if (status) {
          assert.equal(expected[stage].failure?.status, status, sample.name + ' native ' + stage + ' must observe its declared invalid input');
          if (sample.name.startsWith('explicit null feature collection:') && ['allFeatures', 'feature'].includes(stage)) {
            assert.equal(expected[stage].failure.type, 'NullReferenceException');
            assert.ok(expected[stage].failure.StackTrace.includes('ChannelManager.GetChannelFeaturesDto'));
          }
        }
        else assert.equal(expected[stage].failure, undefined, sample.name + ' native ' + stage + ' must succeed: ' + stringifyNativeJson(expected[stage].failure));
      }
      const fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-' + index));
      let actual;
      try {
        actual = await fixture.observeAll();
        for (const stage of ['internalResult', 'catalog', 'allFeatures', 'feature', 'views']) compare(sample.name + ': ' + stage, plain(comparable(actual[stage])), plain(comparable(expected[stage])));
        compare(sample.name + ': actual create order/fields', fixture.creates, expected.creates);
        compare(sample.name + ': actual refresh order/ForceSave', fixture.refreshes, expected.refreshes);
        compare(sample.name + ': actual provider calls', fixture.calls, expected.calls);
        assert.ok(fixture.pages.every(count => count <= 128), stringifyNativeJson(fixture.pages));
        if (index === 0) {
          assert.equal(native.httpResults.actualMvc, true); assert.equal(native.httpResults.hostStopped, true); assert.equal(native.httpResults.hostDisposed, true);
          const actualHttp = await observeHttp(fixture, input.httpCases), expectedHttp = native.httpResults;
          const wire = result => { const json = result.json && structuredClone(result.json); if (json && !Array.isArray(json)) delete json.traceId;
            return { status: result.status, contentType: result.contentType?.split(';')[0].toLowerCase() ?? null, ...(json ? { json } : { body: result.body }) }; };
          for (const [requestIndex, request] of input.httpCases.entries()) {
            const actualWire = actualHttp.observations[requestIndex], expectedWire = expectedHttp.observations[requestIndex];
            assert.equal(actualWire.path, request.path); assert.equal(expectedWire.path, request.path);
            compare('actual MVC wire: ' + request.name, wire(actualWire), wire(expectedWire));
            const expectedDiagnostic = ({ 'regular cross-user is forbidden': { status: 403, stack: 'src/http/routes.js' },
              'positive offset exact GetRange error': { status: 400, type: 'ArgumentOutOfRangeException', stack: 'src/library/postgres-channel-query.js' },
              'Features empty Guid actual lookup': { status: 400, type: 'ArgumentException', stack: 'LibraryService.withChannelEntity' },
              'Features retained missing Guid': { status: 400, type: 'ArgumentNullException', stack: 'src/library/channel-service.js' } })[request.name];
            if (!expectedDiagnostic) assert.deepEqual(actualWire.diagnostics, [], stringifyNativeJson(actualWire));
            else {
              assert.equal(actualWire.status, expectedWire.status); assert.equal(expectedWire.status, expectedDiagnostic.status);
              assert.equal(actualWire.diagnostics.length, 1, stringifyNativeJson(actualWire));
              const diagnostic = actualWire.diagnostics[0]; assert.equal(diagnostic.status, expectedDiagnostic.status);
              if (expectedDiagnostic.type) { assert.equal(diagnostic.type, expectedDiagnostic.type); assert.ok(expectedWire.diagnostics.some(value => value.type === expectedDiagnostic.type), stringifyNativeJson(expectedWire)); }
              assert.ok(diagnostic.StackTrace.replaceAll('\\', '/').includes(expectedDiagnostic.stack), stringifyNativeJson(diagnostic));
            }
          }
          report.http = { actual: actualHttp, expected: expectedHttp };
        }
        const released = await fixture.released(); assert.deepEqual(fixture.diagnostics, [], stringifyNativeJson(fixture.diagnostics.map(errorRecord)));
        if (sample.name.includes('unsaved warm')) {
          const item = actual.catalog.value.Items.find(value => value.Name === 'Warm unsaved Alpha'); assert.ok(item);
          assert.equal(Object.keys(item.ImageTags).length, 1);
          const stored = (await fixture.database.rows('BaseItems')).find(value => value.Name === 'Saved Alpha'); assert.ok(stored, 'The actual cache consumer must not save the warm edit.');
          assert.equal((await fixture.database.rows('BaseItemImageInfos')).length, 0, 'The warm image is not a repository image.');
        }
        report.comparisons.push({ name: sample.name, expected, actual, creates: fixture.creates, refreshes: fixture.refreshes, calls: fixture.calls, pages: fixture.pages, released });
      } finally { await fixture.close(); }
    });
    for (const [index, sample] of input.displayCases.entries()) await runCase(sample.name, {}, async () => {
      const expected = native.displayResults[index]; assert.equal(expected.name, sample.name);
      if (sample.failure) assert.equal(expected.result.failure?.status, sample.failure);
      else assert.equal(expected.result.value, sample.value);
      const fixture = await openScenario({ ...sample, seeds: [], query: {}, user: false }, { metadataPath: path.join(privateRoot, 'display-' + index), beforeRows: [], userData: [], identities: [] }, path.join(privateRoot, 'display-node-' + index));
      try { const actual = await observe(() => fixture.display(sample, expected)); compare(sample.name, comparable(actual), comparable(expected.result));
        report.comparisons.push({ name: sample.name, expected: expected.result, actual }); await fixture.released(); }
      finally { await fixture.close(); }
    });
    for (const [index, sample] of input.imageCases.entries()) await runCase(sample.name, {}, async () => {
      const expected = native.imageResults[index]; assert.equal(expected.name, sample.name); assert.equal(expected.disposed, sample.supportedImages.length);
      const fixture = await openScenario({ providers: [{ name: 'Images', kind: 'plain', features: {}, recordImages: true,
        supportedImages: sample.supportedImages, imageBase64: input.imageBase64 }], seeds: [], query: {}, user: false },
      { metadataPath: expected.metadataPath, beforeRows: [], identities: [], userData: [] }, path.join(privateRoot, 'image-node-' + index));
      try {
        const item = newNativeItemEntity('MediaBrowser.Controller.Channels.Channel'); item.Id = item.ChannelId = expected.id; item.Name = 'Images';
        item.ImageInfos = sample.existing.map(Type => ({ Type, Path: 'controlled', Width: 64, Height: 32 }));
        const provider = createChannelDynamicImagePlugin({ channels: fixture.channels }).providers[0];
        const supported = await provider.imageTypesFor(item, {}), changed = await provider.hasChanged(item, {}), sources = [];
        for (const type of supported) { const image = await provider.getImage(item, { type }); sources.push({ type, sha256: hash(image.bytes), mimeType: image.mimeType, HasImage: true }); }
        compare(sample.name + ': supported', supported, expected.supported); compare(sample.name + ': monitor', changed, expected.changed);
        compare(sample.name + ': owned original bytes', sources, expected.sources); compare(sample.name + ': callback order', fixture.calls, expected.calls);
        assert.equal(internalImagePath(item, expected.metadataPath), expected.internalPath);
        report.comparisons.push({ name: sample.name, supported, changed, sources, calls: fixture.calls, expected }); await fixture.released();
      } finally { await fixture.close(); }
    });
    assert.deepEqual(report.hardFailures, [], stringifyNativeJson(report.hardFailures));
    assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences)); report.componentAcceptance = true;
  } catch (error) { failure = error; throw error; }
  finally {
    report.failure = failure ? errorRecord(failure) : null;
    const cleanup = [];
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { cleanup.push(error); }
    try { await removeOwnedDirectory(output, privateRoot); report.cleanup.privateInputs = true; } catch (error) { cleanup.push(error); }
    if (cleanup.length) { report.componentAcceptance = false; report.cleanup.errors = cleanup.map(errorRecord); }
    try { await writeFile(path.join(output, 'comparison.json'), stringifyNativeJson(report, 2)); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failure ? [failure, ...cleanup] : cleanup, failure?.message ?? 'Channel component cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
