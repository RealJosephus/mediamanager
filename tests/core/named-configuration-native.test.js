import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { EncodingPaths } from '../../src/core/encoding-paths.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { configurationJson } from './fixtures/configuration/observations.js';
import { currentNamedConfiguration, namedCoreProjection, namedDiskProjection, namedError, namedExpand, namedExpandPath,
  namedInput, namedPathsProjection, namedFailurePayload } from './named-configuration-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
export function namedPhysicalDisk(filename, root) {
  let bytes = null, directory = false, value = null, error = null;
  try { directory = fsSync.statSync(filename).isDirectory(); if (!directory) bytes = fsSync.readFileSync(filename); }
  catch (failure) { if (!missing(failure)) error = namedError(failure); }
  if (bytes !== null) try { value = parseConfigurationXml(bytes, root); } catch (failure) { error = namedError(failure); }
  return { bytes: bytes?.toString('base64') ?? null, directory, accepted: bytes === null ? null : error === null, value, error };
}

async function candidate(sample, root) {
  const directory = path.join(root, 'config'), filename = path.join(directory, sample.key + '.xml');
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(path.join(root, 'transcodes'));
  let linkedFilename = null;
  if (sample.directoryLink) {
    const target = path.join(root, 'config-target'); await fs.rename(directory, target);
    await fs.symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
    linkedFilename = path.join(target, sample.key + '.xml');
  }
  if (Object.hasOwn(sample, 'xml')) await fs.writeFile(filename, sample.xml);
  let readMode = '', observer = null, activeStep = null;
  const diagnostics = [], readAttempts = [], warm = new Set(), retained = {}, events = [], steps = [];
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory,
    fileSystem: { ...fs, async readFile(name, ...args) {
      const attempt = { owner: structuredClone(activeStep), filename: name, beforeBytes: null, beforeReadFailure: null,
        bytes: null, actualParserFailure: null, ioFailure: null, sourceFailure: null };
      try { attempt.beforeBytes = fsSync.readFileSync(name).toString('base64'); }
      catch (error) { attempt.beforeReadFailure = namedError(error); }
      readAttempts.push(attempt);
      try {
        if (name === filename && readMode === 'io') {
          const cause = Object.assign(new Error('Original storage failure.', { cause: null }), { code: 'ESTORAGE',
            errors: [false, 0, '', null, undefined], details: { name: 'Storage business name', stack: 'Storage business stack' } });
          const failure = Object.assign(new Error('Controlled named read failure.', { cause }), { code: 'EIO', status: 507, statusCode: 503 });
          attempt.sourceFailure = namedError(failure); attempt.sourceFailurePayload = namedFailurePayload(failure); throw failure;
        }
        if (name === filename && readMode === 'race-delete') await fs.unlink(name);
        const bytes = await fs.readFile(name, ...args); attempt.bytes = bytes.toString('base64');
        try { parseConfigurationXml(bytes, sample.key); } catch (error) { attempt.actualParserFailure = namedError(error); }
        return bytes;
      } catch (error) { attempt.ioFailure = namedError(error); attempt.ioFailurePayload = namedFailurePayload(error); throw error; }
    } }, onError: error => diagnostics.push({ owner: activeStep, error: namedError(error) }) });
  const snapshot = () => structuredClone({
    current: Object.fromEntries([...warm].map(key => [key, store.getCurrentConfiguration(key)])), retained,
    disk: namedPhysicalDisk(filename, sample.key), linkedDisk: linkedFilename === null ? null : namedPhysicalDisk(linkedFilename, sample.key),
    files: fsSync.readdirSync(directory).filter(name => ['encoding.xml', 'metadata.xml'].includes(name)).sort(),
  });
  store.on('updating', incoming => {
    events.push(structuredClone({ phase: 'updating', ...incoming, state: snapshot() }));
    if (observer === 'mutate-path') incoming.configuration.TranscodingTempPath = path.join(root, 'missing-after-updating');
    if (observer === 'updating') throw new Error('Controlled named updating failure.');
  });
  store.on('updated', incoming => {
    events.push(structuredClone({ phase: 'updated', ...incoming, state: snapshot() }));
    if (observer === 'updated') throw new Error('Controlled named updated failure.');
  });
  let result;
  try {
    const before = snapshot();
    for (const [index, step] of sample.steps.entries()) {
      let value = null, error = null, failed = false, failurePayload; activeStep = { index, action: step.action, key: step.key ?? sample.key };
      try {
        const key = step.key ?? sample.key;
        switch (step.action) {
          case 'get': value = await store.getConfiguration(key); warm.add(key); if (step.retain) retained[step.retain] = value; break;
          case 'save': {
            const incoming = { ...defaultConfiguration(sample.key), ...namedExpand(step.values, root, key) };
            if (step.retain) retained[step.retain] = incoming;
            await store.saveConfiguration(key, incoming); break;
          }
          case 'saveRetained': await store.saveConfiguration(key, retained[step.retain]); break;
          case 'mutate': Object.assign(retained[step.retain], namedExpand(step.values, root, key)); break;
          case 'xml': await fs.writeFile(filename, step.value); break;
          case 'observer': observer = step.phase; break;
          case 'readMode': readMode = step.mode; break;
          case 'physical':
            if (step.mode === 'readonly') await fs.chmod(filename, 0o444);
            else if (step.mode === 'writable') await fs.chmod(filename, 0o666);
            else if (step.mode === 'target-directory') { await fs.unlink(filename); await fs.mkdir(filename); }
            else throw new Error('Unknown named physical operation: ' + step.mode);
            break;
          default: throw new Error('Unknown named operation: ' + step.action);
        }
      } catch (failure) { failed = true; error = namedError(failure); failurePayload = namedFailurePayload(failure); }
      steps.push(structuredClone({ step, accepted: !failed, result: value, error, failurePayload, state: snapshot(), diagnostics }));
    }
    result = { name: sample.name, key: sample.key, root, before, steps, events, after: snapshot(),
      diagnostics: structuredClone(diagnostics), readAttempts: structuredClone(readAttempts) };
  } finally {
    activeStep = null; await store.close();
    try { if ((await fs.stat(filename)).isFile()) await fs.chmod(filename, 0o666); } catch (error) { if (!missing(error)) throw error; }
  }
  return { ...result, storeClosed: true, filename, linkedFilename };
}

