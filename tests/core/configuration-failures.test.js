import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { loadConfigurationFile, serializeConfiguration } from '../../src/core/configuration-file.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

const settings = { timeout: 30000 };
const metadata = value => ({ ...defaultConfiguration('metadata'), UseFileCreationTimeForDateAdded: value });
const describe = (value, diagnostic = false) => value == null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(entry => describe(entry, diagnostic))
  : Object.fromEntries(Object.getOwnPropertyNames(value)
    .filter(key => diagnostic || !(value instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, describe(value[key], diagnostic)]));
const failures = () => [
  ['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined],
  ['error', Object.assign(new Error('Controlled configuration storage failure.'), {
    code: 'CONFIG_IO', status: 507, statusCode: 507, cause: false, errors: [0, '', null, undefined],
    details: { name: 'configuration value', stack: 'business storage context', optional: undefined },
  })],
  ['value', { name: 'configuration source', stack: 'business failure context', code: 'CONFIG_VALUE',
    message: 'Controlled configuration storage value.', status: 502, cause: null, optional: undefined }],
];

async function rejection(operation, expected, report) {
  let rejected = false;
  try { await operation(); }
  catch (error) {
    rejected = true; report.failure = { type: typeof error, value: describe(error, true) };
    assert.deepEqual(describe(error), describe(expected));
  }
  assert.equal(rejected, true, 'The controlled storage operation must reject.');
}

async function fixture(t, label, work) {
  await fs.mkdir(validationOutputRoot(), { recursive: true });
  const root = await fs.mkdtemp(path.join(validationOutputRoot(), 'configuration-failure-'));
  assertValidationOutputChild(root);
  const directory = path.join(root, 'config'); await fs.mkdir(directory);
  const filename = path.join(directory, 'metadata.xml'), stores = [];
  const report = { label, diagnostics: [], files: [], handles: [], closed: false,
    scope: 'Actual local configuration files, original storage reasons, durable prefixes and fresh lazy reads.' };
  const store = fileSystem => {
    const value = new NamedConfigurationStore({ configurationDirectoryPath: directory, fileSystem,
      onError: error => { report.diagnostics.push({ type: typeof error, value: describe(error, true) }); } });
    stores.push(value); return value;
  };
  const snapshot = async name => {
    const bytes = await fs.readFile(filename);
    await fs.writeFile(path.join(root, name + '.bin'), bytes, { flag: 'wx' });
    report.files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    return bytes;
  };
  const released = file => {
    const fd = file.fd;
    return async () => {
      await file.close();
      assert.throws(() => fstatSync(fd), { code: 'EBADF' });
      report.handles.push({ fd, closed: true });
    };
  };
  t.after(async () => {
    const cleanup = [];
    for (const owner of stores.toReversed()) try { await owner.close(); } catch (error) { cleanup.push(error); }
    report.closed = cleanup.length === 0;
    report.cleanup = cleanup.map(error => ({ type: typeof error, value: describe(error, true) }));
    await fs.writeFile(path.join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (cleanup.length === 1) throw cleanup[0];
    if (cleanup.length) throw new AggregateError(cleanup, 'Configuration failure fixture cleanup failed.', { cause: cleanup[0] });
  });
  await fs.writeFile(filename, serializeConfiguration('metadata', metadata(true)));
  try { await work({ root, directory, filename, report, store, snapshot, released }); }
  catch (error) { report.testFailure = describe(error, true); throw error; }
}

test('named configuration retains storage reasons and real file state through lazy load, validation and save recovery', settings, async t => {
  for (const stage of ['stat', 'read', 'mkdir', 'write', 'close', 'write-close', 'encoding-stat']) {
    for (const [name, reason] of failures()) await t.test(stage + '/' + name, settings, async t => {
      await fixture(t, stage + '/' + name, async ({ root, directory, filename, report, store, snapshot, released }) => {
        const original = await snapshot('original');
        const target = path.join(directory, 'temporary-output'); await fs.mkdir(target);
        const encodingFile = path.join(directory, 'encoding.xml');
        const encoding = { ...defaultConfiguration('encoding'), TranscodingTempPath: '' };
        await fs.writeFile(encodingFile, serializeConfiguration('encoding', encoding));
        const encodingBefore = await fs.readFile(encodingFile);
        const cleanup = Object.assign(new Error('Controlled configuration file disposal failure.'), {
          code: 'CONFIG_CLOSE', status: 503, cause: 0,
        });
        let active = true, injected = false, prefix = 0;
        const fileSystem = { ...fs,
          async stat(file) {
            const result = await fs.stat(file);
            if (active && (stage === 'stat' && file === filename || stage === 'encoding-stat' && file === target)) {
              injected = true; throw reason;
            }
            return result;
          },
          async readFile(file, ...args) {
            const bytes = await fs.readFile(file, ...args);
            if (active && stage === 'read' && file === filename) { injected = true; throw reason; }
            return bytes;
          },
          async mkdir(file, ...args) {
            const result = await fs.mkdir(file, ...args);
            if (active && stage === 'mkdir' && file === directory) { injected = true; throw reason; }
            return result;
          },
          async open(file, flags, ...args) {
            const handle = await fs.open(file, flags, ...args);
            if (!active || file !== filename || flags !== 'w' || !['write', 'close', 'write-close'].includes(stage)) return handle;
            const close = released(handle);
            return {
              async write(bytes, offset, length) {
                if (stage === 'close') return handle.write(bytes, offset, length);
                if (prefix >= 37) { injected = true; throw reason; }
                const result = await handle.write(bytes, offset, Math.min(length, 37 - prefix));
                prefix += result.bytesWritten; return result;
              },
              async close() {
                await close();
                if (stage === 'close') { injected = true; throw reason; }
                if (stage === 'write-close') throw cleanup;
              },
            };
          },
        };
        const owner = store(fileSystem);
        const receipt = path.join(root, 'updated.txt');
        owner.on('updated', async () => { await fs.writeFile(receipt, 'Configuration update completed.'); });
        const loading = ['stat', 'read'].includes(stage), validating = stage === 'encoding-stat';
        if (!loading) assert.deepEqual(await owner.getConfiguration(validating ? 'encoding' : 'metadata'), validating ? encoding : metadata(true));
        const incoming = validating ? { ...encoding, TranscodingTempPath: target } : metadata(false);
        const expected = stage === 'write-close'
          ? Object.assign(new AggregateError([reason, cleanup], reason?.message ?? 'Configuration save failed.', { cause: reason }),
            Object.fromEntries(['code', 'status', 'statusCode'].filter(key => reason?.[key] !== undefined).map(key => [key, reason[key]])))
          : reason;
        await rejection(() => loading ? owner.getConfiguration('metadata')
          : owner.saveConfiguration(validating ? 'encoding' : 'metadata', incoming), expected, report);
        assert.equal(injected, true, 'The actual declared storage boundary must execute.');
        await assert.rejects(fs.readFile(receipt), { code: 'ENOENT' });
        const failed = await snapshot('after-failure');
        if (stage === 'write' || stage === 'write-close') assert.deepEqual(failed, serializeConfiguration('metadata', incoming).subarray(0, 37));
        else if (stage === 'close') assert.deepEqual(failed, serializeConfiguration('metadata', incoming));
        else assert.deepEqual(failed, original);
        if (validating) {
          assert.deepEqual(await fs.readFile(encodingFile), encodingBefore);
          assert.deepEqual(owner.getCurrentConfiguration('encoding'), encoding);
        } else if (!loading) assert.deepEqual(owner.getCurrentConfiguration('metadata'), incoming);
        active = false;
        if (loading) assert.deepEqual(await owner.getConfiguration('metadata'), metadata(true));
        else {
          await owner.saveConfiguration(validating ? 'encoding' : 'metadata', incoming);
          assert.equal(await fs.readFile(receipt, 'utf8'), 'Configuration update completed.');
        }
        await owner.close();
        const fresh = store();
        assert.deepEqual(await fresh.getConfiguration(validating ? 'encoding' : 'metadata'), validating ? incoming : metadata(loading));
        await fresh.close();
        const recovered = await snapshot('recovered');
        assert.deepEqual(parseConfigurationXml(recovered, 'metadata'), validating || loading ? metadata(true) : metadata(false));
        if (validating) assert.deepEqual(parseConfigurationXml(await fs.readFile(encodingFile), 'encoding'), incoming);
      });
    });
  }
});

test('configuration loading recovers actual read reasons and preserves original stat failures before rewriting defaults', settings, async t => {
  for (const stage of ['read', 'stat']) for (const [name, reason] of failures()) await t.test(stage + '/' + name, settings, async t => {
    await fixture(t, 'load/' + stage + '/' + name, async ({ filename, report, snapshot }) => {
      await fs.writeFile(filename, serializeConfiguration('metadata', metadata(false)));
      const original = await snapshot('original');
      const readFailure = Object.assign(new Error('Controlled configuration read before rewrite.'), { code: 'CONFIG_READ', cause: false });
      let active = true, injected = false;
      const fileSystem = { ...fs,
        async readFile(file, ...args) {
          const bytes = await fs.readFile(file, ...args);
          if (active && file === filename) {
            if (stage === 'read') { injected = true; throw reason; }
            throw readFailure;
          }
          return bytes;
        },
        async stat(file, ...args) {
          const result = await fs.stat(file, ...args);
          if (active && stage === 'stat' && file === filename) { injected = true; throw reason; }
          return result;
        },
      };
      const load = () => loadConfigurationFile(filename, 'metadata', { fileSystem,
        onError: error => { report.diagnostics.push({ type: typeof error, value: describe(error, true) }); } });
      if (stage === 'read') assert.deepEqual(await load(), metadata(true));
      else await rejection(load, reason, report);
      assert.equal(injected, true, 'The actual declared storage boundary must execute.');
      const failed = await snapshot('after-operation');
      assert.deepEqual(failed, stage === 'read' ? serializeConfiguration('metadata', metadata(true)) : original);
      active = false;
      assert.deepEqual(await load(), metadata(stage === 'read'));
      assert.deepEqual(await snapshot('recovered'), failed);
    });
  });
});
