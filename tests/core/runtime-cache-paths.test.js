import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import { createTestRuntime } from '../helpers/runtime.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { readConfigurationFile } from '../../src/core/configuration-file.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('application and image caches retain separate mapped storage through runtime startup and close', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-runtime-cache-'));
  let database, runtime;
  try {
    for (const custom of [false, true]) {
      const programDataPath = path.join(root, custom ? 'custom-instance' : 'default-instance');
      const cachePath = custom ? path.join(root, 'application-cache') : path.join(programDataPath, 'cache');
      const imageCachePath = path.join(root, custom ? 'custom-images' : 'default-images');
      const errors = [];
      t.after(() => { t.diagnostic(inspect({ custom, errors }, { depth: null })); });
      database = await createPostgresTestDatabase(null, 'runtime_cache');
      runtime = await createTestRuntime({ database, programDataPath, ...(custom && { cachePath }),
        serverId: 'runtime-cache-test', configuration: { IsStartupWizardCompleted: true },
        imageOptions: { cachePath: imageCachePath }, onError: error => errors.push(error) });
      assert.equal(runtime.plugins.paths.cachePath, cachePath);
      assert.equal(runtime.plugins.paths.imageCachePath, imageCachePath);
      const xmltv = path.join(cachePath, 'xmltv', 'controlled.xml');
      const image = path.join(imageCachePath, 'controlled-image');
      await runtime.fileSystem.mkdir(path.dirname(xmltv), { recursive: true });
      await runtime.fileSystem.writeFile(xmltv, '<tv />');
      await runtime.fileSystem.writeFile(image, 'separate image cache');
      assert.equal(await fs.readFile(xmltv, 'utf8'), '<tv />');
      assert.equal(await fs.readFile(image, 'utf8'), 'separate image cache');
      await assert.rejects(fs.stat(path.join(imageCachePath, 'xmltv', 'controlled.xml')), { code: 'ENOENT' });
      await runtime.close(); runtime = undefined;
      assert.equal(await fs.readFile(xmltv, 'utf8'), '<tv />');
      assert.equal(await fs.readFile(image, 'utf8'), 'separate image cache');
      await dropPostgresTestDatabase(database); database = undefined;
    }
  } finally {
    try { await runtime?.close(); }
    finally {
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mm-runtime-cache-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('configuration HTTP persists complete values and redirects subsequent runtime metadata and cache consumers', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async () => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'runtime-configuration-paths-'));
  const programDataPath = path.join(root, 'program'), metadataPath = path.join(programDataPath, 'next-metadata');
  const cachePath = path.join(programDataPath, 'next-cache'), errors = [], observations = [];
  let database, runtime, closed = false, failure;
  try {
    database = await createPostgresTestDatabase(null, 'runtime_config_paths');
    runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(root, 'config'),
      serverId: 'runtime-configuration-paths', configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true,
        CastReceiverApplications: [{ Id: 'old-receiver', Name: 'Old receiver' }] },
      onError: error => errors.push(error) });
    await runtime.fileSystem.mkdir(metadataPath, { recursive: true });
    await runtime.fileSystem.mkdir(cachePath, { recursive: true });
    await runtime.apiKeys.create('Configuration path consumer');
    const token = (await runtime.apiKeys.list()).Items[0].AccessToken;
    const user = await runtime.users.createUser({ Name: 'Configuration path user' });
    assert.equal(user.Configuration.CastReceiverId, 'old-receiver');
    const call = async (route, value) => {
      const response = await fetch(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}${route}`, {
        headers: { 'X-Emby-Token': token, ...(value !== undefined && { 'Content-Type': 'application/json' }) },
        ...(value !== undefined && { method: 'POST', body: JSON.stringify(value) }),
      });
      const text = await response.text(), contentType = response.headers.get('content-type');
      const result = { route, status: response.status, contentType, text,
        body: contentType?.includes('json') ? JSON.parse(text) : text };
      observations.push(result); return result;
    };
    const before = await call('/System/Configuration'); assert.equal(before.status, 200);
    const next = { ...before.body, ServerName: 'Updated runtime', MetadataPath: metadataPath, CachePath: cachePath,
      PreviousVersion: '4.5.6', CastReceiverApplications: [{ Id: 'next-receiver', Name: 'Next receiver' }] };
    const saved = await call('/System/Configuration', next);
    assert.equal(saved.status, 204); assert.equal(saved.text, '');
    const info = await call('/System/Info');
    assert.equal(info.body.ServerName, next.ServerName); assert.equal(info.body.InternalMetadataPath, metadataPath);
    assert.equal(info.body.CachePath, cachePath);
    const userAfter = await call('/Users/' + user.Id);
    assert.equal(userAfter.status, 200); assert.equal(userAfter.body.Configuration.CastReceiverId, 'next-receiver');
    assert.equal(runtime.library.options.expandPath('%MetadataPath%/child'), metadataPath + '/child');
    assert.equal(runtime.libraryOptionsStore.reversePath(path.join(metadataPath, 'child')), '%MetadataPath%' + path.sep + 'child');
    const studio = await runtime.library.getStudio('Updated metadata studio');
    assert.equal(path.relative(metadataPath, studio.Path).split(path.sep)[0], 'Studio');
    assert.equal((await runtime.fileSystem.stat(studio.Path)).isDirectory(), true);
    const source = path.join(programDataPath, 'data', 'configuration-image.png');
    await runtime.fileSystem.writeFile(source, await fs.readFile(new URL('../images/fixtures/processor/grid.png', import.meta.url)));
    const processed = await runtime.imageProcessor.process({
      image: { Path: source, DateModified: '2024-01-01T00:00:00Z', Width: 20, Height: 12 }, Width: 8,
      Quality: 80, SupportedOutputFormats: ['Png'], assets: new MetadataImageAssets({ fileSystem: runtime.fileSystem, stateRoots: [programDataPath] }),
    });
    assert.equal(processed.original, false);
    assert.equal(path.relative(cachePath, processed.path).split(path.sep)[0], 'images');
    assert.deepEqual(await runtime.fileSystem.readFile(processed.path), processed.bytes);
    assert.match(await fs.readFile(path.join(cachePath, 'CACHEDIR.TAG'), 'utf8'), /^Signature: 8a477f597d28d172789f06886806bc55\n/u);
    const cold = await readConfigurationFile(path.join(root, 'config', 'system.xml'), 'server');
    assert.equal(cold.CachePath, cachePath); assert.equal(cold.MetadataPath, metadataPath); assert.equal(cold.PreviousVersion, '4.5.6');
    // A saved null must remove the old known XML value, and an empty metadata
    // path selects the default. Empty cache configuration retains its active root.
    const cleared = await call('/System/Configuration', { ...next, MetadataPath: '', CachePath: null, PreviousVersion: null });
    assert.equal(cleared.status, 204);
    const clearedInfo = await call('/System/Info');
    assert.equal(clearedInfo.body.InternalMetadataPath, path.join(programDataPath, 'metadata'));
    assert.equal(clearedInfo.body.CachePath, cachePath);
    const clearedConfiguration = await call('/System/Configuration');
    assert.equal(clearedConfiguration.status, 200);
    assert.equal(Object.hasOwn(clearedConfiguration.body, 'PreviousVersion'), false);
    assert.equal(Object.hasOwn(clearedConfiguration.body, 'PreviousVersionStr'), false);
    const reloaded = await readConfigurationFile(path.join(root, 'config', 'system.xml'), 'server');
    assert.equal(reloaded.CachePath, null); assert.equal(reloaded.MetadataPath, '');
    assert.equal(reloaded.PreviousVersionStr, null);
    await runtime.close(); closed = true; runtime = undefined;
  } catch (error) { failure = error; throw error; }
  finally {
    const describeFailure = error => error == null ? null : { message: error.message, code: error.code, status: error.status,
      ...(error.cause !== undefined && { cause: describeFailure(error.cause) }), ...(Array.isArray(error.errors) && { errors: error.errors.map(describeFailure) }) };
    try { await runtime?.close(); if (runtime) closed = true; }
    finally {
      await fs.writeFile(path.join(output, 'runtime-configuration-paths.json'), JSON.stringify({ observations, closed,
        errors: errors.map(describeFailure), failure: describeFailure(failure) }, null, 2) + '\n');
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('runtime-configuration-paths-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
