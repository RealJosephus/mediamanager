import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as sync from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { NamedConfigurationStore } from '../../../../src/core/named-configuration-store.js';
import { defaultConfiguration, parseConfigurationXml } from '../../../../src/core/configuration-xml.js';
import { NetworkService } from '../../../../src/network/network-service.js';
import { StartupService } from '../../../../src/users/startup-service.js';
import { namedError, namedExpand, namedFailurePayload } from '../../../core/named-configuration-current.js';

export const disk = filename => {
  let bytes = null, directory = false, value = null, error = null, failed = false;
  try { directory = sync.statSync(filename).isDirectory(); if (!directory) bytes = sync.readFileSync(filename); }
  catch (failure) { if (!['ENOENT', 'ENOTDIR'].includes(failure.code)) { failed = true; error = namedError(failure); } }
  if (bytes !== null) try { value = parseConfigurationXml(bytes, 'network'); } catch (failure) { failed = true; error = namedError(failure); }
  return { bytes: bytes?.toString('base64') ?? null, directory, accepted: bytes === null ? null : !failed, value, error };
};

export async function candidateNetworkConfiguration(sample, root) {
  const directory = path.join(root, 'config'), filename = path.join(directory, sample.key.toLowerCase() + '.xml'); await fs.mkdir(directory, { recursive: true });
  if (Object.hasOwn(sample, 'xml')) await fs.writeFile(filename, sample.xml);
  let active, mode, observer;
  const warm = new Set(), retained = {}, events = [], steps = [], reads = [], diagnostics = [];
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory, fileSystem: { ...fs, async readFile(name, ...args) {
    const attempt = { owner: active, filename: name, bytes: null, parserFailure: null, sourceFailure: null }; reads.push(attempt);
    if (mode === 'io') {
      const cause = Object.assign(new Error('Original storage failure.'), { code: 'fixture-read-cause', status: 503, statusCode: 507,
        cause: undefined, errors: [false, 0, '', null, undefined], details: { name: 'Storage business name', stack: 'Storage business stack' } });
      const failure = Object.assign(new Error('Controlled named read failure.', { cause }), { code: 'EIO', status: 500, statusCode: 500 });
      attempt.sourceFailure = namedError(failure); attempt.sourceFailurePayload = namedFailurePayload(failure); throw failure;
    }
    try {
      const bytes = await fs.readFile(name, ...args); attempt.bytes = bytes.toString('base64');
      try { parseConfigurationXml(bytes, 'network'); } catch (error) { attempt.parserFailure = namedError(error); }
      return bytes;
    } catch (error) { attempt.sourceFailure = namedError(error); attempt.sourceFailurePayload = namedFailurePayload(error); throw error; }
  } }, onError: error => diagnostics.push({ owner: active, error: namedError(error) }) });
  const snapshot = () => structuredClone({ current: Object.fromEntries([...warm].map(key => [key, store.getCurrentConfiguration(key)])), retained,
    disk: disk(filename), linkedDisk: null, files: sync.readdirSync(directory).filter(name => name === 'network.xml').sort() });
  store.on('updating', incoming => { events.push(structuredClone({ phase: 'updating', ...incoming, state: snapshot() }));
    if (observer === 'updating') throw new Error('Controlled named updating failure.'); });
  store.on('updated', incoming => { events.push(structuredClone({ phase: 'updated', ...incoming, state: snapshot() }));
    if (observer === 'updated') throw new Error('Controlled named updated failure.'); });
  let result;
  try {
    const before = snapshot();
    for (const [index, step] of sample.steps.entries()) {
      active = { index, action: step.action, key: step.key ?? sample.key }; let value = null, error = null, failed = false, failurePayload;
      try {
        const key = active.key;
        if (step.action === 'get') { value = await store.getConfiguration(key); warm.add(key); if (step.retain) retained[step.retain] = value; }
        else if (step.action === 'save') { const incoming = Object.assign(defaultConfiguration('network'), namedExpand(step.values, root, key));
          if (step.retain) retained[step.retain] = incoming; await store.saveConfiguration(key, incoming); }
        else if (step.action === 'saveRetained') await store.saveConfiguration(key, retained[step.retain]);
        else if (step.action === 'mutate') Object.assign(retained[step.retain], namedExpand(step.values, root, key));
        else if (step.action === 'mutateBaseUrlFromSelf') retained[step.retain].BaseUrl = retained[step.retain].BaseUrl;
        else if (step.action === 'startup') {
          const startup = new StartupService({ users: {}, configuration: {}, namedConfiguration: store });
          try { await startup.updateRemoteAccess({ EnableRemoteAccess: step.enabled }); } finally { await startup.close(); }
        }
        else if (step.action === 'observer') observer = step.phase;
        else if (step.action === 'readMode') mode = step.mode;
        else if (step.action === 'physical' && step.mode === 'target-directory') { await fs.unlink(filename); await fs.mkdir(filename); }
        else if (step.action === 'physical' && step.mode === 'readonly') await fs.chmod(filename, 0o444);
        else if (step.action === 'physical' && step.mode === 'writable') await fs.chmod(filename, 0o666);
        else throw new Error('Unknown Network configuration fixture operation.');
      } catch (failure) { failed = true; error = namedError(failure); failurePayload = namedFailurePayload(failure); }
      steps.push(structuredClone({ step, accepted: !failed, result: value, error, failurePayload, state: snapshot() }));
    }
    if (sample.name === 'real-read-io-failure') {
      const rejected = steps.find(row => row.step.action === 'get' && !row.accepted);
      assert.ok(rejected, 'The actual named read must reject its current operation.');
      const source = reads.find(read => read.owner.index === steps.indexOf(rejected) && read.sourceFailurePayload?.code === 'EIO');
      assert.ok(source, 'The rejected operation must reach its actual EIO read owner.');
      assert.deepEqual(rejected.failurePayload, source.sourceFailurePayload);
      assert.deepEqual(rejected.failurePayload.cause.errors, [false, 0, '', null, undefined]);
      assert.deepEqual(rejected.failurePayload.cause.details, { name: 'Storage business name', stack: 'Storage business stack' });
    }
    result = { name: sample.name, key: sample.key, root, before, steps, events, after: snapshot(), diagnostics, reads, filename };
  } finally { await store.close(); }
  return result;
}

