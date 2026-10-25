import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readInstanceConfiguration, inspectInstanceConfiguration } from '../../src/configuration.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { parseConfigurationXml, defaultConfiguration } from '../../src/core/configuration-xml.js';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from '../database/postgres-fixture.js';
const failureFields = error => ({ message: error?.message, code: error?.code ?? null,
  status: error?.status ?? error?.statusCode ?? null,
  ...(error?.cause !== undefined && { cause: failureFields(error.cause) }),
  ...(Array.isArray(error?.errors) && { errors: error.errors.map(failureFields) }) });
const errorDiagnostic = error => ({ ...error, ...failureFields(error), name: error?.name, stack: error?.stack });

async function readEncoding(root, onError = () => {}) {
  const store = new NamedConfigurationStore({ configurationDirectoryPath: path.join(root, 'config'), onError });
  try { return await store.getConfiguration('encoding'); }
  finally { await store.close(); }
}

async function instance(t, system, network) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'));
  await mkdir(path.join(root, 'data/data'), { recursive: true });
  await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration>${system}</ServerConfiguration>`);
  await writeFile(path.join(root, 'config/network.xml'), `<NetworkConfiguration>${network}</NetworkConfiguration>`);
  await writeFile(path.join(root, 'data/data/device.txt'), 'a'.repeat(32));
  return root;
}

test('offline configuration inspection preserves original XML bytes, file generation and malformed inputs', async t => {
  const root = await instance(t, '<ServerName>00123</ServerName><Future a="x">before<![CDATA[<value>]]>after</Future>', '<BaseUrl>inspect/</BaseUrl>');
  const files = ['system.xml', 'network.xml'].map(name => path.join(root, 'config', name));
  const before = await Promise.all(files.map(async filename => ({ bytes: await readFile(filename), info: await stat(filename, { bigint: true }) })));
  await Promise.all(files.map(filename => chmod(filename, 0o444)));
  try {
    const settings = await inspectInstanceConfiguration(root); assert.equal(settings.serverName, '00123'); assert.equal(settings.networkConfiguration.BaseUrl, '/inspect');
    for (let index = 0; index < files.length; index++) {
      assert.deepEqual(await readFile(files[index]), before[index].bytes);
      const info = await stat(files[index], { bigint: true }); assert.equal(info.mtimeNs, before[index].info.mtimeNs); assert.equal(info.ino, before[index].info.ino);
    }
  } finally { await Promise.all(files.map(filename => chmod(filename, 0o666))); }
  const malformed = Buffer.from('<broken'); await writeFile(files[0], malformed);
  await assert.rejects(inspectInstanceConfiguration(root)); assert.deepEqual(await readFile(files[0]), malformed);
});

test('native XML string properties retain numeric and boolean text through the real runtime', {
  skip: !postgresTestConnectionString,
}, async t => {
  const root = await instance(t, '<ServerName>00123</ServerName><IsStartupWizardCompleted>1</IsStartupWizardCompleted>' +
    '<CastReceiverApplications><CastReceiverApplication><Id>00042</Id><Name>false</Name></CastReceiverApplication></CastReceiverApplications>' +
    '<SortRemoveWords><string>001</string><string>true</string></SortRemoveWords><MinResumePct>+005</MinResumePct>',
    '<EnableIPv4>1</EnableIPv4><EnableIPv6>0</EnableIPv6><BaseUrl>native/</BaseUrl><LocalNetworkSubnets><string>2130706433</string></LocalNetworkSubnets><InternalHttpPort>0</InternalHttpPort><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses><AutoDiscovery>false</AutoDiscovery>');
  const settings = await readInstanceConfiguration(root);
  assert.equal(settings.configurationDirectoryPath, path.join(root, 'config'));
  assert.equal(settings.dataPath, path.join(root, 'data', 'data'));
  assert.equal(settings.serverName, '00123');
  assert.deepEqual(settings.configuration.CastReceiverApplications, [{ Id: '00042', Name: 'false' }]);
  assert.deepEqual(settings.configuration.SortRemoveWords, ['001', 'true']);
  assert.equal(settings.configuration.MinResumePct, 5);
  assert.equal(settings.networkConfiguration.BaseUrl, '/native');
  assert.equal(settings.networkConfiguration.EnableIPv6, false);
  assert.deepEqual(settings.networkConfiguration.LocalNetworkSubnets, ['2130706433']);
  const database = await createPostgresTestDatabase(null, 'configuration');
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await dropPostgresTestDatabase(database);
  });
  runtime = await createRuntime({ ...settings, database });
  await runtime.start();
  const base = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
  const response = await fetch(base + '/native/System/Info/Public');
  const body = await response.json();
  assert.equal(body.ServerName, '00123');
  assert.equal(body.StartupWizardCompleted, true);
  assert.equal((await fetch(base + '/System/Info/Public')).status, 404);
});

test('native XML validates primitive types and distinguishes missing and empty sort arrays', async t => {
  const root = await instance(t, '<ServerName>test</ServerName><SortRemoveCharacters/>', '<EnableIPv4>true</EnableIPv4>');
  const { configuration } = await readInstanceConfiguration(root);
  assert.equal(configuration.QuickConnectAvailable, true);
  assert.deepEqual(configuration.SortRemoveWords, ['the', 'a', 'an']);
  assert.deepEqual(configuration.SortRemoveCharacters, []);
  for (const body of ['<IsStartupWizardCompleted>True</IsStartupWizardCompleted>', '<MinResumePct>2147483648</MinResumePct>', '<MinResumePct>5.0</MinResumePct>', '<ServerName>broken']) {
    await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration>${body}</ServerConfiguration>`);
    assert.throws(() => parseConfigurationXml(Buffer.from(`<ServerConfiguration>${body}</ServerConfiguration>`), 'server'));
    assert.equal((await readInstanceConfiguration(root)).configuration.IsStartupWizardCompleted, false);
    assert.deepEqual(parseConfigurationXml(await readFile(path.join(root, 'config/system.xml')), 'server'), defaultConfiguration('server'));
  }
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><QuickConnectAvailable>false</QuickConnectAvailable></ServerConfiguration>');
  assert.equal((await readInstanceConfiguration(root)).configuration.QuickConnectAvailable, false);
});

