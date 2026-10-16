import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { dependencyClosure } from '../validation/inventory.js';
import { repositoryRoot, validationPath } from '../validation/paths.js';

export const provisionedServices = ['postgres', 'dotnet'];
export const provisionedTools = ['dotnet', 'ffmpeg', 'ffprobe', 'git'];

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

function rootsFor(entry, environment) {
  return [...entry.declaredReferences.filter(reference => reference.required).map(reference => {
    if (reference.dynamic) {
      const prefix = reference.logicalPath.split(/\$\{|[?*]/u)[0];
      return validationPath(prefix.endsWith('/') ? prefix : path.dirname(prefix), repositoryRoot, environment);
    }
    return reference.kind === 'file' ? path.dirname(reference.filename) : reference.filename;
  }), ...entry.fixtureReferences.map(reference => path.dirname(reference.filename))];
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function classify({ dependencies, tracked, environment, platform = process.platform }) {
  const records = [], closures = new Map(), roots = new Map();
  const guards = new Map();
  // Provisioning failures must fail execution, never make the selected scope smaller.
  const plannedEnvironment = { ...environment, MEDIAMANAGER_TEST_POSTGRES: environment.MEDIAMANAGER_TEST_POSTGRES || '<provisioned>',
    MEDIAMANAGER_DOTNET: environment.MEDIAMANAGER_DOTNET || '<provisioned>' };
  for (const entry of dependencies.entries) roots.set(entry.path, rootsFor(entry, environment));
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
      for (const name of entry.services.filter(name => !provisionedServices.includes(name))) {
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
  return { records, closures, roots };
}

export function applyInputIdentity(classification, identity, tracked) {
  const infrastructureErrors = [];
  for (const input of identity.entries.filter(entry => entry.required)) {
    const runtime = input.reasons.some(reason => reason.startsWith('runtime:'));
    const relative = repositoryRelative(input.filename);
    let code = !input.available ? 'input-unavailable' : input.expectedDigestMatched === false ? 'input-digest-mismatch' : null;
    if (!runtime && !code) {
      const inspect = (description, prefix) => description.kind === 'directory'
        ? description.entries?.every(child => inspect(child, prefix + '/' + child.name))
        : tracked.has(prefix);
      if (relative === null || !inspect(input, relative)) code = 'input-not-shipped';
    }
    if (!code) continue;
    if (runtime) { infrastructureErrors.push({ code, filename: input.filename, reasons: input.reasons }); continue; }
    const owners = [...classification.roots.keys()].filter(source => input.reasons.some(reason => reason.startsWith(source + ':')));
    const sharedRoots = owners.flatMap(owner => classification.roots.get(owner));
    const affectedSources = new Set([...owners, ...[...classification.roots].filter(([, roots]) =>
      roots.some(root => sharedRoots.some(shared => overlaps(root, shared) || overlaps(shared, root)))).map(([source]) => source)]);
    let attributed = false;
    for (const record of classification.records) {
      if (![...affectedSources].some(source => classification.closures.get(record.path).has(source))) continue;
      record.reasons.push({ code, filename: input.filename, reasons: input.reasons });
      record.selected = false; attributed = true;
    }
    if (!attributed && !classification.records.some(record => record.reasons.some(reason => reason.filename === input.filename))) {
      infrastructureErrors.push({ code: 'unattributed-input-failure', filename: input.filename, reasons: input.reasons });
    }
  }
  return infrastructureErrors;
}