test('named encoding and metadata preserve current manager, public aliases, event failures and actual file effects', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async () => {
  const captured = await currentNamedConfiguration();
  const report = { scope: 'Current encoding/metadata factories and manager, actual XML, original public values and failures.',
    nativeCapture: captured.output, comparisons: [], differences: [], cleanup: {}, componentAcceptance: false,
    phaseAcceptance: false, releaseAcceptance: false,
    excluded: ['production HTTP registration and runtime consumers', 'media generation', 'all file sharing and permission combinations'] };
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, message: error.message }); }
  };
  let failed = false, failure;
  try {
    const candidates = [];
    for (const [index, sample] of namedInput.core.entries()) {
      const expected = captured.native.core[index], repeated = captured.repeat.core[index];
      compare(sample.name + ': independent native repeat', namedCoreProjection(repeated), namedCoreProjection(expected));
      const actual = await candidate(sample, path.join(captured.output, 'node-core-' + index)); candidates.push(actual);
      compare(sample.name + ': complete public states, results and synchronous event sequence', namedCoreProjection(actual), namedCoreProjection(expected));
      if (sample.name === 'read-after-exists-io') {
        const rejectedIndex = actual.steps.findIndex(step => step.step.action === 'get' && !step.accepted), rejected = actual.steps[rejectedIndex];
        const original = actual.readAttempts.find(attempt => attempt.owner?.index === rejectedIndex && attempt.sourceFailure !== null);
        assert.ok(original, 'The actual EIO boundary must retain the original Node failure.');
        assert.deepEqual(rejected.failurePayload, original.sourceFailurePayload, 'EIO message/code/status/cause/ordered errors must remain complete.');
        assert.deepEqual(original.ioFailurePayload, original.sourceFailurePayload);
        assert.deepEqual(rejected.failurePayload.cause.details, { name: 'Storage business name', stack: 'Storage business stack' });
        assert.deepEqual(rejected.failurePayload.cause.errors, [false, 0, '', null, undefined]);
      }
      if (sample.name === 'unknown-xml-content-and-real-native-cold-reader') {
        const xml = Buffer.from(actual.after.disk.bytes, 'base64').toString('utf8');
        for (const fragment of ['xmlns:u="urn:future"', 'u:flag="retained"', '<u:extra>original</u:extra>', 'before', 'after']) assert.ok(xml.includes(fragment), fragment);
      }
      assert.equal(actual.storeClosed, true);
      report.comparisons.push({ sample, actual, expected });
    }
    const nodeFiles = candidates.flatMap(row => [{ name: row.name, root: row.key, filename: row.filename, disk: row.after.disk, nodeRoot: row.root },
      ...(row.linkedFilename === null ? [] : [{ name: row.name + ':physical-target', root: row.key, filename: row.linkedFilename, disk: row.after.linkedDisk, nodeRoot: row.root }])]);
    const consumption = await captured.consume(nodeFiles.map(({ name, root, filename }) => ({ name, root, filename })), 'node-core-cold-read');
    report.nodeFilesReadByFreshNative = consumption;
    assert.deepEqual(consumption.native.consumed.map(row => row.name), nodeFiles.map(row => row.name));
    for (const [index, cold] of consumption.native.consumed.entries()) {
      const original = nodeFiles[index]; assert.equal(cold.disk.bytes, original.disk.bytes, original.name + ': original file bytes');
      compare(original.name + ': fresh native serializer reads actual Node file', namedDiskProjection(original.disk, original.root, original.nodeRoot),
        namedDiskProjection(cold.disk, original.root, original.nodeRoot));
    }
    assert.deepEqual(report.differences, [], configurationJson(report.differences.slice(0, 6)));
    report.componentAcceptance = true; report.cleanup.nodeStoresClosed = true;
  } catch (error) { failed = true; failure = error; report.failure = namedError(error); }
  finally { await fs.writeFile(path.join(captured.output, 'core-comparison.json'), configurationJson(report), { flag: 'wx' }); }
  if (failed) throw failure;
});

