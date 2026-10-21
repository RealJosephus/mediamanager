import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('application and image caches retain separate mapped storage through runtime startup and close', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-runtime-cache-'));
  let database, runtime;
  try {
    for (const custom of [false, true]) {
      const programDataPath = path.join(root, custom ? 'custom-instance' : 'default-instance');
      const cachePath = custom ? path.join(root, 'application-cache') : path.join(programDataPath, 'cache');
      const imageCachePath = path.join(root, custom ? 'custom-images' : 'default-images');
      const errors = [];
      database = await createPostgresTestDatabase(null, 'runtime_cache');
      runtime = await createRuntime({ database, programDataPath, ...(custom && { cachePath }),
        serverId: 'runtime-cache-test', configuration: { IsStartupWizardCompleted: true },
        imageOptions: { cachePath: imageCachePath }, onError: error => errors.push(error.message) });
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
      assert.deepEqual(errors, []);
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
