import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as sync from 'node:fs';
import path from 'node:path';
import { NamedConfigurationStore } from '../../../../src/core/named-configuration-store.js';
import { defaultConfiguration, parseConfigurationXml } from '../../../../src/core/configuration-xml.js';
import { namedError, namedExpand, namedFailurePayload } from '../../../core/named-configuration-current.js';

export const disk = filename => {
  let bytes = null, directory = false, value = null, error = null;
  try { directory = sync.statSync(filename).isDirectory(); if (!directory) bytes = sync.readFileSync(filename); }
  catch (failure) { if (!['ENOENT', 'ENOTDIR'].includes(failure.code)) error = namedError(failure); }
  if (bytes !== null) try { value = parseConfigurationXml(bytes, 'xbmcmetadata'); } catch (failure) { error = namedError(failure); }
  return { bytes: bytes?.toString('base64') ?? null, directory, accepted: bytes === null ? null : error === null, value, error };
};

export async function candidateNfoConfiguration(sample, root) {
  const directory = path.join(root, 'config'), filename = path.join(directory, 'xbmcmetadata.xml'); await fs.mkdir(directory, { recursive: true });
  if (Object.hasOwn(sample, 'xml')) await fs.writeFile(filename, sample.xml);
  let active, mode, observer;
  const warm = new Set(), retained = {}, events = [], steps = [], reads = [], diagnostics = [];
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory, fileSystem: { ...fs, async readFile(name, ...args) {
    const attempt = { owner: active, filename: name, bytes: null, parserFailure: null, sourceFailure: null }; reads.push(attempt);
    if (mode === 'io') {
      const cause = Object.assign(new Error('Original storage failure.'), { code: 'fixture-read-cause', status: 503, statusCode: 507 });
      const failure = Object.assign(new Error('Controlled named read failure.', { cause }), { code: 'EIO', status: 500, statusCode: 500 });
      attempt.sourceFailure = namedError(failure); throw failure;
    }
    try {
      const bytes = await fs.readFile(name, ...args); attempt.bytes = bytes.toString('base64');
      try { parseConfigurationXml(bytes, 'xbmcmetadata'); } catch (error) { attempt.parserFailure = namedError(error); }
      return bytes;
    } catch (error) { attempt.sourceFailure = namedError(error); throw error; }
  } }, onError: error => diagnostics.push({ owner: active, error: namedError(error) }) });
  const snapshot = () => structuredClone({ current: Object.fromEntries([...warm].map(key => [key, store.getCurrentConfiguration(key)])), retained,
    disk: disk(filename), linkedDisk: null, files: sync.readdirSync(directory).filter(name => name === 'xbmcmetadata.xml').sort() });
  store.on('updating', incoming => { events.push(structuredClone({ phase: 'updating', ...incoming, state: snapshot() }));
    if (observer === 'updating') throw new Error('Controlled named updating failure.'); });
  store.on('updated', incoming => { events.push(structuredClone({ phase: 'updated', ...incoming, state: snapshot() }));
    if (observer === 'updated') throw new Error('Controlled named updated failure.'); });
  let result;
  try {
    const before = snapshot();
    for (const [index, step] of sample.steps.entries()) {
      active = { index, action: step.action, key: step.key ?? sample.key }; let value = null, error = null;
      try {
        const key = active.key;
        if (step.action === 'get') { value = await store.getConfiguration(key); warm.add(key); if (step.retain) retained[step.retain] = value; }
        else if (step.action === 'save') { const incoming = { ...defaultConfiguration('xbmcmetadata'), ...namedExpand(step.values, root) };
          if (step.retain) retained[step.retain] = incoming; await store.saveConfiguration(key, incoming); }
        else if (step.action === 'saveRetained') await store.saveConfiguration(key, retained[step.retain]);
        else if (step.action === 'mutate') Object.assign(retained[step.retain], namedExpand(step.values, root));
        else if (step.action === 'observer') observer = step.phase;
        else if (step.action === 'readMode') mode = step.mode;
        else if (step.action === 'physical' && step.mode === 'target-directory') { await fs.unlink(filename); await fs.mkdir(filename); }
        else if (step.action === 'physical' && step.mode === 'readonly') await fs.chmod(filename, 0o444);
        else if (step.action === 'physical' && step.mode === 'writable') await fs.chmod(filename, 0o666);
        else throw new Error('Unknown NFO configuration fixture operation.');
      } catch (failure) { error = namedError(failure); }
      steps.push(structuredClone({ step, accepted: error === null, result: value, error, state: snapshot() }));
    }
    for (const diagnostic of diagnostics) {
      const source = reads.find(read => read.owner.index === diagnostic.owner.index && read.owner.key === diagnostic.owner.key
        && read.parserFailure !== null && JSON.stringify(namedFailurePayload(read.parserFailure)) === JSON.stringify(namedFailurePayload(diagnostic.error)));
      assert.ok(source, 'Every optional NFO load diagnostic belongs to the same actual read/decoder failure.');
    }
    if (sample.name === 'real-read-io-failure') {
      const source = reads.find(read => read.sourceFailure?.code === 'EIO'); assert.ok(source);
      const delivered = steps.find(row => row.step.action === 'get').error;
      assert.deepEqual(namedFailurePayload(delivered), namedFailurePayload(source.sourceFailure));
    }
    result = { name: sample.name, key: sample.key, root, before, steps, events, after: snapshot(), diagnostics, reads, filename };
  } finally { await store.close(); }
  return result;
}
