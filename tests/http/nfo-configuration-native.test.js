import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { currentNfoConfiguration, nfoInput } from '../metadata/nfo-configuration-current.js';
import { nfoComponentHost } from '../metadata/fixtures/nfo-configuration-current/node-host.js';
import { disk } from '../metadata/fixtures/nfo-configuration-current/node-cases.js';
import { namedHttpProjection, namedFailurePayload, namedError } from '../core/named-configuration-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
test('NFO manual JsonDocument actions match actual MVC, authorization, complete wire and persisted values', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async () => {
  const capture = await currentNfoConfiguration();
  const report = { scope: capture.report.scope, nativeCapture: capture.output, comparisons: [], errors: [], phaseAcceptance: false, releaseAcceptance: false };
  let host, owner, primary, primaryFailed = false;
  try {
    for (const [index, sample] of nfoInput.http.entries()) {
      const reference = capture.native.http[index], repeat = capture.repeat.http[index];
      assert.deepEqual(namedHttpProjection(repeat, sample.key), namedHttpProjection(reference, sample.key), sample.name + ': independent Native');
      const root = path.join(capture.output, 'node-http-' + index), directory = path.join(root, 'config'), filename = path.join(directory, sample.key + '.xml');
      await fs.mkdir(directory, { recursive: true });
      if (Object.hasOwn(sample, 'xml')) await fs.writeFile(filename, sample.xml);
      if (sample.physical === 'target-directory') { await fs.unlink(filename); await fs.mkdir(filename); }
      const diagnostics = [], operationFailures = [], events = [];
      host = nfoComponentHost({ configurationDirectoryPath: directory,
        onFailure: entry => operationFailures.push({ owner: structuredClone(owner), ...entry,
          error: namedError(entry.error), failurePayload: namedFailurePayload(entry.error) }),
        onError: error => {
          const entry = { owner: structuredClone(owner), error: namedError(error) };
          if (owner?.open) diagnostics.push(entry); else report.errors.push(entry);
        } });
      host.store.on('updating', incoming => { events.push(structuredClone({ phase: 'updating', ...incoming }));
        if (sample.observer === 'updating') throw new Error('Controlled named updating failure.'); });
      host.store.on('updated', incoming => { events.push(structuredClone({ phase: 'updated', ...incoming }));
        if (sample.observer === 'updated') throw new Error('Controlled named updated failure.'); });
      await new Promise((resolve, reject) => { host.server.once('error', reject); host.server.listen(0, '127.0.0.1', () => { host.server.off('error', reject); resolve(); }); });
      const request = async (method, body, phase) => {
        owner = { index, sample: sample.name, phase, method, route: '/System/Configuration/' + sample.key, open: true };
        const response = await fetch('http://127.0.0.1:' + host.server.address().port + owner.route, { method,
          headers: { Accept: 'application/json', 'X-Identity': sample.identity ?? 'admin', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body }) });
        const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString(); let value = null;
        try { value = parseLosslessJson(text); } catch { }
        owner.open = false;
        return { status: response.status, contentType: response.headers.get('content-type'), headers: Object.fromEntries(response.headers),
          text, json: value, bodyBase64: bytes.toString('base64'), error: null };
      };
      const response = await request(sample.method, sample.body, 'response'), afterRead = await request('GET', undefined, 'afterRead');
      const actual = { name: sample.name, root, response, afterRead, live: sample.key === 'xbmcmetadata'
        ? structuredClone(await host.store.getConfiguration(sample.key)) : null, events, disk: sample.key === 'xbmcmetadata' ? disk(filename) : null,
        diagnostics, operationFailures };
      report.comparisons.push({ sample, reference, repeat, actual });
      assert.deepEqual(namedHttpProjection(actual, sample.key), namedHttpProjection(reference, sample.key), sample.name + ': full response and effects');
      for (const failure of operationFailures) {
        const wire = actual[failure.owner.phase];
        assert.equal(wire.status, failure.failurePayload?.status ?? failure.failurePayload?.statusCode ?? 500);
        assert.equal(wire.text, 'Error processing request.');
      }
      owner = undefined; await host.close(); assert.equal(host.server.listening, false); host = undefined;
    }
  } catch (error) { primaryFailed = true; primary = error; report.failure = namedError(error); }
  finally {
    owner = undefined;
    const failures = [];
    try { await host?.close(); } catch (error) { failures.push(error); report.errors.push(namedError(error)); }
    report.failed = primaryFailed || failures.length > 0;
    try { await fs.writeFile(path.join(capture.output, 'node-http-comparison.json'), configurationJson(report), { flag: 'wx' }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primaryFailed ? [primary, ...failures] : failures, 'NFO component HTTP cleanup failed.', { cause: primaryFailed ? primary : failures[0] });
  }
  if (primaryFailed) throw primary;
});
