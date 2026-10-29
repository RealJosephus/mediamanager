import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { dependencyClosure } from '../validation/inventory.js';
import { repositoryRoot, validationPath } from '../validation/paths.js';
import { releasePairEnabled } from './release-pair.js';

export const provisionedServices = ['postgres', 'dotnet'];
export const provisionedTools = ['dotnet', 'ffmpeg', 'ffprobe', 'git', 'tar'];

export function ciTestConcurrency(environment) {
  const value = environment.MEDIAMANAGER_CI_TEST_CONCURRENCY ?? '1';
  if (!/^[1-4]$/u.test(String(value))) throw new Error('CI test concurrency must be an integer from 1 to 4.');
  return Number(value);
}

export function ciProfile(environment) {
  const configured = environment.MEDIAMANAGER_CI_PROFILE || 'available';
  if (!['available', 'full'].includes(configured)) throw new Error('CI profile must be available or full.');
  const profile = releasePairEnabled(environment) ? 'full' : configured;
  if (profile === 'full' && (environment.MEDIAMANAGER_CI_TEST_FILES ?? '').split(/[\r\n,]+/u).some(value => value.trim())) {
    throw new Error('The full profile cannot be combined with an explicit test subset.');
  }
  return profile;
}

export function ciExecutionArguments(scope, output) {
  if (scope.schemaVersion !== 1 || !Array.isArray(scope.selected) || !scope.selected.length) throw new Error('Invalid CI scope.');
  const concurrency = String(ciTestConcurrency({ MEDIAMANAGER_CI_TEST_CONCURRENCY: scope.testConcurrency ?? 1 }));
  if (scope.releasePair && (scope.profile !== 'full' || scope.sharding?.index !== 1 || scope.sharding?.total !== 1)) {
    throw new Error('Release pairs require the complete unsharded full profile.');
  }
  if (scope.profile === 'full') {
    if (scope.requested?.length || scope.excluded?.length || !Array.isArray(scope.discovered)
      || new Set(scope.selected).size !== scope.selected.length
      || JSON.stringify(scope.selected) !== JSON.stringify(scope.discovered)) {
      throw new Error('The full CI profile must retain every discovered test without an explicit subset.');
    }
    return ['--output', output, '--concurrency', concurrency, '--profile', 'full'];
  }
  if (scope.profile !== 'ci-available') throw new Error('Invalid CI profile.');
  return ['--output', output, '--concurrency', concurrency, '--', ...scope.selected];
}

export const provisionedServicesFor = environment => {
  if ((environment.MEDIAMANAGER_CI_WEB_CLIENTS === 'true' || environment.MEDIAMANAGER_CI_EMBY_WEB === 'true')
    && environment.MEDIAMANAGER_CI_NATIVE_SQLITE !== 'true') {
    throw new Error('Web client validation requires current native SQLite provisioning.');
  }
  if (environment.MEDIAMANAGER_CI_NATIVE_SQLITE === 'true' && environment.MEDIAMANAGER_CI_NATIVE_INSTANCE !== 'true') {
    throw new Error('Current native SQLite provisioning requires native instance provisioning.');
  }
  if (environment.MEDIAMANAGER_CI_DVD_REFERENCE === 'true' && environment.MEDIAMANAGER_CI_NATIVE_INSTANCE !== 'true') {
    throw new Error('Original DVD provisioning requires native instance provisioning.');
  }
  if (environment.MEDIAMANAGER_CI_BLURAY_REFERENCE === 'true' && environment.MEDIAMANAGER_CI_NATIVE_INSTANCE !== 'true') {
    throw new Error('Original Blu-ray provisioning requires native instance provisioning.');
  }
  if (environment.MEDIAMANAGER_CI_NATIVE_INSTANCE === 'true' && environment.MEDIAMANAGER_CI_NATIVE_REFERENCE !== 'true') {
    throw new Error('Native instance provisioning requires native reference provisioning.');
  }
  return [...provisionedServices,
    ...(environment.MEDIAMANAGER_CI_NATIVE_REFERENCE === 'true' ? ['jellyfinDll'] : []),
    ...(environment.MEDIAMANAGER_CI_NATIVE_INSTANCE === 'true' ? ['nativeInstance'] : []),
    ...(environment.MEDIAMANAGER_CI_NATIVE_SQLITE === 'true' ? ['currentNativeSqlite'] : []),
    ...(environment.MEDIAMANAGER_CI_DVD_REFERENCE === 'true' ? ['dvdReference'] : []),
    ...(environment.MEDIAMANAGER_CI_BLURAY_REFERENCE === 'true' ? ['blurayReference'] : []),
    ...(environment.MEDIAMANAGER_CI_WEB_CLIENTS === 'true' ? ['jellyfinWeb'] : []),
    ...(environment.MEDIAMANAGER_CI_EMBY_WEB === 'true' ? ['embyWeb'] : []),
    ...(environment.MEDIAMANAGER_CI_WEB_CLIENTS === 'true' || environment.MEDIAMANAGER_CI_EMBY_WEB === 'true' ? ['browser'] : []),
    ...(environment.MEDIAMANAGER_CI_ALIST_REFERENCE === 'true' ? ['alist'] : []),
    ...(typeof environment.MEDIAMANAGER_WEBDAV_EXECUTABLE === 'string'
      && path.isAbsolute(environment.MEDIAMANAGER_WEBDAV_EXECUTABLE) ? ['webdav'] : [])];
};

