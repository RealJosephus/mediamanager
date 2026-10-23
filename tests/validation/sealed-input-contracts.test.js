import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureInputIdentity, executionManifestContract, executionManifestReferences } from '../../tools/validation/inputs.js';
import { dependencyClosure, inventory } from '../../tools/validation/inventory.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

const entry = (filename, imports = []) => ({ path: filename, test: filename.endsWith('.test.js'), imports,
  importedFiles: [], declaredReferences: [], fixtureReferences: [], services: [], tools: [], unresolvedImports: [] });

function describedPaths(entry, filename = entry.filename) {
  return [filename, ...(entry.kind === 'directory' ? entry.entries.flatMap(child => describedPaths(child, path.join(filename, child.name))) : [])];
}

async function assertOracleSourcesProfiled(profile, profileFilename) {
  const root = path.dirname(profileFilename);
  const project = profile.inputs.find(input => input.role === 'oracleProject');
  assert.ok(project, 'current profile must identify its oracle project');
  const directory = path.dirname(path.resolve(root, project.filename));
  const enumerated = (await readdir(directory)).filter(name => name.endsWith('.cs')).sort();
  const profiled = profile.inputs.map(input => path.resolve(root, input.filename))
    .filter(filename => path.dirname(filename) === directory && filename.endsWith('.cs'))
    .map(filename => path.basename(filename)).sort();
  assert.deepEqual(profiled, enumerated, 'every automatically enumerated oracle source must be profile-pinned');
}