test('server path substitutions normalize missing, single and ordered repeated XML entries', async t => {
  const root = await instance(t, '', '');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.PathSubstitutions, []);
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><PathSubstitutions><PathSubstitution><From>C:\\Media</From><To>/media</To></PathSubstitution></PathSubstitutions></ServerConfiguration>');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.PathSubstitutions, [{ From: 'C:\\Media', To: '/media' }]);
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><PathSubstitutions><PathSubstitution><From>Z:\\First</From><To>/first</To></PathSubstitution><PathSubstitution/><PathSubstitution><From>Z:\\Last</From><To>/last</To></PathSubstitution></PathSubstitutions></ServerConfiguration>');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.PathSubstitutions, [
    { From: 'Z:\\First', To: '/first' }, { From: '', To: '' }, { From: 'Z:\\Last', To: '/last' },
  ]);
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><PathSubstitutions/></ServerConfiguration>');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.PathSubstitutions, []);
});

test('server content types normalize missing, empty, single and ordered repeated XML entries', async t => {
  const root = await instance(t, '', '');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.ContentTypes, []);
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><ContentTypes/></ServerConfiguration>');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.ContentTypes, []);
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><ContentTypes><NameValuePair><Name>/media/movies</Name><Value>movies</Value></NameValuePair></ContentTypes></ServerConfiguration>');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.ContentTypes, [
    { Name: '/media/movies', Value: 'movies' },
  ]);
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><ContentTypes><NameValuePair><Name>/media/home</Name><Value>homevideos</Value></NameValuePair><NameValuePair/><NameValuePair><Name>/media/music</Name><Value>music</Value></NameValuePair></ContentTypes></ServerConfiguration>');
  assert.deepEqual((await readInstanceConfiguration(root)).configuration.ContentTypes, [
    { Name: '/media/home', Value: 'homevideos' }, { Name: null, Value: null }, { Name: '/media/music', Value: 'music' },
  ]);
});