const unknown = Symbol('unknown');
const key = node => node?.computed ? node.property?.value : node?.property?.name;
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

// Evaluate only side-effect-free syntax. Unknown guards remain subject to the
// strict runner's zero-skip gate; test code is never imported to select scope.
export function skipGuards(source, environment, platform) {
  const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = new Map(), guards = [];
  walk(syntax, node => {
    if (node.type === 'VariableDeclaration' && node.kind === 'const') for (const declaration of node.declarations) {
      if (declaration.id.type !== 'Identifier') continue;
      const name = declaration.id.name;
      declarations.set(name, declarations.has(name) ? null : declaration.init);
    }
    if (node.type === 'Property' && !node.computed && (node.key.name ?? node.key.value) === 'skip') guards.push(node.value);
  });
  const evaluate = (node, seen = new Set()) => {
    if (!node) return unknown;
    if (node.type === 'Literal') return node.value;
    if (node.type === 'Identifier' && node.name === 'undefined') return undefined;
    if (node.type === 'Identifier' && declarations.has(node.name) && !seen.has(node.name)) {
      return evaluate(declarations.get(node.name), new Set([...seen, node.name]));
    }
    if (node.type === 'MemberExpression' && node.object?.name === 'process' && key(node) === 'platform') return platform;
    if (node.type === 'MemberExpression' && node.object?.type === 'MemberExpression'
      && node.object.object?.name === 'process' && key(node.object) === 'env' && typeof key(node) === 'string') return environment[key(node)];
    if (node.type === 'UnaryExpression' && node.operator === '!') {
      const value = evaluate(node.argument, seen); return value === unknown ? unknown : !value;
    }
    if (node.type === 'LogicalExpression') {
      const left = evaluate(node.left, seen), right = evaluate(node.right, seen);
      if (node.operator === '&&') {
        if (left !== unknown && !left) return left;
        if (right !== unknown && !right) return right;
        return left === unknown ? unknown : right;
      }
      if (node.operator === '||') {
        if (left !== unknown && left) return left;
        if (right !== unknown && right) return right;
        return left === unknown ? unknown : right;
      }
    }
    if (node.type === 'BinaryExpression') {
      const left = evaluate(node.left, seen), right = evaluate(node.right, seen);
      if (left === unknown || right === unknown) return unknown;
      if (node.operator === '===') return left === right;
      if (node.operator === '!==') return left !== right;
    }
    return unknown;
  };
  return guards.map(node => {
    const result = evaluate(node);
    return { expression: source.slice(node.start, node.end), status: result === unknown ? 'runtime-check' : result ? 'skips' : 'runs' };
  });
}

export function repositoryRelative(filename) {
  const relative = path.relative(repositoryRoot, filename).replaceAll('\\', '/');
  return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null;
}