export async function candidateNetworkConsumer(sample, interfaces, root, urls = false) {
  const directory = path.join(root, 'config'); await fs.mkdir(directory, { recursive: true });
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory });
  const initial = Object.assign(defaultConfiguration('network'), sample.initial);
  await store.saveConfiguration('network', initial);
  let interfaceInput = interfaces, preparation = null;
  const prepareInterfaces = configuration => {
    interfaceInput = interfaces.filter(value => isIP(value.address) === 4 ? configuration.EnableIPv4 : configuration.EnableIPv6);
    preparation = structuredClone({ raw: interfaces, injected: interfaceInput, ipv4: configuration.EnableIPv4, ipv6: configuration.EnableIPv6 });
  };
  if (sample.prepareInterfaceFamilies) prepareInterfaces(initial);
  const initialInterfaceInput = preparation;
  const network = new NetworkService({ getNetworkConfiguration: () => store.getCurrentConfiguration('network'), namedConfiguration: store,
    getInterfaces: () => interfaceInput,
    getApplicationHost: () => ({ httpPort: initial.InternalHttpPort, httpsPort: initial.InternalHttpsPort, listenWithHttps: false }), publishedUrl: sample.publishedUrl,
    lookup: async hostname => { throw new Error('Unspecified DNS fixture: ' + hostname); } });
  const events = [], steps = [], diagnostics = [];
  network.logger = { error: error => diagnostics.push({ error: namedError(error) }) };
  let primary, primaryFailed = false, result;
  try {
    await network.initialize();
    store.on('updated', incoming => events.push(structuredClone(incoming)));
    for (const step of sample.steps) {
      let error = null, failed = false, failurePayload;
      try {
        if (step.action === 'save') {
          const incoming = Object.assign(defaultConfiguration('network'), step.values), key = step.key ?? 'network';
          if (sample.prepareInterfaceFamilies && key === 'network') prepareInterfaces(incoming);
          await store.saveConfiguration(key, incoming);
        }
        else if (step.action === 'mutate') Object.assign(store.getCurrentConfiguration('network'), step.values);
        else if (step.action !== 'inspect') throw new Error('Unknown network consumer fixture operation.');
      } catch (failure) { failed = true; error = namedError(failure); failurePayload = namedFailurePayload(failure); }
      const state = { step, accepted: !failed, error, failurePayload, interfaceInput: preparation, configuration: store.getCurrentConfiguration('network') };
      if (urls) {
        state.requests = sample.requests.map(request => ({ request,
          value: network.getSmartApiUrl({ headers: { host: request.host }, socket: { remoteAddress: request.remote, encrypted: request.scheme === 'https' } }) }));
        state.local = sample.localHosts.map(host => ({ host, value: network.getLocalApiUrl(host) }));
      } else state.addresses = sample.addresses.map(address => ({ address, local: network.isInLocalNetwork(address), allowed: network.shouldAllowServerAccess(address),
        bind: network.getBindAddress(address), direct: network.getBindAddress(address, { skipOverrides: true }) }));
      if (!urls) state.localUrls = ['10.20.0.10', '2001:db8:1::10'].map(host => ({ host, value: network.getLocalApiUrl(host) }));
      steps.push(structuredClone(state));
    }
    result = { name: sample.name, initialInterfaceInput, steps, events, diagnostics };
  } catch (error) { primaryFailed = true; primary = error; }
  finally {
    const cleanup = [];
    for (const close of [() => network.close(), () => store.close()]) try { await close(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(primaryFailed ? [primary, ...cleanup] : cleanup, 'Network component resources failed to close.', { cause: primaryFailed ? primary : cleanup[0] });
  }
  if (primaryFailed) throw primary;
  return result;
}