test('configuration XML replays the actual pinned DLL serializer cases', async t => {
  const oracle = JSON.parse(await readFile(new URL('../fixtures/core/configuration-oracle.json', import.meta.url), 'utf8'));
  const root = await instance(t, '', '');
  for (const entry of oracle.cases) {
    await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration>${entry.input}</ServerConfiguration>`);
    if (!entry.accepted) {
      assert.throws(() => parseConfigurationXml(Buffer.from(`<ServerConfiguration>${entry.input}</ServerConfiguration>`), 'server'));
      assert.equal((await readInstanceConfiguration(root)).configuration.IsStartupWizardCompleted, false);
      continue;
    }
    const { configuration } = await readInstanceConfiguration(root);
    for (const [key, expected] of Object.entries(entry)) if (!['input', 'accepted'].includes(key)) assert.deepEqual(configuration[key], expected, key);
  }
  for (const entry of oracle.networks) {
    await writeFile(path.join(root, 'config/network.xml'), `<NetworkConfiguration><BaseUrl>${entry.input}</BaseUrl><EnableIPv4>1</EnableIPv4><EnableIPv6>0</EnableIPv6><LocalNetworkSubnets><string>2130706433</string></LocalNetworkSubnets></NetworkConfiguration>`);
    const { networkConfiguration } = await readInstanceConfiguration(root);
    for (const [key, expected] of Object.entries(entry)) if (key !== 'input') assert.deepEqual(networkConfiguration[key], expected, key);
  }
});

test('encoding XML replays the actual pinned DLL serializer defaults and primitive boundaries', async t => {
  const root = await instance(t, '', '');
  const oracle = JSON.parse(await readFile(new URL('../fixtures/core/encoding-oracle.json', import.meta.url), 'utf8'));
  for (const entry of oracle) {
    const errors = [], original = Buffer.from(`<EncodingOptions>${entry.xml}</EncodingOptions>`);
    let parseFailure;
    if (!entry.accepted) assert.throws(() => parseConfigurationXml(original, 'encoding'),
      error => { parseFailure = error; return true; });
    await writeFile(path.join(root, 'config/encoding.xml'), original);
    const actual = await readEncoding(root, error => errors.push(error));
    if (entry.accepted) {
      assert.deepEqual(actual, { ...defaultConfiguration('encoding'), EnableSegmentDeletion: entry.EnableSegmentDeletion, SegmentKeepSeconds: entry.SegmentKeepSeconds });
      assert.deepEqual(errors, []);
    } else {
      assert.deepEqual(actual, defaultConfiguration('encoding'));
      for (const error of errors) assert.deepEqual(failureFields(error), failureFields(parseFailure),
        'Only the actual rejected input parser boundary may classify its diagnostics.');
    }
    const retained = await readFile(path.join(root, 'config/encoding.xml'));
    assert.deepEqual(retained, original, 'Reading named configuration does not rewrite its source.');
    const coldErrors = [], cold = await readEncoding(root, error => coldErrors.push(error));
    assert.deepEqual(cold, actual);
    if (entry.accepted) assert.deepEqual(coldErrors, []);
    else for (const error of coldErrors) assert.deepEqual(failureFields(error), failureFields(parseFailure),
      'Cold load diagnostics belong to the actual rejected XML input.');
    t.diagnostic(JSON.stringify({ input: original.toString('base64'), retained: retained.toString('base64'),
      parseFailure: parseFailure && errorDiagnostic(parseFailure), errors: errors.map(errorDiagnostic), coldErrors: coldErrors.map(errorDiagnostic) }));
  }
  await writeFile(path.join(root, 'config/encoding.xml'), '<EncodingOptions><AllowOnDemandMetadataBasedKeyframeExtractionForExtensions><string>.mkv</string><string>webm</string></AllowOnDemandMetadataBasedKeyframeExtractionForExtensions></EncodingOptions>');
  assert.deepEqual((await readEncoding(root)).AllowOnDemandMetadataBasedKeyframeExtractionForExtensions, ['.mkv', 'webm']);
});
