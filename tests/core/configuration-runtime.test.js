import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { parseConfigurationXml } from './fixtures/configuration/codecs.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { configurationValue, configurationJson } from './fixtures/configuration/observations.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

function encoded(text, encoding) {
  if (encoding.startsWith('utf-16')) {
    const bytes = Buffer.from(text, 'utf16le'); if (encoding === 'utf-16be') bytes.swap16();
    return Buffer.concat([Buffer.from(encoding === 'utf-16be' ? 'feff' : 'fffe', 'hex'), bytes]);
  }
  const points = [...text].map(value => value.codePointAt(0)), bytes = Buffer.alloc((points.length + 1) * 4);
  if (encoding === 'utf-32be') bytes.writeUInt32BE(0xfeff); else bytes.writeUInt32LE(0xfeff);
  points.forEach((point, index) => encoding === 'utf-32be' ? bytes.writeUInt32BE(point, (index + 1) * 4) : bytes.writeUInt32LE(point, (index + 1) * 4));
  return bytes;
}
const xml = (encoding, root, content) => encoded('<?xml version="1.0" encoding="' + encoding + '"?><' + root + '>' + content + '</' + root + '>', encoding);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('postgres: all Unicode configuration encodings feed the real runtime, persist startup changes, restart and accept native continuation', { skip: !postgresTestConnectionString }, async t => {
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'Native configuration continuation requires MEDIAMANAGER_JELLYFIN_DLL and its assembly directory.');
  await fs.access(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const output = path.join(path.resolve(validationOutputRoot()), 'configuration-runtime'); await fs.mkdir(output);
  const consumers = [], observations = [];
  for (const encoding of ['utf-16le', 'utf-16be', 'utf-32le', 'utf-32be']) await t.test(encoding, async t => {
    const root = path.join(output, encoding), config = path.join(root, 'config'), data = path.join(root, 'data'), plugins = path.join(data, 'plugins', 'configurations');
    await fs.mkdir(config, { recursive: true }); await fs.mkdir(path.join(data, 'data'), { recursive: true }); await fs.mkdir(plugins, { recursive: true });
    await fs.writeFile(path.join(data, 'data', 'device.txt'), 'e5500000000000000000000000000001');
    const files = [
      ['server', path.join(config, 'system.xml'), 'ServerConfiguration', '<ServerName>00123 中文</ServerName><UICulture>en-US</UICulture><MetadataPath>&#xA;&#x9;</MetadataPath><CacheSize>2468</CacheSize><MinResumePct>+005</MinResumePct><TrickplayOptions><Interval>123</Interval><WidthResolutions><int>100</int><int>320</int></WidthResolutions></TrickplayOptions>', { ServerName: 'Native continuation' }],
      ['network', path.join(config, 'network.xml'), 'NetworkConfiguration', '<BaseUrl>unicode/</BaseUrl><EnableRemoteAccess>true</EnableRemoteAccess><InternalHttpPort>18888</InternalHttpPort>', { BaseUrl: '/continued' }],
      ['encoding', path.join(config, 'encoding.xml'), 'EncodingOptions', '<EnableSegmentDeletion>true</EnableSegmentDeletion><SegmentKeepSeconds>+0640</SegmentKeepSeconds><DownMixAudioBoost>1E-06</DownMixAudioBoost>', { SegmentKeepSeconds: 641 }],
      ['metadata', path.join(config, 'metadata.xml'), 'MetadataConfiguration', '<UseFileCreationTimeForDateAdded>false</UseFileCreationTimeForDateAdded>', { UseFileCreationTimeForDateAdded: true }],
      ['nfo', path.join(config, 'xbmcmetadata.xml'), 'XbmcMetadataOptions', '<SaveImagePathsInNfo>false</SaveImagePathsInNfo><ReleaseDateFormat>yyyy-MM-dd</ReleaseDateFormat>', { SaveImagePathsInNfo: true }],
      ['branding', path.join(config, 'branding.xml'), 'BrandingOptions', '<CustomCss>café 中文 00123</CustomCss>', { CustomCss: 'Native continued CSS' }],
      ['tmdb', path.join(plugins, 'Jellyfin.Plugin.Tmdb.xml'), 'PluginConfiguration', '<IncludeAdult>true</IncludeAdult><MaxCastMembers>4</MaxCastMembers>', { MaxCastMembers: 7 }],
    ];
    for (const [, filename, element, contents] of files) await fs.writeFile(filename, xml(encoding, element, contents));
    const pluginBefore = await Promise.all(files.filter(row => ['tmdb'].includes(row[0])).map(row => fs.readFile(row[1])));
    const errors = [], settings = await readInstanceConfiguration(root, { onError: error => errors.push(error.message) });
    assert.equal(settings.metadataPath, path.join(data, 'metadata')); assert.equal(settings.configuration.CacheSize, 2468);
    assert.equal(settings.configuration.TrickplayOptions.Interval, 123); assert.deepEqual(settings.configuration.TrickplayOptions.WidthResolutions, [100, 320]);
    let database = await createPostgresTestDatabase(null, 'config_runtime'), runtime;
    t.after(async () => { await runtime?.close(); await dropPostgresTestDatabase(database); });
    runtime = await createRuntime({ ...settings, database, onError: error => errors.push(error.message) });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}/unicode`;
    assert.equal((await (await fetch(origin + '/System/Info/Public')).json()).ServerName, '00123 中文');
    assert.equal(await (await fetch(origin + '/Branding/Css')).text(), 'café 中文 00123');
    assert.equal(runtime.plugins.get('tmdb').effectiveConfiguration.IncludeAdult, true); assert.equal(runtime.plugins.get('tmdb').effectiveConfiguration.MaxCastMembers, 4);
    const response = await fetch(origin + '/Startup/Configuration', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UICulture: 'en-GB', MetadataCountryCode: 'TW', PreferredMetadataLanguage: 'zh' }) });
    assert.equal(response.status, 204); await runtime.close();
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    const reopened = await readInstanceConfiguration(root); runtime = await createRuntime({ ...reopened, database, onError: error => errors.push(error.message) });
    assert.equal(runtime.configuration.UICulture, 'en-GB'); assert.equal(runtime.configuration.PreferredMetadataLanguage, 'zh');
    assert.equal(runtime.configuration.NetworkConfiguration.InternalHttpPort, 18888);
    assert.deepEqual(await Promise.all(files.filter(row => ['tmdb'].includes(row[0])).map(row => fs.readFile(row[1]))), pluginBefore);
    assert.deepEqual(errors, []); await runtime.close();
    for (const [kind, filename, , , changes] of files) {
      consumers.push({ name: encoding + '-' + kind, root: kind, filename, changes });
      const bytes = await fs.readFile(filename); observations.push({ name: encoding + '-' + kind, root: kind, value: parseConfigurationXml(bytes, kind), sha256: hash(bytes) });
    }
  });
  const inputFile = path.join(output, 'native-input.json'); await fs.writeFile(inputFile, configurationJson(consumers), { flag: 'wx' });
  const recording = await recordOracle({ project: 'tests/core/fixtures/configuration/Oracle.csproj', output: path.join(output, 'native-continuation'), args: ['consume', inputFile, '{output}/native.json'] });
  const returned = parseLosslessJson((await fs.readFile(path.join(output, 'native-continuation', 'native.json'))).toString('utf8'));
  await fs.writeFile(path.join(output, 'proof.json'), configurationJson({ recording, observations, actualNativeReadAndWrite: true }), { flag: 'wx' });
  assert.equal(returned.actualXmlSerializer, true); assert.equal(returned.actualContinuedWrite, true); assert.equal(returned.results.length, 28);
  for (const sample of consumers) {
    const row = returned.results.find(row => row.name === sample.name); assert.equal(row.accepted, true, sample.name);
    assert.deepEqual(configurationValue(row.value, row.root), observations.find(value => value.name === sample.name).value, sample.name);
    const bytes = await fs.readFile(sample.filename); assert.deepEqual(parseConfigurationXml(bytes, sample.root), configurationValue(row.reread, row.root), sample.name);
    for (const [name, value] of Object.entries(sample.changes)) assert.equal(parseConfigurationXml(bytes, sample.root)[name], value, sample.name + '.' + name);
  }
});