test('metadata search uses a tracked current profile and same-run Native reference instead of historical execution paths', async t => {
  const consumer = 'tests/metadata/search-lookup.test.js', contract = executionManifestContract(consumer);
  assert.deepEqual(contract, { kind: 'current-oracle',
    manifest: 'tests/metadata/fixtures/metadata-search-lookup/current-profile.json', loader: consumer });
  const profileFilename = path.join(repositoryRoot, contract.manifest);
  const profile = JSON.parse(await readFile(profileFilename, 'utf8'));
  assert.equal(profile.schemaVersion, 1);
  await assertOracleSourcesProfiled(profile, profileFilename);
  const references = executionManifestReferences(contract, profile, profileFilename);
  assert.deepEqual(references.map(reference => path.relative(repositoryRoot, reference.filename).replaceAll('\\', '/')).sort(), [
    'tests/Directory.Build.props',
    'tests/metadata/fixtures/metadata-search-lookup/Oracle.csproj',
    'tests/metadata/fixtures/metadata-search-lookup/Program.cs',
    'tests/metadata/fixtures/metadata-search-lookup/input.json',
  ]);
  assert.ok(references.every(reference => /^[a-f0-9]{64}$/u.test(reference.sha256)));

  const dependencies = await inventory(), closure = dependencyClosure(dependencies, [consumer]);
  const testEntry = closure.find(value => value.path === consumer);
  assert.deepEqual(testEntry.services, ['dotnet', 'jellyfinDll', 'postgres']);
  for (const filename of ['tests/helpers/current-oracle.js', 'tools/validation/oracle.js']) {
    assert.ok(closure.some(value => value.path === filename), filename);
  }

  const suppliedRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-search-current-'));
  t.after(() => rm(suppliedRoot, { recursive: true, force: true }));
  for (const directory of ['host', 'shared', 'sdk', 'runtime']) await mkdir(path.join(suppliedRoot, directory));
  const dotnet = path.join(suppliedRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const jellyfinDll = path.join(suppliedRoot, 'runtime', 'jellyfin.dll');
  await writeFile(dotnet, 'same-run dotnet identity');
  await writeFile(jellyfinDll, 'same-run designated Native identity');
  const identity = await captureInputIdentity({ selected: [consumer], dependencies, environment: {},
    preflight: { ready: true, services: [
      { name: 'postgres', available: true, version: 'PostgreSQL 17' },
      { name: 'dotnet', filename: dotnet }, { name: 'jellyfinDll', filename: jellyfinDll },
    ], tools: [] } });
  assert.equal(identity.currentReleaseInputReady, true);
  assert.ok(identity.services.some(service => service.name === 'postgres' && service.available === true));
  const required = filename => {
    const found = identity.entries.find(value => value.filename === filename);
    assert.ok(found?.required, filename);
    return found;
  };
  required(profileFilename);
  for (const reference of references) {
    const found = required(reference.filename);
    assert.ok(found.expectedDigests.includes(reference.sha256), reference.filename);
    assert.equal(found.expectedDigestMatched, true, reference.filename);
    assert.equal(found.bytes, reference.bytes, reference.filename);
  }
  assert.ok(required(dotnet).requiredReasons.includes('service:dotnet'));
  assert.ok(required(jellyfinDll).requiredReasons.includes('service:jellyfinDll'));
  assert.deepEqual(identity.entries.filter(value => value.requiredReasons.some(reason => reason.startsWith(consumer + ':'))
    && path.relative(repositoryRoot, value.filename).replaceAll('\\', '/').startsWith('../')), []);
  assert.ok(!identity.entries.some(value => /(?:mediamanager-validation|[\\/]\.tools[\\/]dotnet|[\\/]jellyfin[\\/]MediaBrowser\.)/iu.test(value.filename)));
  for (const filename of ['native.json', 'provenance.json']) {
    const historical = path.join(path.dirname(profileFilename), filename);
    assert.ok(!identity.entries.flatMap(value => describedPaths(value)).includes(historical));
  }
  const archiveProfile = identity.historicalArchive.profiles.find(value => value.id === 'search-lookup-sources');
  assert.equal(archiveProfile?.disposition, 'current-identity');
  assert.ok(['complete', 'incomplete'].includes(archiveProfile?.archiveStatus));
});

test('parental-rating core and PostgreSQL consumers share one tracked current Native profile without historical execution paths', async t => {
  const cases = [
    'tests/core/parental-rating-unicode.test.js',
    'tests/database/postgres-rating-unicode.test.js',
  ];
  const manifest = 'tests/core/fixtures/parental-rating-unicode/current-profile.json';
  const expectedReferences = [
    'tests/Directory.Build.props',
    'tests/core/fixtures/parental-rating-unicode/current/Oracle.csproj',
    'tests/core/fixtures/parental-rating-unicode/current/Program.cs',
    'tests/core/fixtures/parental-rating-unicode/input.json',
  ];
  const dependencies = await inventory();
  const suppliedRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-rating-current-'));
  t.after(() => rm(suppliedRoot, { recursive: true, force: true }));
  for (const directory of ['host', 'shared', 'sdk', 'runtime']) await mkdir(path.join(suppliedRoot, directory));
  const dotnet = path.join(suppliedRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const jellyfinDll = path.join(suppliedRoot, 'runtime', 'jellyfin.dll');
  await writeFile(dotnet, 'same-run dotnet identity');
  await writeFile(jellyfinDll, 'same-run designated Native identity');
  const services = [{ name: 'postgres', available: true, version: 'PostgreSQL 17' },
    { name: 'dotnet', filename: dotnet }, { name: 'jellyfinDll', filename: jellyfinDll }];
  for (const consumer of cases) await t.test(consumer, async () => {
    const contract = executionManifestContract(consumer);
    assert.deepEqual(contract, { kind: 'current-oracle', manifest, loader: consumer });
    const profileFilename = path.join(repositoryRoot, contract.manifest);
    const profile = JSON.parse(await readFile(profileFilename, 'utf8'));
    assert.equal(profile.schemaVersion, 1);
    await assertOracleSourcesProfiled(profile, profileFilename);
    const references = executionManifestReferences(contract, profile, profileFilename);
    assert.deepEqual(references.map(reference => path.relative(repositoryRoot, reference.filename).replaceAll('\\', '/')).sort(),
      expectedReferences);
    const closure = dependencyClosure(dependencies, [consumer]);
    assert.deepEqual(closure.find(value => value.path === consumer).services, ['dotnet', 'jellyfinDll', 'postgres']);
    for (const filename of ['tests/core/parental-rating-unicode-fixture.js', 'tests/helpers/current-oracle.js',
      'tools/validation/oracle.js']) assert.ok(closure.some(value => value.path === filename), filename);
    const identity = await captureInputIdentity({ selected: [consumer], dependencies, environment: {},
      preflight: { ready: true, services, tools: [] } });
    assert.equal(identity.currentReleaseInputReady, true);
    const required = filename => {
      const found = identity.entries.find(value => value.filename === filename);
      assert.ok(found?.required, filename);
      return found;
    };
    required(profileFilename);
    for (const reference of references) {
      const found = required(reference.filename);
      assert.ok(found.expectedDigests.includes(reference.sha256), reference.filename);
      assert.equal(found.expectedDigestMatched, true, reference.filename);
      assert.equal(found.bytes, reference.bytes, reference.filename);
    }
    assert.ok(required(dotnet).requiredReasons.includes('service:dotnet'));
    assert.ok(required(jellyfinDll).requiredReasons.includes('service:jellyfinDll'));
    assert.deepEqual(identity.entries.filter(value => value.requiredReasons.some(reason => reason.startsWith(consumer + ':'))
      && path.relative(repositoryRoot, value.filename).replaceAll('\\', '/').startsWith('../')), []);
    assert.ok(!identity.entries.some(value => /(?:mediamanager-validation|[\\/]\.tools[\\/]dotnet|[\\/]jellyfin[\\/]MediaBrowser\.)/iu
      .test(value.filename)));
    for (const filename of ['native.json', 'provenance.json']) {
      const historical = path.join(path.dirname(profileFilename), filename);
      assert.ok(!identity.entries.flatMap(value => describedPaths(value)).includes(historical));
    }
    const archiveProfile = identity.historicalArchive.profiles.find(value => value.id === 'sealed-rating');
    assert.equal(archiveProfile?.disposition, 'current-identity');
    assert.ok(['complete', 'incomplete'].includes(archiveProfile?.archiveStatus));
  });
});

test('password reset PIN files use a tracked same-run Node-to-Native public-provider identity', async t => {
  const consumer = 'tests/http/password-reset-consumer.test.js';
  const manifest = 'tests/http/fixtures/password-reset/current-profile.json';
  const expectedReferences = [
    'tests/Directory.Build.props',
    'tests/http/fixtures/password-reset/current-input.json',
    'tests/http/fixtures/password-reset/current/Oracle.csproj',
    'tests/http/fixtures/password-reset/current/Program.cs',
  ];
  const contract = executionManifestContract(consumer);
  assert.deepEqual(contract, { kind: 'current-oracle', manifest, loader: consumer });
  const profileFilename = path.join(repositoryRoot, manifest);
  const profile = JSON.parse(await readFile(profileFilename, 'utf8'));
  assert.equal(profile.schemaVersion, 1);
  await assertOracleSourcesProfiled(profile, profileFilename);
  const references = executionManifestReferences(contract, profile, profileFilename);
  assert.deepEqual(references.map(reference => path.relative(repositoryRoot, reference.filename).replaceAll('\\', '/')).sort(),
    expectedReferences);
  const dependencies = await inventory();
  const closure = dependencyClosure(dependencies, [consumer]);
  assert.deepEqual(closure.find(value => value.path === consumer).services, ['dotnet', 'jellyfinDll']);
  for (const filename of ['src/users/password-reset-service.js', 'tools/validation/oracle.js']) {
    assert.ok(closure.some(value => value.path === filename), filename);
  }
  const suppliedRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-password-reader-current-'));
  t.after(() => rm(suppliedRoot, { recursive: true, force: true }));
  for (const directory of ['host', 'shared', 'sdk', 'runtime']) await mkdir(path.join(suppliedRoot, directory));
  const dotnet = path.join(suppliedRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const jellyfinDll = path.join(suppliedRoot, 'runtime', 'jellyfin.dll');
  await writeFile(dotnet, 'same-run dotnet identity');
  await writeFile(jellyfinDll, 'same-run designated Native identity');
  const services = [{ name: 'dotnet', filename: dotnet }, { name: 'jellyfinDll', filename: jellyfinDll }];
  const identity = await captureInputIdentity({ selected: [consumer], dependencies, environment: {},
    preflight: { ready: true, services, tools: [] } });
  assert.equal(identity.currentReleaseInputReady, true);
  const required = filename => {
    const found = identity.entries.find(value => value.filename === filename);
    assert.ok(found?.required, filename);
    return found;
  };
  required(profileFilename);
  for (const reference of references) {
    const found = required(reference.filename);
    assert.ok(found.expectedDigests.includes(reference.sha256), reference.filename);
    assert.equal(found.expectedDigestMatched, true, reference.filename);
    assert.equal(found.bytes, reference.bytes, reference.filename);
  }
  assert.ok(required(dotnet).requiredReasons.includes('service:dotnet'));
  assert.ok(required(jellyfinDll).requiredReasons.includes('service:jellyfinDll'));
  assert.deepEqual(identity.entries.filter(value => value.requiredReasons.some(reason => reason.startsWith(consumer + ':'))
    && path.relative(repositoryRoot, value.filename).replaceAll('\\', '/').startsWith('../')), []);
  assert.ok(!identity.entries.some(value => /(?:mediamanager-validation|[\\/]\.tools[\\/]dotnet|[\\/]jellyfin[\\/]MediaBrowser\.)/iu
    .test(value.filename)));
  const historical = ['consumer.json', 'provenance.json', 'native.json', 'input.json', 'required-inputs.json',
    'Program.cs', 'Oracle.csproj', 'observations.js'].map(filename => path.join(path.dirname(profileFilename), filename));
  const described = identity.entries.flatMap(value => describedPaths(value));
  for (const filename of historical) assert.ok(!described.includes(filename), filename);
  const archiveProfile = identity.historicalArchive.profiles.find(value => value.id === 'password-reader');
  assert.equal(archiveProfile?.disposition, 'current-identity');
  assert.ok(['complete', 'incomplete'].includes(archiveProfile?.archiveStatus));
});

for (const [consumer, fixture, services, archiveId, inputPath = 'input.json', additionalInputs = [], oraclePath = 'current/'] of [
  ['tests/http/startup.test.js', 'tests/http/fixtures/startup', ['dotnet', 'jellyfinDll', 'postgres'], 'sealed-startup'],
  ['tests/core/native-charset.test.js', 'tests/core/fixtures/native-charset', ['dotnet', 'jellyfinDll'], 'sealed-charset'],
  ['tests/core/native-json-encoder.test.js', 'tests/core/fixtures/native-json-encoder', ['dotnet', 'jellyfinDll'], 'sealed-json'],
  ['tests/library/collection-playlist-resolution.test.js', 'tests/library/fixtures/collection-playlist-resolution',
    ['dotnet', 'jellyfinDll', 'postgres'], 'sealed-collection-playlist', 'current/input.json'],
  ['tests/library/native-item-cache.test.js', 'tests/library/fixtures/native-item-cache',
    ['dotnet', 'jellyfinDll', 'postgres'], 'sealed-warm'],
  ['tests/library/warm-item-deletion.test.js', 'tests/library/fixtures/warm-item-deletion',
    ['dotnet', 'jellyfinDll', 'postgres'], 'sealed-warm'],
  ['tests/http/warm-item-deletion.test.js', 'tests/http/fixtures/warm-item-deletion',
    ['dotnet', 'jellyfinDll', 'postgres'], 'sealed-warm'],
  ['tests/metadata/nfo-partial-reader.test.js', 'tests/metadata/fixtures/nfo-partial-reader',
    ['dotnet', 'jellyfinDll'], 'nfo-repeats', 'current/input.json'],
  ['tests/metadata/nfo-scalar-provider.test.js', 'tests/metadata/fixtures/nfo-scalar-provider',
    ['dotnet', 'jellyfinDll'], 'nfo-repeats', 'current/input.json', ['current/layout-input.json']],
  ['tests/consumer-contracts/consumer-readers.test.js', 'tests/consumer-contracts/fixtures/readers',
    ['dotnet', 'jellyfinDll'], null, 'current/input.json', ['current/writer-input.json', 'current/timestamp-map-input.json']],
  ['tests/metadata/local-xml-stream.test.js', 'tests/metadata/fixtures/local-xml-save-current',
    ['dotnet', 'jellyfinDll'], null, 'input.json', [], ''],
  ['tests/library/movie-similar.test.js', 'tests/library/fixtures/movie-similar',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'current/input.json'],
  ['tests/core/server-identity.test.js', 'tests/core/fixtures/server-identity',
    ['dotnet', 'jellyfinDll'], null, 'current/input.json', ['current-consumer/Program.cs', 'current-consumer/Oracle.csproj',
      'current/FileSharingProbe.cs', 'current/observations.js', '../../native-file-holder.js']],
  ['tests/core/server-identity-runtime.test.js', 'tests/core/fixtures/server-identity',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'current/input.json', ['current-consumer/Program.cs', 'current-consumer/Oracle.csproj',
      'current/FileSharingProbe.cs', 'current/observations.js', '../../native-file-holder.js']],
  ['tests/users/native-guid-contract.test.js', 'tests/users/fixtures/guid-contract',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'current/input.json'],
  ['tests/core/configuration-xml.test.js', 'tests/core/fixtures/configuration',
    ['dotnet', 'jellyfinDll'], null, 'current/input.json', ['current/FileSharingProbe.cs', '../../native-file-holder.js']],
  ['tests/core/configuration-file.test.js', 'tests/core/fixtures/configuration',
    ['dotnet', 'jellyfinDll'], null, 'current/input.json', ['current/FileSharingProbe.cs', '../../native-file-holder.js']],
  ['tests/core/configuration-runtime.test.js', 'tests/core/fixtures/configuration',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'current/input.json', ['current/FileSharingProbe.cs', '../../native-file-holder.js']],
  ['tests/http/api-keys.test.js', 'tests/http/fixtures/api-keys',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'current/input.json'],
  ['tests/http/password-reset.test.js', 'tests/http/fixtures/password-reset-http-current',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'input.json', ['observations.js'], ''],
  ['tests/http/quick-connect.test.js', 'tests/http/fixtures/quick-connect-current',
    ['dotnet', 'jellyfinDll'], null, 'input.json', ['Direct.cs'], ''],
  ['tests/http/quick-connect-runtime.test.js', 'tests/http/fixtures/quick-connect-current',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'input.json', ['Direct.cs'], ''],
  ['tests/metadata/playlist-items.test.js', 'tests/metadata/fixtures/playlist-items-current',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'input.json', [], ''],
  ['tests/metadata/local-xml-provider.test.js', 'tests/metadata/fixtures/local-xml-provider',
    ['dotnet', 'jellyfinDll', 'postgres'], null, 'current/input.json', ['current/layout-input.json', 'current/layout-comparison.json']],
  ['tests/metadata/nfo-episode-blocks.test.js', 'tests/metadata/fixtures/nfo-episode-blocks',
    ['dotnet', 'jellyfinDll'], null, 'current/input.json', ['current/layout-input.json', 'current/layout-comparison.json']],
  ['tests/consumer-contracts/date-roundtrip.test.js', 'tests/consumer-contracts/fixtures/date-roundtrip-current',
    ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'], null, 'input.json',
    ['node-host.js', 'scenario.js', '../../../images/fixtures/processor/single.png'], ''],
]) test(`${archiveId ?? fixture} current readers bind scenarios without acquiring the historical recording`, async t => {
  const manifest = fixture + '/current-profile.json';
  const contract = executionManifestContract(consumer);
  assert.deepEqual(contract, { kind: 'current-oracle', manifest, loader: consumer });
  const profileFilename = path.join(repositoryRoot, manifest);
  const profile = JSON.parse(await readFile(profileFilename, 'utf8'));
  await assertOracleSourcesProfiled(profile, profileFilename);
  const references = executionManifestReferences(contract, profile, profileFilename);
  assert.deepEqual(references.map(value => path.relative(repositoryRoot, value.filename).replaceAll('\\', '/')).sort(), [
    'tests/Directory.Build.props', fixture + '/' + oraclePath + 'Oracle.csproj', fixture + '/' + oraclePath + 'Program.cs', fixture + '/' + inputPath,
    ...additionalInputs.map(filename => fixture + '/' + filename),
  ].map(filename => path.posix.normalize(filename)).sort());
  const dependencies = await inventory(), closure = dependencyClosure(dependencies, [consumer]);
  assert.deepEqual(closure.find(value => value.path === consumer).services, services);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-reader-current-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['host', 'shared', 'sdk', 'runtime']) await mkdir(path.join(root, directory));
  const dotnet = path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const jellyfinDll = path.join(root, 'runtime', 'jellyfin.dll');
  await writeFile(dotnet, 'same-run dotnet identity');
  await writeFile(jellyfinDll, 'same-run designated Native identity');
  const identity = await captureInputIdentity({ selected: [consumer], dependencies, environment: {},
    preflight: { ready: true, tools: [], services: [{ name: 'postgres', available: true, version: 'PostgreSQL 17' },
      { name: 'dotnet', filename: dotnet }, { name: 'jellyfinDll', filename: jellyfinDll }] } });
  assert.equal(identity.currentReleaseInputReady, true);
  for (const reference of references) {
    const found = identity.entries.find(value => value.filename === reference.filename);
    assert.ok(found?.required && found.expectedDigestMatched, reference.filename);
    assert.ok(found.expectedDigests.includes(reference.sha256), reference.filename);
  }
  const described = identity.entries.flatMap(value => describedPaths(value));
  for (const filename of ['native.json', 'provenance.json', ...(oraclePath ? ['Program.cs', 'Oracle.csproj'] : [])]) {
    assert.ok(!described.includes(path.join(path.dirname(profileFilename), filename)), filename);
  }
  if (archiveId) assert.equal(identity.historicalArchive.profiles.find(value => value.id === archiveId)?.disposition, 'current-identity');
});

test('deletion HTTP, PostgreSQL and DTO consumers use tracked current profiles without historical execution paths', async t => {
  const cases = [{
    consumer: 'tests/http/item-deletion.test.js',
    manifest: 'tests/http/fixtures/item-deletion/current-profile.json',
    services: ['dotnet', 'jellyfinDll'],
    references: [
      'tests/Directory.Build.props',
      'tests/http/fixtures/item-deletion/Oracle.csproj',
      'tests/http/fixtures/item-deletion/Program.cs',
      'tests/http/fixtures/item-deletion/input.json',
    ],
  }, {
    consumer: 'tests/http/item-deletion-postgres.test.js',
    manifest: 'tests/http/fixtures/item-deletion/current-profile.json',
    services: ['dotnet', 'jellyfinDll', 'postgres'],
    references: [
      'tests/Directory.Build.props',
      'tests/http/fixtures/item-deletion/Oracle.csproj',
      'tests/http/fixtures/item-deletion/Program.cs',
      'tests/http/fixtures/item-deletion/input.json',
    ],
  }, {
    consumer: 'tests/library/delete-dto-permission.test.js',
    manifest: 'tests/library/fixtures/delete-dto-permission/current-profile.json',
    services: ['dotnet', 'jellyfinDll'],
    references: [
      'tests/Directory.Build.props',
      'tests/library/fixtures/delete-dto-permission/Controls.cs',
      'tests/library/fixtures/delete-dto-permission/CurrentOracle.csproj',
      'tests/library/fixtures/delete-dto-permission/Program.cs',
      'tests/library/fixtures/delete-dto-permission/input.json',
    ],
  }];
  const dependencies = await inventory();
  const suppliedRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-delete-current-'));
  t.after(() => rm(suppliedRoot, { recursive: true, force: true }));
  for (const directory of ['host', 'shared', 'sdk', 'runtime']) await mkdir(path.join(suppliedRoot, directory));
  const dotnet = path.join(suppliedRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const jellyfinDll = path.join(suppliedRoot, 'runtime', 'jellyfin.dll');
  await writeFile(dotnet, 'same-run dotnet identity');
  await writeFile(jellyfinDll, 'same-run designated Native identity');
  const services = [{ name: 'postgres', available: true, version: 'PostgreSQL 17' },
    { name: 'dotnet', filename: dotnet }, { name: 'jellyfinDll', filename: jellyfinDll }];
  for (const expected of cases) await t.test(expected.consumer, async () => {
    const contract = executionManifestContract(expected.consumer);
    assert.deepEqual(contract, { kind: 'current-oracle', manifest: expected.manifest, loader: expected.consumer });
    const profileFilename = path.join(repositoryRoot, contract.manifest);
    const profile = JSON.parse(await readFile(profileFilename, 'utf8'));
    assert.equal(profile.schemaVersion, 1);
    await assertOracleSourcesProfiled(profile, profileFilename);
    const references = executionManifestReferences(contract, profile, profileFilename);
    assert.deepEqual(references.map(reference => path.relative(repositoryRoot, reference.filename).replaceAll('\\', '/')).sort(),
      expected.references);
    const closure = dependencyClosure(dependencies, [expected.consumer]);
    assert.deepEqual(closure.find(value => value.path === expected.consumer).services, expected.services);
    for (const filename of ['tests/helpers/current-oracle.js', 'tools/validation/oracle.js']) {
      assert.ok(closure.some(value => value.path === filename), filename);
    }
    const identity = await captureInputIdentity({ selected: [expected.consumer], dependencies, environment: {},
      preflight: { ready: true, services, tools: [] } });
    assert.equal(identity.currentReleaseInputReady, true);
    const required = filename => {
      const found = identity.entries.find(value => value.filename === filename);
      assert.ok(found?.required, filename);
      return found;
    };
    required(profileFilename);
    for (const reference of references) {
      const found = required(reference.filename);
      assert.ok(found.expectedDigests.includes(reference.sha256), reference.filename);
      assert.equal(found.expectedDigestMatched, true, reference.filename);
      assert.equal(found.bytes, reference.bytes, reference.filename);
    }
    assert.ok(required(dotnet).requiredReasons.includes('service:dotnet'));
    assert.ok(required(jellyfinDll).requiredReasons.includes('service:jellyfinDll'));
    assert.deepEqual(identity.entries.filter(value => value.requiredReasons
      .some(reason => reason.startsWith(expected.consumer + ':'))
      && path.relative(repositoryRoot, value.filename).replaceAll('\\', '/').startsWith('../')), []);
    assert.ok(!identity.entries.some(value => /(?:mediamanager-validation|[\\/]\.tools[\\/]dotnet)/iu.test(value.filename)));
    for (const filename of ['native.json', 'provenance.json']) {
      const historical = path.join(path.dirname(profileFilename), filename);
      assert.ok(!identity.entries.flatMap(value => describedPaths(value)).includes(historical));
    }
    const historicalId = expected.consumer.startsWith('tests/http/') ? 'sealed-http-delete' : 'sealed-delete-dto';
    const archiveProfile = identity.historicalArchive.profiles.find(value => value.id === historicalId);
    assert.equal(archiveProfile?.disposition, 'current-identity');
    assert.ok(['complete', 'incomplete'].includes(archiveProfile?.archiveStatus));
  });
});