test('current encoding GetTranscodePath returns actual paths and preserves or rejects real recursive marker files', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async () => {
  const captured = await currentNamedConfiguration();
  const report = { scope: 'Current native GetTranscodePath and real directories/marker bytes with canonical named configuration updates.',
    nativeCapture: captured.output, comparisons: [], componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  let failed = false, failure;
  try {
    for (const [index, sample] of namedInput.paths.entries()) {
      const root = path.join(captured.output, 'node-paths-' + index), directory = path.join(root, 'config');
      await fs.mkdir(directory, { recursive: true });
      for (const relative of sample.directories) await fs.mkdir(path.join(root, ...relative.split('/')), { recursive: true });
      const diagnostics = [], store = new NamedConfigurationStore({ configurationDirectoryPath: directory, onError: error => diagnostics.push(namedError(error)) });
      const paths = new EncodingPaths({ applicationPaths: { cachePath: path.join(root, 'cache') }, getEncodingOptions: () => store.getCurrentConfiguration('encoding') });
      const tree = () => {
        const entries = [];
        const visit = filename => {
          const info = fsSync.statSync(filename), relative = path.relative(root, filename).split(path.sep).join('/');
          entries.push({ path: relative, directory: info.isDirectory(), bytes: info.isDirectory() ? null : fsSync.readFileSync(filename).toString('base64') });
          if (info.isDirectory()) for (const name of fsSync.readdirSync(filename)) visit(path.join(filename, name));
        };
        for (const relative of ['cache/transcodes', 'a', 'b', 'foreign']) {
          const filename = path.join(root, ...relative.split('/')); if (fsSync.existsSync(filename)) visit(filename);
        }
        return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      };
      const snapshot = () => structuredClone({ encoding: store.getCurrentConfiguration('encoding'), metadata: store.getCurrentConfiguration('metadata'),
        cachePath: paths.applicationPaths.cachePath, tree: tree() });
      let actual;
      try {
        await store.getConfiguration('encoding'); await store.getConfiguration('metadata');
        const before = snapshot(), steps = [];
        for (const step of sample.steps) {
          let result = null, error = null, failed = false;
          try {
            if (step.action === 'get') result = await paths.getTranscodePath();
            else if (step.action === 'save') await store.saveConfiguration(step.key, { ...defaultConfiguration(step.key), ...namedExpand(step.values, root, step.key) });
            else if (step.action === 'write') await fs.writeFile(namedExpandPath(step.filename, root), step.value);
            else throw new Error('Unknown path operation: ' + step.action);
          } catch (failure) { failed = true; error = namedError(failure); }
          steps.push({ step, accepted: !failed, result, error, state: snapshot() });
        }
        actual = { name: sample.name, root, before, steps, after: snapshot(), diagnostics };
      } finally { await store.close(); }
      const expected = captured.native.paths[index], repeated = captured.repeat.paths[index];
      report.comparisons.push({ sample, actual, expected });
      assert.deepEqual(namedPathsProjection(repeated), namedPathsProjection(expected), sample.name + ': independent native repeat');
      assert.deepEqual(namedPathsProjection(actual), namedPathsProjection(expected), sample.name + ': exact path and physical marker effects');
    }
    report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; report.failure = namedError(error); }
  finally { await fs.writeFile(path.join(captured.output, 'paths-comparison.json'), configurationJson(report), { flag: 'wx' }); }
  if (failed) throw failure;
});
