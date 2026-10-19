import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrandingConfigurationStore, defaultBrandingOptions, readBrandingOptions } from '../../src/branding/configuration.js';
import { BrandingService } from '../../src/branding/service.js';
import { ImageService } from '../../src/images/service.js';
import { createApplication } from '../../src/http/application.js';
import { dateTicks, MIN_DATE } from '../../src/library/records.js';
import { rawHttp } from '../images/http-client.js';
import { imageHeaderProjection } from '../images/header-projection.js';
import { imageUploadExtension, decodeBase64Stream } from '../../src/images/upload.js';
import { escapeXml } from '../../src/core/xml.js';

const fixture = new URL('./fixtures/branding/', import.meta.url);
const [nativeBytes, inputBytes, proofBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json'].map(name => readFile(new URL(name, fixture))));
const native = JSON.parse(nativeBytes), input = JSON.parse(inputBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const noTrace = value => Array.isArray(value) ? value.map(noTrace) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'traceId').map(([name, entry]) => [name, noTrace(entry)])) : value;
function project(value, root) {
  if (typeof value === 'string') {
    if (value === root) return '{state}';
    if (!value.startsWith(root + '/') && !value.startsWith(root + '\\')) return value;
    return '{state}/' + value.slice(root.length + 1).replaceAll('\\', '/');
  }
  if (Array.isArray(value)) return value.map(entry => project(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, key === 'dateModified' ? String(dateTicks(entry)) : project(entry, root)]));
  return value;
}

test('branding recordings bind actual MVC, named configuration, XML, files, MIME and Base64 transforms', async () => {
  assert.equal(hash(nativeBytes), proof.nativeSha256); assert.equal(hash(inputBytes), proof.inputSha256);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const key of ['actualControllers', 'actualNamedConfiguration', 'actualXmlSerializer', 'actualBase64Stream', 'realFiles', 'processorControlled', 'authenticationControlled']) assert.equal(native[key], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256);
  for (const sample of native.mimeSamples) assert.equal(imageUploadExtension(sample.contentType), sample.extension, String(sample.contentType));
  assert.equal(native.imageMimes.length, 87);
  for (const sample of native.imageMimes) assert.equal(imageUploadExtension(sample.mimeType), sample.extension, sample.mimeType);
});

test('image Base64 streams retain complete-block rejection, discarded tails and committed output prefixes', async t => {
  for (const sample of input.streams) await t.test(sample.name, async () => {
    const chunks = [], observation = native.transforms.find(value => value.name === sample.name);
    let failed = false;
    try { for await (const chunk of decodeBase64Stream(sample.chunks.map(value => Buffer.from(value)))) chunks.push(chunk); }
    catch (error) { assert.equal(error.code, 'invalid-base64'); failed = true; }
    assert.equal(failed, observation.failure != null); assert.equal(Buffer.concat(chunks).toString('base64'), observation.bytes);
  });
});