export function restrictToRequested(classification, raw = '') {
  if (typeof raw !== 'string') throw new TypeError('Requested tests must be newline- or comma-separated text.');
  const requested = raw.split(/[\r\n,]+/u).map(value => value.trim()).filter(Boolean);
  if (!requested.length) return { requested, infrastructureErrors: [] };
  const discovered = new Set(classification.records.map(record => record.path));
  const names = new Set();
  // Validate the entire request before mutating the available-input selection.
  for (const filename of requested) {
    if (names.has(filename)) throw new Error(`Duplicate requested test: ${filename}`);
    if (!discovered.has(filename)) throw new Error(`Unknown requested test: ${filename}`);
    names.add(filename);
  }
  const infrastructureErrors = [];
  for (const record of classification.records) {
    if (!names.has(record.path)) {
      record.selected = false;
      if (!record.reasons.some(reason => reason.code === 'not-requested')) record.reasons.push({ code: 'not-requested' });
    } else if (!record.selected) {
      infrastructureErrors.push({ code: 'requested-test-unavailable', filename: record.path, reasons: [...record.reasons] });
    }
  }
  return { requested, infrastructureErrors };
}

export async function classify({ dependencies, tracked, environment, platform = process.platform }) {
  const records = [], closures = new Map();
  const guards = new Map();
  const services = provisionedServicesFor(environment);
  // Provisioning failures must fail execution, never make the selected scope smaller.
  const plannedEnvironment = { ...environment, MEDIAMANAGER_TEST_POSTGRES: environment.MEDIAMANAGER_TEST_POSTGRES || '<provisioned>',
    MEDIAMANAGER_DOTNET: environment.MEDIAMANAGER_DOTNET || '<provisioned>',
    ...(services.includes('alist') ? { MEDIAMANAGER_ALIST_EXECUTABLE: environment.MEDIAMANAGER_ALIST_EXECUTABLE || '<provisioned>' } : {}),
    ...(services.includes('nativeInstance') ? { MEDIAMANAGER_TEST_NATIVE_INSTANCE: environment.MEDIAMANAGER_TEST_NATIVE_INSTANCE || '<provisioned>',
      MEDIAMANAGER_NATIVE_INSTANCE_ROOT: environment.MEDIAMANAGER_NATIVE_INSTANCE_ROOT || '<provisioned>' } : {}),
    ...(services.includes('currentNativeSqlite') ? {
      MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE: environment.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE || '<provisioned>',
      MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON: environment.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON || '<provisioned>',
    } : {}),
    ...(services.includes('jellyfinWeb') ? { MEDIAMANAGER_JELLYFIN_WEB_ROOT: environment.MEDIAMANAGER_JELLYFIN_WEB_ROOT || '<provisioned>' } : {}),
    ...(services.includes('embyWeb') ? { MEDIAMANAGER_EMBY_WEB_ROOT: environment.MEDIAMANAGER_EMBY_WEB_ROOT || '<provisioned>' } : {}),
    ...(services.includes('browser') ? { MEDIAMANAGER_BROWSER_EXECUTABLE: environment.MEDIAMANAGER_BROWSER_EXECUTABLE || '<provisioned>' } : {}),
    ...(services.includes('jellyfinDll') ? { MEDIAMANAGER_JELLYFIN_DLL: environment.MEDIAMANAGER_JELLYFIN_DLL || '<provisioned>' } : {}) };
  const shipped = filename => {
    const relative = repositoryRelative(filename);
    return relative !== null && (tracked.has(relative) || [...tracked].some(file => file.startsWith(relative + '/')));
  };
  for (const test of dependencies.entries.filter(entry => entry.test)) {
    const record = { path: test.path, selected: true, reasons: [], dependencies: [], services: [], tools: [], guards: [] };
    let closure;
    try { closure = dependencyClosure(dependencies, [test.path]); }
    catch (error) { record.reasons.push({ code: 'unresolved-import', detail: error.message }); closure = []; }
    closures.set(test.path, new Set(closure.map(entry => entry.path)));
    record.dependencies = closure.map(entry => entry.path);
    record.services = [...new Set(closure.flatMap(entry => entry.services))].sort();
    record.tools = [...new Set(closure.flatMap(entry => entry.tools))].sort();
    for (const entry of closure) {
      for (const name of entry.services.filter(name => !services.includes(name))) {
        record.reasons.push({ code: 'service-not-provisioned', consumer: entry.path, service: name });
      }
      for (const name of entry.tools.filter(name => !provisionedTools.includes(name))) {
        record.reasons.push({ code: 'tool-not-provisioned', consumer: entry.path, tool: name });
      }
      if (entry.conditionalRegistration) record.reasons.push({ code: 'conditional-registration', consumer: entry.path });
      for (const executable of entry.unresolvedExecutables || []) record.reasons.push({ code: 'unresolved-executable', consumer: entry.path, ...executable });
      for (const reference of [...entry.declaredReferences.filter(value => value.required), ...entry.fixtureReferences]) {
        let filename = reference.filename;
        if (reference.dynamic) {
          const prefix = reference.logicalPath.split(/\$\{|[?*]/u)[0];
          filename = validationPath(prefix.endsWith('/') ? prefix : path.dirname(prefix), repositoryRoot, environment);
        }
        if (!filename || !shipped(filename)) record.reasons.push({ code: 'input-not-shipped', consumer: entry.path,
          input: reference.logicalPath ?? filename, filename });
        else if (reference.available === false) record.reasons.push({ code: 'input-unavailable', consumer: entry.path, filename });
      }
      if (entry.test) {
        if (!guards.has(entry.path)) guards.set(entry.path, skipGuards(await readFile(path.join(repositoryRoot, entry.path), 'utf8'), plannedEnvironment, platform));
        record.guards.push(...guards.get(entry.path).map(guard => ({ consumer: entry.path, ...guard })));
      }
    }
    for (const guard of record.guards.filter(guard => guard.status === 'skips')) record.reasons.push({ code: 'declared-skip', ...guard });
    record.reasons = [...new Map(record.reasons.map(reason => [JSON.stringify(reason), reason])).values()];
    record.selected = record.reasons.length === 0;
    records.push(record);
  }
  return { records, closures };
}

export function applyInputIdentity(classification, identity, tracked) {
  const infrastructureErrors = [];
  const sources = [...new Set([...classification.closures.values()].flatMap(closure => [...closure]))];
  for (const input of identity.entries.filter(entry => entry.required)) {
    const requiredReasons = input.requiredReasons;
    if (!Array.isArray(requiredReasons) || !requiredReasons.length
      || requiredReasons.some(reason => typeof reason !== 'string' || !input.reasons.includes(reason))) {
      throw new TypeError(`Required input has invalid required-reason ownership: ${input.filename}`);
    }
    const supplied = requiredReasons.some(reason => /^(?:runtime|service|tool):/u.test(reason));
    const relative = repositoryRelative(input.filename);
    let code = input.invalidExpectedDigest ? 'input-digest-mismatch'
      // A hosted runner may happen to have a different executable at an old
      // recording's absolute path. That does not supply the recorded identity,
      // even if the incidental bytes match. Only declared current inputs are
      // held to the provisioning/digest failure gate below.
      : !supplied && relative === null ? 'input-not-shipped'
      : !input.available ? 'input-unavailable' : input.expectedDigestMatched === false ? 'input-digest-mismatch' : null;
    // A supplied input that fails its pinned digest is corrupt, not an absent
    // platform dependency. Preserve selection and fail the validation attempt.
    if (code === 'input-digest-mismatch') {
      infrastructureErrors.push({ code, filename: input.filename, reasons: requiredReasons }); continue;
    }
    if (!supplied && !code) {
      const inspect = (description, prefix) => description.kind === 'directory'
        ? description.entries?.every(child => inspect(child, prefix + '/' + child.name))
        : tracked.has(prefix);
      if (relative === null || !inspect(input, relative)) code = 'input-not-shipped';
    }
    if (!code) continue;
    if (supplied) { infrastructureErrors.push({ code, filename: input.filename, reasons: requiredReasons }); continue; }
    const owners = sources.filter(source => requiredReasons.some(reason => reason.startsWith(source + ':')));
    let attributed = false;
    for (const record of classification.records) {
      if (!owners.some(source => classification.closures.get(record.path).has(source))) continue;
      record.reasons.push({ code, filename: input.filename, reasons: requiredReasons });
      record.selected = false; attributed = true;
    }
    if (!attributed && !classification.records.some(record => record.reasons.some(reason => reason.filename === input.filename))) {
      infrastructureErrors.push({ code: 'unattributed-input-failure', filename: input.filename, reasons: requiredReasons });
    }
  }
  return infrastructureErrors;
}
