import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { snapshot, canonicalRows } from './fixtures/live-tv-sources-http/scenario.js';

export const requiredValidationServices = ['postgres'];
const inputBytes = await fs.readFile(new URL('./fixtures/live-tv-source-binding/native-http-errors.json', import.meta.url));
const input = JSON.parse(inputBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = response => {
  const body = structuredClone(response.body);
  assert.match(body.traceId, /^00-[a-f0-9]{32}-[a-f0-9]{16}-00$/u);
  body.traceId = '$validated-native-format'; return { ...response, body };
};

test('source binding errors match nine actual native HTTP responses before any configuration or Guide mutation', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async () => {
  assert.equal(input.schemaVersion, 1); assert.equal(input.provenance.runId, '39647768077'); assert.equal(input.provenance.realNativeHttp, true);
  assert.match(input.provenance.sourceReportSha256, /^[a-f0-9]{64}$/u); assert.match(input.provenance.nativeBuildIdentitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(input.cases.length, 9);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mm-source-binding-'))), output = path.join(validationOutputRoot(), 'source-binding-' + randomUUID());
  await fs.mkdir(output); const report = { provenance: input.provenance, inputSha256: sha(inputBytes), cases: [], cleanup: [] }, errors = [], guides = [];
  let runtime, database, failure;
  const configuration = Buffer.from('<LiveTvOptions><TunerHosts /><ListingProviders /></LiveTvOptions>');
  try {
    const programDataPath = path.join(root, 'data'), configurationDirectoryPath = path.join(root, 'config');
    await fs.mkdir(configurationDirectoryPath); await fs.writeFile(path.join(configurationDirectoryPath, 'livetv.xml'), configuration);
    database = await createPostgresTestDatabase(null, 'source_binding');
    runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath, configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
      serverId: 'source-binding', onError: error => errors.push(error) });
    runtime.tasks.on('completed', event => { if (event.Task.Key === 'RefreshGuide') guides.push(event.Result); });
    await runtime.apiKeys.create('Recorded native source binding'); const keys = await runtime.apiKeys.list(); assert.equal(keys.Items.length, 1);
    const token = keys.Items[0].AccessToken;
    const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port, baseline = await runtime.store.run(snapshot);
    for (const entry of input.cases) {
      assert.equal(entry.request.method, 'POST'); assert.equal(entry.request.mode, 'apiKey');
      assert.deepEqual(JSON.parse(entry.response.bodyText), entry.response.bodyJson, 'Captured native response text and JSON must agree.');
      const response = await fetch(origin + entry.request.route, { method: entry.request.method, signal: AbortSignal.timeout(10000),
        headers: { Authorization: `MediaBrowser Client="Source binding", Device="Private", DeviceId="source-binding", Version="1", Token="${token}"`,
          Accept: 'application/json', 'Content-Type': entry.request.contentType ?? 'application/json' }, body: entry.request.rawBody });
      const text = await response.text(), actual = { status: response.status, contentType: response.headers.get('content-type'), body: JSON.parse(text) };
      const expected = { status: entry.response.status, contentType: entry.response.contentType, body: entry.response.bodyJson };
      report.cases.push({ name: entry.name, request: entry.request, actual: { ...actual, text }, expected: entry.response });
      assert.deepEqual(canonical(actual), canonical(expected), entry.name);
      assert.deepEqual(await fs.readFile(path.join(configurationDirectoryPath, 'livetv.xml')), configuration);
      assert.deepEqual(canonicalRows(await runtime.store.run(snapshot)), canonicalRows(baseline));
    }
    assert.deepEqual(guides, []); assert.deepEqual(errors, []);
    report.configurationSha256 = sha(configuration); report.rejectedBeforeGuideOrStateMutation = true;
  } catch (error) { failure = error; }
  finally {
    for (const [name, operation] of [['runtime', () => runtime?.close()], ['postgres', () => dropPostgresTestDatabase(database)], ['private-files', async () => {
      assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert.match(path.basename(root), /^mm-source-binding-/u); await fs.rm(root, { recursive: true, force: true });
    }]]) try { await operation(); report.cleanup.push({ name, closed: true }); } catch (error) { failure ??= error; report.cleanup.push({ name, error: error.stack }); }
    report.passed = !failure; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.error = failure?.stack; report.boundary = 'Real PostgreSQL runtime HTTP binding against complete actual-native responses captured from run 39647768077. Trace values are validated before mapping. Current native full-host differential remains an independent required check.';
    await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
});