test('branding HTTP matches native actions, model binding, files and failure commit prefixes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branding-http-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('branding-http-')); await rm(root, { recursive: true, force: true }); });
  for (const sample of input.cases) await t.test(sample.name, async () => {
    const directory = path.join(root, sample.name), dataPath = path.join(directory, 'data'), configPath = path.join(directory, 'config');
    await mkdir(dataPath, { recursive: true }); await mkdir(configPath);
    const options = { ...defaultBrandingOptions(), ...sample.initial };
    if (options.SplashscreenLocation != null && options.SplashscreenLocation !== ' ') options.SplashscreenLocation = path.join(dataPath, options.SplashscreenLocation);
    const filename = path.join(configPath, 'branding.xml');
    await writeFile(filename, sample.xml ?? '<BrandingOptions>' + Object.entries(options).filter(([, value]) => value != null)
      .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`).join('') + '</BrandingOptions>');
    for (const [name, bytes] of Object.entries(sample.files ?? {})) {
      const target = path.join(dataPath, name); await writeFile(target, Buffer.from(bytes, 'base64'));
      await utimes(target, new Date('2024-06-02T12:34:56Z'), new Date('2024-06-02T12:34:56Z'));
    }
    if (sample.directoryFile) await mkdir(path.join(dataPath, sample.directoryFile));
    if (sample.readOnlyConfig) await chmod(filename, 0o444);
    if (sample.readOnlyFile) await chmod(path.join(dataPath, sample.readOnlyFile), 0o444);
    if (sample.missingData) { assert.equal(path.dirname(dataPath), directory); await rm(dataPath, { recursive: true }); }
    if (sample.directoryConfig) { await rm(filename); await mkdir(filename); }
    const calls = [], errors = [], store = new BrandingConfigurationStore({ configurationDirectoryPath: configPath, onError: error => errors.push(error) });
    await store.initialize();
    for (const [event, phase] of [['updating', 'configuration-updating'], ['updated', 'configuration-updated']]) store.on(event, options => calls.push({ phase, options }));
    const processor = { async process(options) {
      calls.push({ phase: 'image', path: options.image.Path, dateModified: options.image.DateModified, Quality: options.Quality,
        ...Object.fromEntries(['Width', 'Height', 'MaxWidth', 'MaxHeight', 'FillWidth', 'FillHeight', 'Blur', 'BackgroundColor', 'ForegroundLayer'].map(key => [key, options[key] ?? null])),
        formats: options.SupportedOutputFormats.map(String) });
      return { original: true, path: options.image.Path, mimeType: 'image/png', dateModified: MIN_DATE };
    } };
    const images = new ImageService({fileSystem: testFileSystem,  processor }), branding = new BrandingService({fileSystem: testFileSystem,  configurationStore: store, images, dataPath });
    const auth = { IsAuthenticated: sample.identity != null && sample.identity !== 'anonymous', IsAdministrator: sample.identity === 'admin' };
    const authentication = { read: () => auth, authenticate: async () => auth, authorize(value, { policy }) {
      if (!value.IsAuthenticated) throw Object.assign(new Error('Unauthenticated.'), { status: 401 });
      if (policy === 'RequiresElevation' && !value.IsAdministrator) throw Object.assign(new Error('Administrator required.'), { status: 403 });
    } };
    const application = await createApplication({ branding, authentication, configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' }, onError: error => errors.push(error) });
    await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
    try {
      const actual = await rawHttp(`http://127.0.0.1:${application.server.address().port}${sample.path}`, {
        method: sample.method, body: sample.body, headers: { Accept: sample.accept ?? 'application/json', ...sample.headers, ...(sample.contentType && { 'Content-Type': sample.contentType }) } });
      const expected = native.results.find(value => value.name === sample.name);
      // The recorded process ran on Windows, independently of this test's host.
      const referenceDirectory = path.win32.join(proof.process.args[1], 'cases', sample.name);
      assert.equal(actual.status, expected.status);
      const headers = Object.fromEntries(Object.keys(expected.headers).map(name => [name, actual.headers[name]]));
      assert.deepEqual(imageHeaderProjection(headers), imageHeaderProjection(expected.headers));
      assert.equal(actual.headers['transfermode.dlna.org'], undefined); assert.equal(actual.headers['realtimeinfo.dlna.org'], undefined);
      if (expected.jsonBody != null) assert.deepEqual(project(noTrace(JSON.parse(actual.bytes)), directory), project(noTrace(expected.jsonBody), referenceDirectory));
      else assert.deepEqual(actual.bytes, Buffer.from(expected.body, 'base64'));
      let disk = null; try { disk = readBrandingOptions(await readFile(filename)); } catch { }
      const files = [];
      for (const entry of await readdir(dataPath, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
        if (entry.isFile()) files.push({ name: entry.name, bytes: (await readFile(path.join(dataPath, entry.name))).toString('base64') });
      files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      assert.deepEqual(project({ live: store.options, disk, calls, files }, directory),
        project({ live: expected.live, disk: expected.disk, calls: expected.calls, files: expected.files }, referenceDirectory));
    } finally {
      await branding.close(); await images.close(); await new Promise(resolve => application.server.close(resolve));
      if (sample.readOnlyConfig) await chmod(filename, 0o666);
      if (sample.readOnlyFile) await chmod(path.join(dataPath, sample.readOnlyFile), 0o666);
    }
  });
});
