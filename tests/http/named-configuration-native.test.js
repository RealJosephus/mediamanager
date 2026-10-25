import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { namedComponentHost } from '../core/fixtures/named-configuration-current/node-host.js';
import { currentNamedConfiguration, namedDiskProjection, namedError, namedHttpProjection, namedInput, namedNormalise, namedFailurePayload } from '../core/named-configuration-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const known = key => ['encoding', 'metadata'].includes(key);
async function physicalDisk(filename, root) {
  let bytes = null, directory = false, value = null, error = null;
  try { directory = (await fs.stat(filename)).isDirectory(); if (!directory) bytes = await fs.readFile(filename); }
  catch (failure) { if (!['ENOENT', 'ENOTDIR'].includes(failure.code)) error = namedError(failure); }
  if (bytes !== null) try { value = parseConfigurationXml(bytes, root); } catch (failure) { error = namedError(failure); }
  return { bytes: bytes?.toString('base64') ?? null, directory, accepted: bytes === null ? null : error === null, value, error };
}

test('named JsonDocument actions match current MVC authorization, full wire, all public fields and actual persistence', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async () => {
  const captured = await currentNamedConfiguration();
  const report = { scope: 'Current encoding/metadata controller, MVC JsonDocument, manual JsonDefaults binding, real manager and files.',
    nativeCapture: captured.output, comparisons: [], differences: [], cleanup: {}, componentAcceptance: false,
    phaseAcceptance: false, releaseAcceptance: false,
    excluded: ['production route registration', 'production runtime consumers and media executors', 'PostgreSQL and full server restart'] };
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, message: error.message }); }
  };
  const consumed = [], cleanupFailures = [], unownedErrors = [];
  let host, active, failure;
  try {
    for (const [index, sample] of namedInput.http.entries()) {
      const expected = captured.native.http[index], repeated = captured.repeat.http[index];
      compare(sample.name + ': independent Native full wire and effects', namedHttpProjection(repeated, sample.key), namedHttpProjection(expected, sample.key));
      const root = path.join(captured.output, 'node-http-' + index), directory = path.join(root, 'config');
      await fs.mkdir(directory, { recursive: true }); await fs.mkdir(path.join(root, 'transcodes'));
      const filename = path.join(directory, sample.key + '.xml');
      if (Object.hasOwn(sample, 'xml')) await fs.writeFile(filename, sample.xml);
      if (sample.physical === 'readonly') await fs.chmod(filename, 0o444);
      else if (sample.physical === 'target-directory') { await fs.unlink(filename); await fs.mkdir(filename); }
      let expectedCodecFailure = null;
      if (sample.invalidXml) try { parseConfigurationXml(await fs.readFile(filename), sample.key); } catch (error) { expectedCodecFailure = namedError(error); }
      if (sample.invalidXml) assert.notEqual(expectedCodecFailure, null, 'The retained original XML must produce an actual decoder failure.');
      const readAttempts = [];
      active = { sample, open: true, diagnostics: [], request: null };
      host = namedComponentHost({ configurationDirectoryPath: directory, fileSystem: { ...fs, async readFile(name, ...args) {
        const attempt = { owner: active?.request, filename: name, bytes: null, actualParserFailure: null, ioFailure: null };
        readAttempts.push(attempt);
        try {
          if (name === filename && sample.readMode === 'race-delete') await fs.unlink(name);
          const bytes = await fs.readFile(name, ...args); attempt.bytes = bytes.toString('base64');
          try { parseConfigurationXml(bytes, sample.key); } catch (error) { attempt.actualParserFailure = namedError(error); }
          return bytes;
        } catch (error) { attempt.ioFailure = namedError(error); throw error; }
      } }, onError: error => {
        const snapshot = { request: active?.request, failure: namedError(error) };
        if (active?.open) active.diagnostics.push(snapshot); else unownedErrors.push(snapshot);
      } });
      const events = [];
      host.store.on('updating', incoming => {
        events.push(structuredClone({ phase: 'updating', ...incoming }));
        if (sample.observer === 'updating') throw new Error('Controlled named updating failure.');
      });
      host.store.on('updated', incoming => {
        events.push(structuredClone({ phase: 'updated', ...incoming }));
        if (sample.observer === 'updated') throw new Error('Controlled named updated failure.');
      });
      await new Promise((resolve, reject) => { host.server.once('error', reject); host.server.listen(0, '127.0.0.1', () => {
        host.server.off('error', reject); resolve();
      }); });
      const request = async (method, body, owner) => {
        active.request = owner;
        let response, text = '', json = null, error = null;
        try {
          response = await fetch('http://127.0.0.1:' + host.server.address().port + '/System/Configuration/' + sample.key, {
            method, headers: { Accept: 'application/json', 'X-Identity': sample.identity ?? 'admin',
              ...(body === undefined ? {} : { 'Content-Type': sample.contentType ?? 'application/json' }) },
            ...(body === undefined ? {} : { body: body.replaceAll('@/', root.replaceAll('\\', '/') + '/') }),
          });
          text = await response.text(); try { json = parseLosslessJson(text); } catch { }
        } catch (failure) { error = namedError(failure); }
        return { status: response?.status ?? null, contentType: response?.headers.get('content-type') ?? null,
          headers: response ? Object.fromEntries(response.headers) : null, text, json, error };
      };
      const response = await request(sample.method, sample.body, 'response');
      const afterRead = await request('GET', undefined, 'afterRead');
      active.request = 'public manager read after HTTP';
      const live = known(sample.key) ? await host.store.getConfiguration(sample.key) : null;
      const disk = known(sample.key) ? await physicalDisk(filename, sample.key) : null;
      const actual = { name: sample.name, root, response, afterRead, live: structuredClone(live), events, disk,
        diagnostics: structuredClone(active.diagnostics), readAttempts: structuredClone(readAttempts) };
      compare(sample.name + ': complete original HTTP behavior, live values, events and disk', namedHttpProjection(actual, sample.key), namedHttpProjection(expected, sample.key));
      for (const diagnostic of actual.diagnostics) {
        assert.ok(['response', 'afterRead'].includes(diagnostic.request), 'Every action failure must keep its actual HTTP owner.');
        const rejected = actual[diagnostic.request];
        if (expectedCodecFailure !== null && diagnostic.request === 'response') {
          assert.deepEqual(namedFailurePayload(diagnostic.failure), namedFailurePayload(expectedCodecFailure), 'The successful fallback keeps its exact failed XML decoder values.');
          assert.ok(actual.readAttempts.some(attempt => {
            if (attempt.owner !== diagnostic.request || attempt.actualParserFailure === null) return false;
            try { assert.deepEqual(namedFailurePayload(diagnostic.failure), namedFailurePayload(attempt.actualParserFailure)); return true; } catch { return false; }
          }), 'The optional fallback diagnostic must retain this actual read and its failed bytes.');
          continue;
        }
        assert.ok(rejected.status >= 400 || rejected.error !== null,
          'A successful HTTP request cannot classify an unrelated action or load failure.');
        assert.equal(diagnostic.failure.status ?? diagnostic.failure.statusCode ?? 500, rejected.status);
      }
      for (const owner of ['response', 'afterRead']) if ((actual[owner].status < 400 && actual[owner].error === null || actual[owner].json?.errors)
        && !(expectedCodecFailure !== null && owner === 'response')) {
        assert.deepEqual(actual.diagnostics.filter(diagnostic => diagnostic.request === owner), [], sample.name + ': no optional successful failure');
      }
      active.open = false; await host.close(); host = null;
      if (sample.physical === 'readonly') await fs.chmod(filename, 0o666);
      actual.normalCloseCompleted = true;
      if (known(sample.key)) consumed.push({ name: sample.name, root: sample.key, filename, state: disk, nodeRoot: root });
      report.comparisons.push({ sample, actual, expected });
    }
    const consumption = await captured.consume(consumed.map(({ name, root, filename }) => ({ name, root, filename })), 'node-http-cold-read');
    report.nodeFilesReadByFreshNative = consumption;
    assert.deepEqual(consumption.native.consumed.map(row => row.name), consumed.map(row => row.name));
    for (const [index, cold] of consumption.native.consumed.entries()) {
      const original = consumed[index]; assert.equal(cold.disk.bytes, original.state.bytes, original.name + ': original Node file bytes');
      compare(original.name + ': actual Node bytes in fresh Native reader', namedNormalise(namedDiskProjection(original.state, original.root), original.nodeRoot),
        namedNormalise(namedDiskProjection(cold.disk, original.root), original.nodeRoot));
    }
    assert.deepEqual(report.differences, [], configurationJson(report.differences.slice(0, 6)));
    assert.deepEqual(unownedErrors, [], 'Normal close and background errors are independent from request diagnostics.');
    report.componentAcceptance = true; report.cleanup.nodeHostsClosed = true;
  } catch (error) { failure = error; report.failure = namedError(error); }
  finally {
    active = null;
    try { await host?.close(); } catch (error) { cleanupFailures.push(error); }
    if (unownedErrors.length) cleanupFailures.push(new Error('Unowned named configuration errors were observed.', { cause: unownedErrors }));
    if (cleanupFailures.length) report.componentAcceptance = false;
    report.cleanup.errors = cleanupFailures.map(namedError); report.cleanup.unownedErrors = unownedErrors;
    await fs.writeFile(path.join(captured.output, 'http-comparison.json'), configurationJson(report), { flag: 'wx' });
    if (cleanupFailures.length) throw new AggregateError(failure ? [failure, ...cleanupFailures] : cleanupFailures,
      failure?.message ?? cleanupFailures[0].message, { cause: failure ?? cleanupFailures[0] });
  }
  if (failure) throw failure;
});
