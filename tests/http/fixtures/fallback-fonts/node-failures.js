import path from 'node:path';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, utimes } from 'node:fs/promises';
import { FallbackFonts } from '../../../../src/playback/fallback-fonts.js';
import { defaultConfiguration } from '../../../../src/core/configuration-xml.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../../../src/storage/index.js';
import { StorageFileSystem } from '../../../../src/storage/files.js';
import { LocalAdapter } from '../../../../plugins/local/adapter.js';
import { createTestApplication } from '../../../helpers/application.js';
import { fallbackFontFailureFiles } from './input.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const sourceError = error => error === undefined ? undefined : error === null || typeof error !== 'object' ? error : Array.isArray(error) ? error.map(sourceError) : {
  ...Object.fromEntries(Object.getOwnPropertyNames(error).map(key => [key,
    key === 'cause' ? sourceError(error[key]) : key === 'errors' ? Array.from(error[key], sourceError) : error[key]])),
};
const responseValue = response => ({ hasStarted: response.headersSent, status: response.statusCode, headers: { ...response.getHeaders() } });

export async function seedFaultFiles(directory) {
  for (const input of fallbackFontFailureFiles) {
    const filename = path.join(directory, input.path); await mkdir(path.dirname(filename), { recursive: true });
    const handle = await open(filename, 'wx');
    try { if (input.length === undefined) await handle.writeFile(Buffer.from(input.bytes, 'base64')); else await handle.truncate(input.length); }
    finally { await handle.close(); }
    await utimes(filename, new Date('2024-06-02T12:34:56Z'), new Date('2024-06-02T12:34:56Z'));
  }
}

/** Move only this capture's owned source; delegate every failure to real storage. */
export async function openMissingFontHost({ directory, assets = new Map() }) {
  const registry = new StorageRegistry(); registry.registerType('font-fault', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('fonts', 'font-fault', { root: directory, writable: false });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/fonts', instanceId: 'fonts', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: directory, accessRoot: '/fonts',
    style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
    returnAccess: 'Owned same-run missing-font capture files.' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap }), diagnostics = [], faults = [];
  const fonts = new FallbackFonts({ fileSystem, getEncodingOptions: () => ({ FallbackFontPath: path.join(directory, 'fonts-A'), EnableFallbackFont: true }) });
  let armed, executing, application;
  const missingFile = async (state, response, operation) => {
    const filename = state.filename, bytes = await readFile(filename), backup = filename + '.' + randomUUID() + '.held';
    const fault = state.executionFault = { phase: state.step.executionFault, filename, bytes: bytes.length, sha256: hash(bytes),
      before: responseValue(response), restored: false, cleanupFailed: false, cleanup: null };
    faults.push(fault); await rename(filename, backup);
    let failed = false, primary;
    try { return await operation(); }
    catch (error) { failed = true; primary = error; state.sourceFailed = true; state.sourceFailure = error; throw error; }
    finally {
      fault.after = responseValue(response);
      fault.failed = failed; fault.failureType = typeof primary; fault.failure = sourceError(primary);
      try { await rename(backup, filename); fault.restored = (await readFile(filename)).equals(bytes); }
      catch (error) {
        fault.cleanupFailed = true; fault.cleanupType = typeof error; fault.cleanup = sourceError(error);
        throw failed ? new AggregateError([primary, error], 'Owned font restoration failed.', { cause: primary }) : error;
      }
    }
  };
  const originalFile = fonts.file.bind(fonts), originalRead = fileSystem.openRead.bind(fileSystem);
  fonts.file = async (...args) => {
    const result = await originalFile(...args), state = armed;
    if (!state || typeof result.send !== 'function') return result;
    armed = undefined;
    const send = result.send.bind(result);
    result.send = async (incoming, response) => {
      state.request = incoming.url; state.response = response; executing = state;
      response.once('finish', () => { state.finalResponse = responseValue(response); });
      try {
        if (state.step.executionFault === 'delete-before-execution') return await missingFile(state, response, () => send(incoming, response));
        return await send(incoming, response);
      } finally { state.finalResponse = responseValue(response); executing = undefined; }
    };
    return result;
  };
  fileSystem.openRead = async (...args) => {
    const state = executing;
    if (state?.step.executionFault !== 'delete-before-sendfile') return originalRead(...args);
    return missingFile(state, state.response, () => originalRead(...args));
  };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'font-fault', isLocalNetwork: () => true });
  authentication.authenticate = async () => ({ IsAuthenticated: true, IsApiKey: true, IsAdministrator: true,
    UserId: 'f81b0000000000000000000000000001', User: { Policy: { EnableRemoteAccess: true }, AccessSchedules: [] } });
  try {
    application = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
      authentication, fallbackFonts: fonts, onError: (error, context) => diagnostics.push({ request: context.request.url, phase: context.phase, error }) });
    application.server.removeListener('request', application.handler);
    application.server.on('request', (incoming, response) => {
      const asset = assets.get(new URL(incoming.url, 'http://font-fault.invalid').pathname);
      if (asset) { response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length }); response.end(asset.bytes); return; }
      void application.handler(incoming, response);
    });
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    try { await registry.close(); }
    catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Missing-font host preparation and cleanup failed.', { cause: error }),
      Object.fromEntries(['code', 'status', 'statusCode'].filter(key => error?.[key] !== undefined).map(key => [key, error[key]]))); }
    throw error;
  }
  const origin = 'http://127.0.0.1:' + application.server.address().port;
  return { origin, diagnostics, faults, fileSystem,
    arm(step) {
      if (armed || executing) throw new Error('The previous owned font fault is still active.');
      const filename = path.join(directory, 'fonts-A', decodeURIComponent(new URL(step.path, origin).pathname.split('/').at(-1)));
      return armed = { step, filename };
    },
    async drain() { await application.drainRequests(); },
    async close() {
      const errors = [];
      for (const operation of [() => fonts.close(), async () => {
        application.beginClose(); await application.drainRequests();
        if (application.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
      }, () => registry.close()]) try { await operation(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Missing-font capture cleanup failed.', { cause: errors[0] });
    },
  };
}

/** Keep all received bytes, including an interrupted response, without replay. */
export async function captureFontResponse(origin, step, signal) {
  return new Promise(resolve => {
    const chunks = []; let response, finished = false;
    const finish = (bodyComplete, error) => {
      if (finished) return; finished = true;
      resolve({ name: step.name, status: response?.statusCode ?? null, headers: response?.headers ?? {},
        bodyBase64: Buffer.concat(chunks).toString('base64'), bodyComplete, clientFailure: sourceError(error) ?? null });
    };
    const client = request(origin + step.path, { method: step.method, headers: step.headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)].filter(Boolean)) }, incoming => {
      response = incoming;
      incoming.on('data', bytes => chunks.push(bytes));
      incoming.once('end', () => finish(true)); incoming.once('error', error => finish(false, error));
      incoming.once('close', () => { if (!incoming.complete) finish(false); });
    });
    client.once('error', error => finish(false, error)); client.end();
  });
}
