import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { parseLosslessJson } from '../../src/core/json.js';
import { parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { namedComponentHost } from '../core/fixtures/named-configuration-current/node-host.js';
import { currentNamedConfiguration, namedDiskProjection, namedError, namedHttpProjection, namedInput, namedExpandBody } from '../core/named-configuration-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const known = key => ['encoding', 'metadata'].includes(key);
const failureValue = error => {
  if (error == null || typeof error !== 'object') return error;
  if (Array.isArray(error)) return error.map(failureValue);
  const keys = new Set([...Object.getOwnPropertyNames(error),
    ...['message', 'code', 'status', 'statusCode', 'cause', 'errors', 'name', 'stack'].filter(key => key in error)]);
  return Object.fromEntries([...keys].filter(key => !(error instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, failureValue(error[key])]));
};
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
  let host, active, failed = false, failure;
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
      let expectedCodecFailed = false, expectedCodecFailure;
      if (sample.invalidXml) try { parseConfigurationXml(await fs.readFile(filename), sample.key); }
      catch (error) { expectedCodecFailed = true; expectedCodecFailure = failureValue(error); }
      if (sample.invalidXml) assert.equal(expectedCodecFailed, true, 'The retained original XML must produce an actual decoder failure.');
      const readAttempts = [];
      active = { sample, open: true, diagnostics: [], request: null };
      host = namedComponentHost({ configurationDirectoryPath: directory, fileSystem: { ...fs, async readFile(name, ...args) {
        const attempt = { owner: active?.request, filename: name, bytes: null, parserFailed: false, actualParserFailure: null, ioFailed: false, ioFailure: null };
        readAttempts.push(attempt);
        try {
          if (name === filename && sample.readMode === 'race-delete') await fs.unlink(name);
          const bytes = await fs.readFile(name, ...args); attempt.bytes = bytes.toString('base64');
          try { parseConfigurationXml(bytes, sample.key); }
          catch (error) {
            attempt.parserFailed = true; attempt.actualParserFailure = namedError(error);
            attempt.parserFailureValue = failureValue(error); attempt.parserFailureRaw = inspect(error, { depth: null });
          }
          return bytes;
        } catch (error) { attempt.ioFailed = true; attempt.ioFailure = namedError(error); throw error; }
      } }, onError: error => {
        const snapshot = { request: active?.request, failure: namedError(error), raw: inspect(error, { depth: null }) };
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
            ...(body === undefined ? {} : { body: namedExpandBody(body, root, sample.key) }),
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
      if (sample.invalidXml) {
        const attempted = actual.readAttempts.filter(attempt => attempt.owner === 'response'
          && attempt.filename === filename && attempt.bytes === Buffer.from(sample.xml).toString('base64'));
        assert.ok(attempted.some(attempt => attempt.parserFailed),
          'The actual HTTP fallback must read the original malformed XML bytes.');
        for (const attempt of attempted.filter(attempt => attempt.parserFailed)) {
          assert.deepEqual(attempt.parserFailureValue, expectedCodecFailure,
            'The original bytes retain the actual failed decoder values independently of logging.');
        }
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
      compare(original.name + ': actual Node bytes in fresh Native reader', namedDiskProjection(original.state, original.root, original.nodeRoot),
        namedDiskProjection(cold.disk, original.root, original.nodeRoot));
    }
    assert.deepEqual(report.differences, [], configurationJson(report.differences.slice(0, 6)));
    report.componentAcceptance = true; report.cleanup.nodeHostsClosed = true;
  } catch (error) { failed = true; failure = error; report.failure = namedError(error); report.failureRaw = inspect(error, { depth: null }); }
  finally {
    active = null;
    try { await host?.close(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) report.componentAcceptance = false;
    report.cleanup.errors = cleanupFailures.map(namedError);
    report.cleanup.rawErrors = cleanupFailures.map(error => inspect(error, { depth: null })); report.cleanup.unownedErrors = unownedErrors;
    await fs.writeFile(path.join(captured.output, 'http-comparison.json'), configurationJson(report), { flag: 'wx' });
    if (cleanupFailures.length) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures,
      'Named configuration HTTP and cleanup failed.', { cause: failed ? failure : cleanupFailures[0] });
  }
  if (failed) throw failure;
});
