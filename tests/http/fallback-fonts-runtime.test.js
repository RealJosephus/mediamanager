import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('postgres: named encoding updates switch mapped font bytes and empty-path side effects remain unsaved across restart', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const root = path.join(validationOutputRoot(), 'fallback-font-runtime-' + randomUUID()), programDataPath = path.join(root, 'program'),
    configurationDirectoryPath = path.join(root, 'config'), fontA = path.join(programDataPath, 'fonts-A'), fontB = path.join(programDataPath, 'fonts-B');
  for (const directory of [fontA, fontB, configurationDirectoryPath]) await mkdir(directory, { recursive: true });
  const bytesA = Buffer.from('old configured font bytes'), bytesB = Buffer.from('replacement configured font bytes');
  await writeFile(path.join(fontA, 'Shared.TTF'), bytesA); await writeFile(path.join(fontB, 'Shared.TTF'), bytesB);
  await writeFile(path.join(fontB, 'not-a-font.txt'), Buffer.from('arbitrary extension from the configured directory'));
  const encodingFile = path.join(configurationDirectoryPath, 'encoding.xml');
  await writeConfigurationFile(encodingFile, 'encoding', { ...defaultConfiguration('encoding'), FallbackFontPath: fontA,
    EnableFallbackFont: true, SubtitleExtractionTimeoutMinutes: 31, DownMixAudioBoost: 2.75,
    EnableSubtitleExtraction: false, HardwareDecodingCodecs: ['h264', 'vp9'] });
  let database = await createPostgresTestDatabase(null, 'fallback_fonts'), runtime;
  const errors = [];
  const create = () => createTestRuntime({ database, programDataPath, configurationDirectoryPath,
    configuration: { ...defaultConfiguration('server'), UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'fallback-font-runtime', onError: error => errors.push(error) });
  t.after(async () => {
    try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); }
  });
  runtime = await create();
  const apiKey = await runtime.apiKeys.create('Fallback font HTTP configuration and restart');
  const headers = { Authorization: `MediaBrowser Client="Font fixture", Device="Isolated", DeviceId="fallback-font-runtime", Version="1", Token="${apiKey.AccessToken}"` };
  const getOrigin = () => 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
  let origin = getOrigin();
  const getEncoding = async () => {
    const response = await fetch(origin + '/System/Configuration/encoding', { headers }); assert.equal(response.status, 200); return response.json();
  };
  const replace = async value => {
    const response = await fetch(origin + '/System/Configuration/encoding', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 204); assert.equal(await response.text(), '');
  };
  const font = async name => {
    const response = await fetch(origin + '/FallbackFont/Fonts/' + encodeURIComponent(name), { headers });
    assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
  };
  const list = async () => {
    const response = await fetch(origin + '/FallbackFont/Fonts', { headers }); assert.equal(response.status, 200); return response.json();
  };
  const before = await getEncoding(); assert.equal(before.FallbackFontPath, fontA); assert.equal(before.EnableFallbackFont, true);
  assert.equal(before.SubtitleExtractionTimeoutMinutes, 31); assert.equal(before.DownMixAudioBoost, 2.75);
  assert.deepEqual(await font('shared.ttf'), bytesA);
  assert.equal((await list()).find(value => value.Name === 'Shared.TTF')?.Size, bytesA.length);
  const next = { ...before, FallbackFontPath: fontB, SubtitleExtractionTimeoutMinutes: 32 };
  await replace(next); assert.deepEqual(await getEncoding(), next);
  assert.deepEqual(await font('SHARED.ttf'), bytesB);
  assert.deepEqual(await font('NOT-A-FONT.TXT'), Buffer.from('arbitrary extension from the configured directory'));
  assert.equal((await list()).find(value => value.Name === 'Shared.TTF')?.Size, bytesB.length);
  assert.deepEqual(await font('missing.ttf'), Buffer.alloc(0));
  assert.equal((await fetch(origin + '/FallbackFont/Fonts')).status, 401);
  assert.equal((await fetch(origin + '/FallbackFont/Fonts/Shared.TTF')).status, 401);
  const empty = { ...next, FallbackFontPath: '', EnableFallbackFont: true };
  await replace(empty); const persisted = await readFile(encodingFile);
  assert.equal(parseConfigurationXml(persisted, 'encoding').EnableFallbackFont, true);
  assert.deepEqual(await list(), []);
  assert.deepEqual(await getEncoding(), { ...empty, EnableFallbackFont: false });
  assert.deepEqual(await readFile(encodingFile), persisted);
  const schema = database.schemaName; await runtime.close(); runtime = undefined;
  database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); runtime = await create(); origin = getOrigin();
  assert.deepEqual(await getEncoding(), empty);
  assert.deepEqual(await font('Shared.TTF'), Buffer.alloc(0));
  assert.deepEqual(await getEncoding(), { ...empty, EnableFallbackFont: false });
  assert.deepEqual(await readFile(encodingFile), persisted);
  await replace(next); assert.deepEqual(await font('Shared.TTF'), bytesB);
  assert.deepEqual(await readFile(path.join(fontA, 'Shared.TTF')), bytesA); assert.deepEqual(await readFile(path.join(fontB, 'Shared.TTF')), bytesB);
  await runtime.close(); runtime = undefined; assert.deepEqual(errors, []);
});
