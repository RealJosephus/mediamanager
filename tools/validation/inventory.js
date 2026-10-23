import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { repositoryRoot, validationPath } from './paths.js';

export const dependencyVariables = Object.freeze({
  postgres: 'MEDIAMANAGER_TEST_POSTGRES',
  nativeSqlite: 'MEDIAMANAGER_TEST_NATIVE_SQLITE',
  currentNativeSqlite: 'MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE',
  jellyfinWeb: 'MEDIAMANAGER_JELLYFIN_WEB_ROOT',
  embyWeb: 'MEDIAMANAGER_EMBY_WEB_ROOT',
  browser: 'MEDIAMANAGER_BROWSER_EXECUTABLE',
  nativeInstance: 'MEDIAMANAGER_TEST_NATIVE_INSTANCE',
  jellyfinDll: 'MEDIAMANAGER_JELLYFIN_DLL',
  dotnet: 'MEDIAMANAGER_DOTNET',
  alist: 'MEDIAMANAGER_ALIST_EXECUTABLE',
  webdav: 'MEDIAMANAGER_WEBDAV_EXECUTABLE',
});

export async function filesIn(directory, traversal = null) {
  const resolvedDirectory = path.resolve(directory);
  const directoryInfo = await lstat(resolvedDirectory);
  if (directoryInfo.isSymbolicLink()) {
    throw new Error(`Symbolic links are not supported in validation discovery: ${resolvedDirectory}.`);
  }
  if (!directoryInfo.isDirectory()) {
    throw new Error(`Validation discovery requires a directory: ${resolvedDirectory}.`);
  }
  const directoryRealPath = await realpath(resolvedDirectory);
  const state = traversal || { root: resolvedDirectory, rootRealPath: directoryRealPath };
  if (!isWithin(state.rootRealPath, directoryRealPath)) {
    throw new Error(`Validation discovery escaped its real root: ${resolvedDirectory}.`);
  }
  const files = [];
  for (const entry of await readdir(resolvedDirectory, { withFileTypes: true })) {
    const filename = path.join(resolvedDirectory, entry.name);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported in validation discovery: ${filename}.`);
    if (info.isDirectory()) files.push(...await filesIn(filename, state));
    else if (info.isFile()) files.push(filename);
    else throw new Error(`Unsupported filesystem entry in validation discovery: ${filename}.`);
  }
  return files.sort();
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function walkSyntax(node, visit, parent = null, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'range'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkSyntax(child, visit, node, [...ancestors, node]);
    } else if (value && typeof value === 'object') walkSyntax(value, visit, node, [...ancestors, node]);
  }
}

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left); const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function staticSpecifier(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return staticString(node.property);
}

function propertyKeyName(property) {
  if (property?.type !== 'Property') return null;
  if (!property.computed && property.key?.type === 'Identifier') return property.key.name;
  return staticString(property.key);
}

function patternBinds(pattern, name) {
  if (!pattern) return false;
  if (pattern.type === 'Identifier') return pattern.name === name;
  if (pattern.type === 'AssignmentPattern') return patternBinds(pattern.left, name);
  if (pattern.type === 'RestElement') return patternBinds(pattern.argument, name);
  if (pattern.type === 'ArrayPattern') return pattern.elements.some(element => patternBinds(element, name));
  if (pattern.type === 'ObjectPattern') return pattern.properties.some(property =>
    patternBinds(property.type === 'RestElement' ? property.argument : property.value, name));
  return false;
}

function localSpecifier(specifier) {
  return specifier.startsWith('@mediamanager/plugin-sdk/') || /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|file:)/u.test(specifier);
}

function referenceDeclarations(source, nodes) {
  const declarations = new Map();
  const readsFiles = /\b(?:readFile|readFileSync|openSync|SqliteDatabase)\b/u.test(source);
  const callName = node => node.callee?.type === 'Identifier' ? node.callee.name : memberName(node.callee);
  for (const { node, ancestors } of nodes) {
    const value = staticString(node) ?? (node.type === 'TemplateLiteral' ? source.slice(node.start + 1, node.end - 1) : null);
    if (value == null || !/^(?:\.\.\/)*\.agent-docs\//u.test(value)) continue;
    const calls = ancestors.filter(parent => ['CallExpression', 'NewExpression'].includes(parent.type));
    const read = calls.some(call => ['readFile', 'readFileSync', 'openSync', 'SqliteDatabase'].includes(callName(call)));
    const output = !read && calls.some(call => ['writeFile', 'writeFileSync'].includes(callName(call)));
    const assertion = calls.some(call => call.callee?.type === 'MemberExpression'
      && call.callee.object?.type === 'Identifier' && call.callee.object.name === 'assert');
    const logicalPath = value.replace(/^(?:\.\.\/)+/u, ''), required = readsFiles && (read || !output && !assertion);
    const previous = declarations.get(logicalPath);
    declarations.set(logicalPath, { logicalPath, dynamic: /\$\{|[?*]/u.test(logicalPath),
      required: required || previous?.required === true,
      ...(!required && output && (!previous || previous.usage === 'output-declaration') ? { usage: 'output-declaration' } : {}) });
  }
  return [...declarations.values()];
}

export function analyzeJavaScriptDependencies(source) {
  let syntax;
  try {
    syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (error) {
    return { importSpecifiers: [], unresolvedImports: [{ kind: 'parse', reason: error.message }],
      unresolvedExecutables: [], tools: [], environmentVariables: [], testRegistrations: 0,
      conditionalRegistration: true, referenceDeclarations: [], fixtureSpecifiers: [] };
  }
  const imports = new Map();
  const fixtureSpecifiers = new Set();
  const unresolved = new Map();
  const unresolvedExecutables = new Map();
  const tools = new Set();
  const environmentVariables = new Set();
  const nodes = [];
  walkSyntax(syntax, (node, parent, ancestors) => nodes.push({ node, parent, ancestors }));
  const shadowedUrl = nodes.some(({ node }) =>
    node.type === 'VariableDeclarator' && patternBinds(node.id, 'URL')
    || ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
      && (patternBinds(node.id, 'URL') || node.params.some(parameter => patternBinds(parameter, 'URL')))
    || ['ClassDeclaration', 'ClassExpression'].includes(node.type) && patternBinds(node.id, 'URL')
    || node.type === 'CatchClause' && patternBinds(node.param, 'URL')
    || ['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type) && node.local.name === 'URL'
    || ['AssignmentExpression', 'UpdateExpression'].includes(node.type) && (
      patternBinds(node.left ?? node.argument, 'URL') || (node.left ?? node.argument)?.type === 'MemberExpression'
        && (node.left ?? node.argument).object?.type === 'Identifier' && (node.left ?? node.argument).object.name === 'globalThis'
        && memberName(node.left ?? node.argument) === 'URL')
    || node.type === 'VariableDeclarator' && node.init?.type === 'MetaProperty' && node.init.meta?.name === 'import'
    || node.type === 'CallExpression' && node.arguments.some(argument => argument.type === 'MetaProperty' && argument.meta?.name === 'import')
    || ['AssignmentExpression', 'UpdateExpression'].includes(node.type)
      && (node.left ?? node.argument)?.type === 'MemberExpression' && (node.left ?? node.argument).object?.type === 'MetaProperty'
      && (node.left ?? node.argument).object.meta?.name === 'import');
  const declarationLists = new Map();
  for (const { node, parent } of nodes) {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || parent?.type !== 'VariableDeclaration'
      || parent.kind !== 'const') continue;
    if (!declarationLists.has(node.id.name)) declarationLists.set(node.id.name, []);
    declarationLists.get(node.id.name).push(node);
  }
  const createRequireNames = new Set(['createRequire']);
  const moduleNamespaces = new Set();
  const launchers = new Map();
  const childProcessNamespaces = new Set();
  const unsupportedExecutionNames = new Set();
  const unsafeRuntimeLoads = [];
  const processNamespaces = new Set(['process']);
  const runtimeModuleMembers = new Set(['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen']);
  const workerNames = new Set();
  const validationExecutableNames = new Set(['validationExecutable']);
  for (const { node } of nodes) {
    if (node.type !== 'ImportDeclaration') continue;
    const moduleName = String(node.source.value).replace(/^node:/u, '');
    if (moduleName === 'process') for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.imported.name === 'default') {
        processNamespaces.add(specifier.local.name);
      } else if (runtimeModuleMembers.has(specifier.imported.name)) unsafeRuntimeLoads.push(specifier);
    }
    if (['cluster', 'vm', 'inspector', 'repl'].includes(moduleName)) unsafeRuntimeLoads.push(node);
    if (moduleName === 'worker_threads') {
      if (node.specifiers.some(specifier => specifier.type !== 'ImportSpecifier'
        || !['Worker', 'parentPort', 'workerData', 'isMainThread', 'threadId'].includes(specifier.imported.name))) unsafeRuntimeLoads.push(node);
      for (const specifier of node.specifiers) if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'Worker') workerNames.add(specifier.local.name);
    }
    for (const specifier of node.specifiers) {
      if (moduleName === 'module' && specifier.type === 'ImportSpecifier' && specifier.imported.name === 'createRequire') {
        createRequireNames.add(specifier.local.name);
      } else if (moduleName === 'module'
        && (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier')) {
        moduleNamespaces.add(specifier.local.name);
      }
      if (moduleName === 'child_process' && specifier.type === 'ImportSpecifier'
        && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(specifier.imported.name)) {
        launchers.set(specifier.local.name, specifier.imported.name);
      } else if (moduleName === 'child_process' && specifier.type === 'ImportSpecifier'
        && ['exec', 'execSync', 'fork'].includes(specifier.imported.name)) {
        unsupportedExecutionNames.add(specifier.local.name);
      } else if (moduleName === 'child_process'
        && (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier')) {
        childProcessNamespaces.add(specifier.local.name);
      }
      if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'validationExecutable') {
        validationExecutableNames.add(specifier.local.name);
      }
      if (moduleName === 'module' && specifier.type === 'ImportSpecifier'
        && ['register', 'registerHooks'].includes(specifier.imported.name)) unsupportedExecutionNames.add(specifier.local.name);
    }
  }
  const requiredModule = node => node?.type === 'CallExpression' && node.callee?.type === 'Identifier'
    && node.callee.name === 'require' && ['child_process', 'node:child_process'].includes(staticSpecifier(node.arguments[0]));
  const importedModule = node => {
    const expression = node?.type === 'AwaitExpression' ? node.argument : node;
    return expression?.type === 'ImportExpression'
      && ['child_process', 'node:child_process'].includes(staticSpecifier(expression.source));
  };
  for (const { node } of nodes) {
    if (node.type !== 'VariableDeclarator') continue;
    if (requiredModule(node.init) || importedModule(node.init)) {
      if (node.id.type === 'Identifier') childProcessNamespaces.add(node.id.name);
      if (node.id.type === 'ObjectPattern') {
        for (const property of node.id.properties) {
          const capability = propertyKeyName(property);
          const binding = property.value?.type === 'Identifier' ? property.value.name : null;
          if (binding && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(capability)) {
            launchers.set(binding, capability);
          } else if (binding && ['exec', 'execSync', 'fork'].includes(capability)) {
            unsupportedExecutionNames.add(binding);
          }
        }
      }
    }
    if (node.id.type === 'Identifier' && node.init?.type === 'MemberExpression'
      && (requiredModule(node.init.object) || importedModule(node.init.object))
      && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(memberName(node.init))) {
      launchers.set(node.id.name, memberName(node.init));
    } else if (node.id.type === 'Identifier' && node.init?.type === 'MemberExpression'
      && (requiredModule(node.init.object) || importedModule(node.init.object))
      && ['exec', 'execSync', 'fork'].includes(memberName(node.init))) {
      unsupportedExecutionNames.add(node.id.name);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, declarations] of declarationLists) {
      if (declarations.length !== 1 || launchers.has(name)) continue;
      const init = declarations[0].init;
      if (init?.type === 'Identifier' && launchers.has(init.name)) {
        launchers.set(name, launchers.get(init.name)); changed = true;
      } else if (init?.type === 'MemberExpression' && init.object?.type === 'Identifier'
        && childProcessNamespaces.has(init.object.name)
        && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(memberName(init))) {
        launchers.set(name, memberName(init)); changed = true;
      }
    }
  }
  for (const { node } of nodes) {
    if (node.type !== 'VariableDeclarator' || node.init?.type !== 'CallExpression'
      || node.init.callee?.type !== 'Identifier' || node.init.callee.name !== 'require'
      || !['module', 'node:module'].includes(staticSpecifier(node.init.arguments[0]))) continue;
    if (node.id.type === 'Identifier') moduleNamespaces.add(node.id.name);
    if (node.id.type === 'ObjectPattern') {
      for (const property of node.id.properties) {
        if (propertyKeyName(property) !== 'createRequire') continue;
        if (property.value?.type === 'Identifier') createRequireNames.add(property.value.name);
      }
    }
  }
  for (const { node } of nodes) {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern'
      || node.init?.type !== 'Identifier' || !moduleNamespaces.has(node.init.name)) continue;
    for (const property of node.id.properties) {
      if (propertyKeyName(property) === 'createRequire' && property.value?.type === 'Identifier') {
        createRequireNames.add(property.value.name);
      }
    }
  }
  const isCreateRequireCall = node => node?.type === 'CallExpression'
    && (node.callee.type === 'Identifier' && createRequireNames.has(node.callee.name)
      || node.callee.type === 'MemberExpression' && node.callee.object?.type === 'Identifier'
        && moduleNamespaces.has(node.callee.object.name) && memberName(node.callee) === 'createRequire');
  const importerCreateRequire = node => isCreateRequireCall(node) && node.arguments.length === 1
    && node.arguments[0]?.type === 'MemberExpression' && !node.arguments[0].computed
    && node.arguments[0].object?.type === 'MetaProperty' && node.arguments[0].object.meta?.name === 'import'
    && node.arguments[0].object.property?.name === 'meta' && node.arguments[0].property?.name === 'url';
  const requireNames = new Set(['require']);
  const unsafeRequireNames = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, declarations] of declarationLists) {
      if (declarations.length !== 1) continue;
      const init = declarations[0].init;
      const createRequireAlias = init?.type === 'Identifier' && createRequireNames.has(init.name)
        || init?.type === 'MemberExpression' && init.object?.type === 'Identifier'
          && moduleNamespaces.has(init.object.name) && memberName(init) === 'createRequire';
      if (createRequireAlias && !createRequireNames.has(name)) {
        createRequireNames.add(name); changed = true;
      }
      const moduleRequire = init?.type === 'MemberExpression' && init.object?.type === 'Identifier'
        && init.object.name === 'module' && memberName(init) === 'require';
      const boundModuleRequire = init?.type === 'CallExpression' && init.callee?.type === 'MemberExpression'
        && memberName(init.callee) === 'bind' && init.callee.object?.type === 'MemberExpression'
        && init.callee.object.object?.type === 'Identifier' && init.callee.object.object.name === 'module'
        && memberName(init.callee.object) === 'require';
      if (!unsafeRequireNames.has(name) && (isCreateRequireCall(init) && !importerCreateRequire(init)
        || init?.type === 'Identifier' && unsafeRequireNames.has(init.name))) {
        unsafeRequireNames.add(name); changed = true;
      } else if (!requireNames.has(name) && (importerCreateRequire(init) || init?.type === 'Identifier'
        && requireNames.has(init.name) || moduleRequire || boundModuleRequire)) {
        requireNames.add(name); changed = true;
      }
    }
    for (const { node } of nodes) {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern'
        || node.init?.type !== 'Identifier' || node.init.name !== 'module') continue;
      for (const property of node.id.properties) {
        if (propertyKeyName(property) !== 'require') continue;
        const binding = property.value?.type === 'Identifier' ? property.value.name : null;
        if (binding && !requireNames.has(binding)) { requireNames.add(binding); changed = true; }
      }
    }
  }
  const addSource = (sourceNode, kind, node) => {
    const specifier = staticSpecifier(sourceNode);
    if (specifier && specifier.replace(/^node:/u, '') === 'worker_threads' && node.type !== 'ImportDeclaration') {
      unresolved.set(`worker-load:${node.start}:${node.end}`, { kind: 'worker', reason: 'unsupported-worker-module-load', start: node.start, end: node.end });
      return;
    }
    if (specifier === null) {
      const value = { kind, reason: 'non-static-specifier', start: node.start, end: node.end };
      unresolved.set(`${kind}:${node.start}:${node.end}`, value);
    } else if (localSpecifier(specifier)) {
      imports.set(`${kind}:${specifier}`, { kind, specifier });
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) && !specifier.startsWith('node:')) {
      const value = { kind, specifier, reason: 'unsupported-url-specifier', start: node.start, end: node.end };
      unresolved.set(`${kind}:${node.start}:${node.end}`, value);
    }
  };
  const unresolvedCapability = (kind, node, reason) => {
    const value = { kind, reason, start: node.start, end: node.end };
    unresolved.set(`${kind}:${node.start}:${node.end}:${reason}`, value);
  };
  const isProcessNamespace = node => node?.type === 'Identifier' && processNamespaces.has(node.name)
    || node?.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && node.object.name === 'globalThis' && memberName(node) === 'process'
    || node?.type === 'MemberExpression' && memberName(node) === 'default' && isProcessNamespace(node.object)
    || node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && requireNames.has(node.callee.name)
      && ['process', 'node:process'].includes(staticSpecifier(node.arguments[0]))
    || node?.type === 'ImportExpression' && ['process', 'node:process'].includes(staticSpecifier(node.source))
    || node?.type === 'AwaitExpression' && isProcessNamespace(node.argument);
  // Follow process receivers so ordinary data fields such as report.binding
  // do not become unresolved executable dependencies.
  for (let changed = true; changed;) {
    changed = false;
    for (const { node } of nodes) {
      const target = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null;
      const value = node.type === 'VariableDeclarator' ? node.init : node.type === 'AssignmentExpression' ? node.right : null;
      const names = target?.type === 'Identifier' && isProcessNamespace(value) ? [target.name]
        : target?.type === 'ObjectPattern' && value?.type === 'Identifier' && value.name === 'globalThis'
          ? target.properties.filter(property => propertyKeyName(property) === 'process' && property.value?.type === 'Identifier')
            .map(property => property.value.name) : [];
      for (const name of names) if (!processNamespaces.has(name)) { processNamespaces.add(name); changed = true; }
    }
  }
  for (const { node } of nodes) {
    const target = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null;
    const value = node.type === 'VariableDeclarator' ? node.init : node.type === 'AssignmentExpression' ? node.right : null;
    if (target?.type === 'ObjectPattern' && isProcessNamespace(value)) for (const property of target.properties) {
      if (runtimeModuleMembers.has(propertyKeyName(property))) unresolvedCapability('runtime-module', property, 'runtime-module-capability');
    }
  }
  for (const node of unsafeRuntimeLoads) unresolvedCapability('runtime-module', node, 'unsupported-execution-runtime');
  for (const [name, declarations] of declarationLists) {
    if (declarations.length < 2) continue;
    const requireAmbiguity = declarations.some(({ init }) => isCreateRequireCall(init)
      || init?.type === 'Identifier' && (requireNames.has(init.name) || createRequireNames.has(init.name))
      || init?.type === 'MemberExpression' && ['require', 'createRequire'].includes(memberName(init)));
    const launcherAmbiguity = declarations.some(({ init }) => init?.type === 'Identifier' && launchers.has(init.name)
      || init?.type === 'MemberExpression' && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(memberName(init)));
    if (requireAmbiguity) unresolvedCapability('require', declarations[0], `ambiguous-scope-capability:${name}`);
    if (launcherAmbiguity) unresolvedExecutables.set(`ambiguous:${name}`,
      { reason: `ambiguous-scope-capability:${name}`, start: declarations[0].start, end: declarations[0].end });
  }
  const environmentBindings = new Map();
  const environmentMember = node => node?.type === 'MemberExpression'
    && node.object?.type === 'MemberExpression' && node.object.object?.type === 'Identifier'
    && node.object.object.name === 'process' && memberName(node.object) === 'env'
    ? memberName(node) : null;
  for (const { node } of nodes) {
    const variable = environmentMember(node);
    if (variable && /^[A-Z][A-Z0-9_]+$/u.test(variable)) environmentVariables.add(variable);
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern'
      || node.init?.type !== 'MemberExpression' || node.init.object?.type !== 'Identifier'
      || node.init.object.name !== 'process' || memberName(node.init) !== 'env') continue;
    for (const property of node.id.properties) {
      const variableName = propertyKeyName(property);
      const binding = property.value?.type === 'Identifier' ? property.value.name : null;
      if (binding && variableName) {
        environmentBindings.set(binding, variableName); environmentVariables.add(variableName);
      }
    }
  }
  for (const { node, parent, ancestors } of nodes) {
    const objectPatternBinding = parent?.type === 'Property' && parent.value === node
      && ancestors.at(-2)?.type === 'ObjectPattern';
    if (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name)) {
      const propertyKey = parent?.type === 'Property' && parent.key === node && parent.value !== node && !parent.computed
        || parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      if (!propertyKey) unresolvedCapability('dynamic-code', node, 'dynamic-code-evaluation');
    }
    if (node.type === 'MemberExpression'
      && isProcessNamespace(node.object) && runtimeModuleMembers.has(memberName(node))) {
      unresolvedCapability('runtime-module', node, 'runtime-module-capability');
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === 'process'
      && memberName(node) === 'execve') {
      unresolvedExecutables.set(`execve:${node.start}:${node.end}`,
        { reason: 'unsupported-process-execve', start: node.start, end: node.end });
    }
    if (node.type === 'MemberExpression' && (node.object?.type === 'Identifier'
      && (childProcessNamespaces.has(node.object.name) || moduleNamespaces.has(node.object.name) || node.object.name === 'module'))
      && ['exec', 'execSync', 'fork', 'register', 'registerHooks'].includes(memberName(node))) {
      unresolvedExecutables.set(`unsupported-member:${node.start}:${node.end}`,
        { reason: 'unsupported-execution-capability', start: node.start, end: node.end });
    }
    if (node.type === 'Identifier' && unsupportedExecutionNames.has(node.name)) {
      const binding = parent?.type === 'ImportSpecifier' || parent?.type === 'VariableDeclarator' && parent.id === node
        || objectPatternBinding;
      if (!binding) unresolvedExecutables.set(`unsupported-name:${node.start}:${node.end}`,
        { reason: 'unsupported-execution-capability', start: node.start, end: node.end });
    }
    if (node.type === 'Identifier' && (workerNames.has(node.name) || node.name === 'Worker')) {
      const propertyKey = parent?.type === 'Property' && parent.key === node && parent.value !== node && !parent.computed
        || parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const binding = parent?.type === 'ImportSpecifier' || parent?.type === 'VariableDeclarator' && parent.id === node;
      const construction = workerNames.has(node.name) && parent?.type === 'NewExpression' && parent.callee === node;
      if (!propertyKey && !binding && !construction) unresolvedExecutables.set(`worker:${node.start}:${node.end}`,
        { reason: 'unsupported-worker-entry', start: node.start, end: node.end });
    }
    if (node.type === 'Identifier' && requireNames.has(node.name)) {
      const allowed = parent?.type === 'CallExpression' && parent.callee === node
        || parent?.type === 'VariableDeclarator' && (parent.id === node || parent.init === node)
        || objectPatternBinding
        || parent?.type === 'Property' && parent.key === node && parent.value !== node && !parent.computed;
      if (!allowed) unresolvedCapability('require', node, 'forwarded-require-capability');
    }
    if (node.type === 'Identifier' && createRequireNames.has(node.name)) {
      const directCall = parent?.type === 'CallExpression' && parent.callee === node;
      const callConsumer = directCall ? ancestors.at(-2) : null;
      const consumedCreateRequire = directCall && (callConsumer?.type === 'VariableDeclarator' && callConsumer.init === parent
        || callConsumer?.type === 'CallExpression' && callConsumer.callee === parent
        || callConsumer?.type === 'MemberExpression' && callConsumer.object === parent && memberName(callConsumer) === 'resolve');
      const allowed = parent?.type === 'ImportSpecifier'
        || consumedCreateRequire
        || parent?.type === 'VariableDeclarator' && (parent.id === node || parent.init === node)
        || objectPatternBinding
        || parent?.type === 'Property' && parent.key === node && parent.value !== node && !parent.computed;
      if (!allowed) unresolvedCapability('require', node, 'forwarded-create-require-capability');
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === 'module'
      && memberName(node) === 'require') {
      const allowed = parent?.type === 'CallExpression' && parent.callee === node
        || parent?.type === 'VariableDeclarator' && parent.init === node
        || parent?.type === 'MemberExpression' && parent.object === node && memberName(parent) === 'bind';
      if (!allowed) unresolvedCapability('require', node, 'forwarded-module-require-capability');
    }
    if (node.type === 'Identifier' && launchers.has(node.name)) {
      const allowed = parent?.type === 'ImportSpecifier'
        || parent?.type === 'VariableDeclarator' && (parent.id === node || parent.init === node)
        || objectPatternBinding
        || parent?.type === 'CallExpression' && parent.callee === node
        || parent?.type === 'Property' && parent.key === node && parent.value !== node && !parent.computed;
      if (!allowed) unresolvedExecutables.set(`capability:${node.start}:${node.end}`,
        { reason: 'forwarded-launcher-capability', start: node.start, end: node.end });
    }
    if (node.type === 'Identifier' && childProcessNamespaces.has(node.name)) {
      const allowed = parent?.type === 'ImportNamespaceSpecifier' || parent?.type === 'ImportDefaultSpecifier'
        || parent?.type === 'VariableDeclarator' && parent.id === node
        || parent?.type === 'MemberExpression' && parent.object === node
          && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(memberName(parent));
      if (!allowed) unresolvedExecutables.set(`namespace:${node.start}:${node.end}`,
        { reason: 'forwarded-child-process-namespace', start: node.start, end: node.end });
    }
  }
  const defaultExecutableTools = new Set(nodes.filter(({ node }) => node.type === 'AssignmentPattern'
    && node.left?.type === 'Identifier' && node.left.name === 'executable')
    .map(({ node }) => staticString(node.right)).filter(value => value));
  const parameterDefaults = new Map();
  for (const { node } of nodes) {
    if (node.type !== 'AssignmentPattern' || node.left?.type !== 'Identifier') continue;
    if (parameterDefaults.has(node.left.name)) parameterDefaults.set(node.left.name, null);
    else parameterDefaults.set(node.left.name, node.right);
  }
  const resolveExecutable = (node, seen = new Set()) => {
    const literal = staticString(node);
    if (literal && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(literal)) {
      return { resolved: true, tools: [literal.replace(/\.exe$/iu, '').toLowerCase()] };
    }
    if (node?.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && node.object.name === 'process' && memberName(node) === 'execPath') return { resolved: true, tools: [] };
    const variable = environmentMember(node);
    if (variable) { environmentVariables.add(variable); return { resolved: true, tools: [] }; }
    if (node?.type === 'Identifier' && environmentBindings.has(node.name)) return { resolved: true, tools: [] };
    if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier'
      && validationExecutableNames.has(node.callee.name)) {
      const name = staticString(node.arguments[0]);
      return name ? { resolved: true, tools: [name.replace(/\.exe$/iu, '').toLowerCase()] } : { resolved: false, tools: [] };
    }
    if (node?.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
      && node.callee.object?.type === 'Identifier' && node.callee.object.name === 'path'
      && memberName(node.callee) === 'resolve' && node.arguments.length) return resolveExecutable(node.arguments.at(-1), seen);
    if (node?.type === 'Identifier' && !seen.has(node.name)) {
      const declarations = declarationLists.get(node.name);
      if (declarations?.length === 1) {
        seen.add(node.name);
        return resolveExecutable(declarations[0].init, seen);
      }
      const fallback = parameterDefaults.get(node.name);
      if (fallback) {
        seen.add(node.name);
        return resolveExecutable(fallback, seen);
      }
    }
    if (node?.type === 'MemberExpression' && memberName(node) === 'executable') {
      if (node.object?.type === 'MemberExpression' && memberName(node.object) === 'remux') {
        return { resolved: true, tools: ['ffmpeg'] };
      }
      if (defaultExecutableTools.size === 1) return { resolved: true, tools: [...defaultExecutableTools] };
    }
    return { resolved: false, tools: [] };
  };
  for (const { node, ancestors } of nodes) {
    if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'URL'
      && node.arguments.length === 2) {
      const specifier = staticSpecifier(node.arguments[0]), base = node.arguments[1];
      const importMetaBase = base?.type === 'MemberExpression' && !base.computed
        && base.object?.type === 'MetaProperty' && base.object.meta?.name === 'import' && base.object.property?.name === 'meta'
        && base.property?.name === 'url';
      const directRead = ancestors.some(parent => parent.type === 'CallExpression'
        && ['readFile', 'readFileSync', 'openSync'].includes(parent.callee?.name ?? memberName(parent.callee)));
      const outputOrAssertion = !directRead && ancestors.some(parent => parent.type === 'CallExpression' && (
        ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync'].includes(parent.callee?.name ?? memberName(parent.callee))
        || parent.callee?.type === 'MemberExpression' && parent.callee.object?.type === 'Identifier' && parent.callee.object.name === 'assert'));
      if (!shadowedUrl && importMetaBase && specifier && /\.json(?:[?#]|$)/u.test(specifier)
        && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/])/u.test(specifier) && !/[\r\n\0]/u.test(specifier)
        // Existing declarations preserve environment remapping and distinguish
        // evidence identity assertions from actual external reads.
        && !/^(?:\.\.\/)*\.agent-docs\//u.test(specifier) && !outputOrAssertion) {
        fixtureSpecifiers.add(specifier);
      }
      if (specifier && /\.wasm$/u.test(specifier)) {
        if (!shadowedUrl && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/])/u.test(specifier)
          && base?.type === 'MemberExpression' && !base.computed
          && base.object?.type === 'MetaProperty' && base.object.meta?.name === 'import' && base.object.property?.name === 'meta'
          && base.property?.name === 'url') imports.set(`asset:${specifier}`, { kind: 'asset', specifier });
        else unresolvedCapability('wasm', node, 'unbound-wasm-asset-url');
      }
    }
    if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && workerNames.has(node.callee.name)) {
      const entry = node.arguments[0], base = entry?.arguments?.[1];
      const specifier = !shadowedUrl && entry?.type === 'NewExpression' && entry.callee?.type === 'Identifier' && entry.callee.name === 'URL'
        && entry.arguments.length === 2 && base?.type === 'MemberExpression' && !base.computed
        && base.object?.type === 'MetaProperty' && base.object.meta?.name === 'import' && base.object.property?.name === 'meta'
        && base.property?.name === 'url' ? staticSpecifier(entry.arguments[0]) : null;
      const options = node.arguments[1];
      const safeOptions = !options || options.type === 'ObjectExpression' && options.properties.every(property =>
        property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
        && ['workerData', 'trackUnmanagedFds', 'name', 'resourceLimits', 'stdout', 'stderr'].includes(propertyKeyName(property)));
      if (!specifier || !/^\.{1,2}\//u.test(specifier) || !/\.(?:js|mjs|cjs)$/u.test(specifier)
        || !safeOptions || node.arguments.length > 2) unresolvedCapability('worker', node, 'unbound-worker-entry-or-options');
      else imports.set(`module:${specifier}`, { kind: 'module', specifier });
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier'
      && validationExecutableNames.has(node.callee.name)) {
      const configured = staticString(node.arguments[0]);
      if (configured) tools.add(configured.replace(/\.exe$/iu, '').toLowerCase());
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && moduleNamespaces.has(node.object.name) && node.computed && memberName(node) === null) {
      const value = { kind: 'require', reason: 'unresolved-module-capability', start: node.start, end: node.end };
      unresolved.set(`require:${node.start}:${node.end}`, value);
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.source) addSource(node.source, 'module', node);
    } else if (node.type === 'ImportExpression') {
      addSource(node.source, 'module', node);
    } else if (node.type === 'CallExpression' && (node.callee?.type === 'Identifier'
      && unsafeRequireNames.has(node.callee.name) || isCreateRequireCall(node.callee) && !importerCreateRequire(node.callee))) {
      const value = { kind: 'require', reason: 'unsupported-create-require-base', start: node.start, end: node.end };
      unresolved.set(`require:${node.start}:${node.end}`, value);
    } else if (node.type === 'CallExpression' && (node.callee?.type === 'Identifier' && requireNames.has(node.callee.name)
      || node.callee?.type === 'MemberExpression' && (memberName(node.callee) === 'require'
        || node.callee.object?.type === 'Identifier' && node.callee.object.name === 'module'
          && node.callee.computed && memberName(node.callee) === null)
      || isCreateRequireCall(node.callee))) {
      if (node.arguments.length === 1) addSource(node.arguments[0], 'require', node);
      else {
        const value = { kind: 'require', reason: 'non-static-specifier', start: node.start, end: node.end };
        unresolved.set(`require:${node.start}:${node.end}`, value);
      }
    }
    if (node.type === 'AssignmentPattern' && node.left?.type === 'Identifier' && node.left.name === 'executable') {
      const value = staticString(node.right);
      if (['ffmpeg', 'ffprobe', 'dotnet'].includes(value)) tools.add(value);
    }
    const launcherCall = node.type === 'CallExpression' && (node.callee?.type === 'Identifier'
      && launchers.has(node.callee.name)
      || node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier'
        && childProcessNamespaces.has(node.callee.object.name)
        && ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(memberName(node.callee)));
    if (launcherCall) {
      const resolution = resolveExecutable(node.arguments[0]);
      for (const tool of resolution.tools) tools.add(tool);
      if (!resolution.resolved) unresolvedExecutables.set(`${node.start}:${node.end}`,
        { reason: 'non-static-executable', start: node.start, end: node.end });
    }
  }
  const registrations = nodes.filter(({ node }) => node.type === 'CallExpression'
    && node.callee?.type === 'Identifier' && ['test', 'it', 'describe', 'suite'].includes(node.callee.name));
  const conditionalRegistration = registrations.some(({ ancestors }) => ancestors.some(ancestor =>
    ['IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchCase', 'WhileStatement', 'DoWhileStatement']
      .includes(ancestor.type)));
  const declaredServices = [];
  for (const { node } of nodes) if (node.type === 'VariableDeclarator' && node.id?.name === 'requiredValidationServices') {
    if (node.init?.type !== 'ArrayExpression' || node.init.elements.some(element =>
      !Object.hasOwn(dependencyVariables, staticString(element)))) {
      throw new Error('requiredValidationServices must be a static array of known services.');
    }
    declaredServices.push(...node.init.elements.map(staticString));
  }
  return { declaredServices, importSpecifiers: [...imports.values()].sort((left, right) =>
    left.specifier.localeCompare(right.specifier) || left.kind.localeCompare(right.kind)),
  unresolvedImports: [...unresolved.values()], unresolvedExecutables: [...unresolvedExecutables.values()],
  tools: [...tools].sort(), environmentVariables: [...environmentVariables].sort(), testRegistrations: registrations.length,
  conditionalRegistration, referenceDeclarations: referenceDeclarations(source, nodes), fixtureSpecifiers: [...fixtureSpecifiers].sort() };
}

export function caseFoldedEntryMap(paths) {
  const result = new Map();
  for (const entry of paths) {
    const key = entry.toLocaleLowerCase('en-US');
    const existing = result.get(key);
    if (existing && existing !== entry) {
      throw new Error(`Validation inventory contains a case-fold collision: ${existing} and ${entry}.`);
    }
    result.set(key, entry);
  }
  return result;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function pathContainsLink(parent, target) {
  const relative = path.relative(parent, target);
  if (!isWithin(parent, target)) return false;
  let current = parent;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

function specifierBase(importer, specifier) {
  const withoutQuery = specifier.replace(/[?#].*$/u, '');
  if (withoutQuery.startsWith('file:')) return fileURLToPath(withoutQuery);
  if (path.isAbsolute(withoutQuery) || /^[A-Za-z]:[\\/]/u.test(withoutQuery)) return path.resolve(withoutQuery);
  return fileURLToPath(new URL(withoutQuery.replaceAll('\\', '/'), pathToFileURL(importer)));
}

export async function resolveLocalImport(importer, dependency, {
  repository = repositoryRoot, rootRealPath, knownEntries = new Map(),
} = {}) {
  rootRealPath ||= await realpath(repository);
  let target;
  try {
    if(dependency.specifier.startsWith('@mediamanager/plugin-sdk/')){
      const manifest=JSON.parse(await readFile(path.join(repository,'packages/plugin-sdk/package.json'),'utf8'));
      const entry=manifest.exports['./'+dependency.specifier.slice('@mediamanager/plugin-sdk/'.length)];
      if(typeof entry!=='string')return {error:'unknown-plugin-sdk-export'};
      target=path.resolve(repository,'packages/plugin-sdk',entry);
    } else if (dependency.kind === 'require') {
      if (dependency.specifier.startsWith('file:')) throw new Error('CommonJS file URL specifiers are unsupported.');
      target = createRequire(pathToFileURL(importer)).resolve(dependency.specifier);
    } else target = specifierBase(importer, dependency.specifier);
  }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return { error: 'local-target-not-found' };
    return { error: `invalid-local-specifier:${error.code || error.name}` };
  }
  try {
    const info = await lstat(target);
    if (!info.isFile() && !info.isSymbolicLink()) return { error: 'local-target-not-file' };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { error: 'local-target-not-found' };
    throw error;
  }
  if (!isWithin(repository, target)) return { error: 'local-target-outside-repository' };
  if (await pathContainsLink(repository, target)) return { error: 'local-target-symbolic-link' };
  const targetRealPath = await realpath(target);
  if (!isWithin(rootRealPath, targetRealPath)) return { error: 'local-target-realpath-outside-repository' };
  const relative = path.relative(rootRealPath, targetRealPath).replaceAll('\\', '/');
  if (!/^(?:src|tests|tools|plugins|packages)\//u.test(relative)) return { error: 'local-target-outside-inventory-scope' };
  if (/\.(?:js|mjs|cjs)$/u.test(relative)) {
    const known = knownEntries.get(relative.toLocaleLowerCase('en-US'));
    if (!known) return { error: 'local-source-not-in-inventory' };
    let knownRealPath;
    try { knownRealPath = await realpath(path.join(rootRealPath, ...known.split('/'))); }
    catch (error) { return { error: `known-source-unavailable:${error.code || error.name}` }; }
    if (path.relative(knownRealPath, targetRealPath) !== '') return { error: 'known-source-realpath-mismatch' };
    return { imported: known };
  }
  return path.extname(relative).toLowerCase() === '.json' || dependency.kind === 'asset' && path.extname(relative).toLowerCase() === '.wasm'
    ? { importedFile: relative } : { error: 'local-target-unsupported-extension' };
}

export function dependencyClosure(dependencies, selected) {
  const byPath = new Map(dependencies.entries.map(entry => [entry.path, entry]));
  const pending = [...selected];
  const paths = new Set();
  while (pending.length) {
    const filename = pending.pop();
    if (paths.has(filename)) continue;
    const entry = byPath.get(filename);
    if (!entry) throw new Error(`Dependency inventory does not contain selected or imported source: ${filename}.`);
    if (entry.unresolvedImports?.length) {
      throw new Error(`Dependency inventory cannot resolve imports for ${filename}: ${JSON.stringify(entry.unresolvedImports)}.`);
    }
    paths.add(filename);
    for (const imported of entry.imports || []) pending.push(imported);
  }
  return dependencies.entries.filter(entry => paths.has(entry.path));
}

export async function describeFile(filename, { recursive = true, workspaceLinks = false, containedLinks } = {}) {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink()) {
      if (containedLinks && path.resolve(filename) !== path.resolve(containedLinks)) {
        const target = await realpath(filename), boundary = await realpath(containedLinks);
        const relative = path.relative(boundary, target);
        if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          const targetInfo = await lstat(target);
          if (targetInfo.isFile() || targetInfo.isDirectory()) return {
            filename, available: true, kind: 'runtime-link', target: await readlink(filename),
            resolvedTarget: relative.replaceAll('\\', '/'), targetKind: targetInfo.isFile() ? 'file' : 'directory',
            ...(targetInfo.isFile() ? { targetSha256: sha256(await readFile(target)) } : {})
          };
        }
      }
      if (workspaceLinks) {
        const target = await realpath(filename), relative = path.relative(repositoryRoot, target).replaceAll('\\','/');
        const name = path.relative(path.join(repositoryRoot,'node_modules'), filename).replaceAll('\\','/');
        const root = JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
        const [directory, member, extra] = relative.split('/');
        if (member && !extra && root.workspaces?.includes(directory+'/*') && !await pathContainsLink(repositoryRoot,target)) {
          const manifest = JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
          if (manifest.name === name) {
            const bound = await describeFile(target,{recursive});
            return {filename,available:bound.available,kind:'workspace-link',target:await readlink(filename),package:bound};
          }
        }
      }
      return { filename, available: false, kind: 'symbolic-link', target: await readlink(filename), errorCode: 'UNSUPPORTED_INPUT_LINK' };
    }
    if (info.isDirectory() && recursive) {
      const entries = [];
      for (const name of (await readdir(filename)).sort()) {
        const { filename: ignored, ...description } = await describeFile(path.join(filename, name),{workspaceLinks,containedLinks});
        entries.push({ name, ...description });
      }
      return { filename, available: entries.every(entry => entry.available), kind: 'directory', entries,
        entriesSha256: sha256(JSON.stringify(entries)) };
    }
    return { filename, available: true, kind: info.isDirectory() ? 'directory' : 'file',
      ...(info.isFile() ? { bytes: info.size, sha256: sha256(await readFile(filename)) } : {}) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { filename, available: false };
  }
}

export async function inventory(environment = process.env) {
  const entries = [];
  for (const directory of ['src', 'tests', 'tools','plugins','packages']) {
    for (const filename of await filesIn(path.join(repositoryRoot, directory))) {
      if (!/\.(?:js|mjs|cjs|csproj)$/u.test(filename)) continue;
      const bytes = await readFile(filename);
      const source = bytes.toString('utf8');
      const analysis = /\.(?:js|mjs|cjs)$/u.test(filename)
        ? analyzeJavaScriptDependencies(source) : { importSpecifiers: [], unresolvedImports: [], unresolvedExecutables: [],
          tools: [], environmentVariables: [],
          testRegistrations: 0, conditionalRegistration: false, referenceDeclarations: [], fixtureSpecifiers: [] };
      // The host loads verified installed byte copies. Bind both reviewed
      // load expressions and every bundled package to the candidate closure.
      if(path.relative(repositoryRoot,filename).replaceAll('\\','/')==='src/plugins/host.js'){
        analysis.unresolvedImports=analysis.unresolvedImports.filter(entry=>{
          const expression=source.slice(entry.start,entry.end);
          return !/^import\(pathToFileURL\(path\.join\(directory,(?:record|next)\.package\.manifest\.mediamanager\.entry\)\)\.href(?:\+'\?activation='\+randomUUID\(\))?\)$/u.test(expression);
        });
        for(const name of await readdir(path.join(repositoryRoot,'plugins'))){
          const manifest=JSON.parse(await readFile(path.join(repositoryRoot,'plugins',name,'package.json'),'utf8'));
          analysis.importSpecifiers.push({kind:'module',specifier:`../../plugins/${name}/${manifest.mediamanager.entry}`},
            {kind:'module',specifier:`../../plugins/${name}/package.json`});
        }
        analysis.importSpecifiers.push({kind:'module',specifier:'../../packages/plugin-sdk/package.json'});
      }
      const variables = [...new Set([...source.matchAll(/process\.env\.(MEDIAMANAGER_[A-Z0-9_]+)/gu)].map(match => match[1])
        .concat(analysis.environmentVariables.filter(name => name.startsWith('MEDIAMANAGER_'))))].sort();
      const declaredReferences = [];
      for (const declaration of analysis.referenceDeclarations) {
        declaredReferences.push({ ...declaration,
          ...(declaration.dynamic ? {} : await describeFile(validationPath(declaration.logicalPath, repositoryRoot, environment), { recursive: false })) });
      }
      const fixtureReferences = [];
      for (const value of new Set([...[...source.matchAll(/["']((?:\.\.?\/)+fixtures\/[^"'\r\n]*\.json)["']/gu)].map(match => match[1]),
        ...analysis.fixtureSpecifiers])) {
        fixtureReferences.push({ relativePath: value,
          ...await describeFile(analysis.fixtureSpecifiers.includes(value)
            ? fileURLToPath(new URL(value, pathToFileURL(filename))) : path.resolve(path.dirname(filename), value), { recursive: false }) });
      }
      const testFile = filename.endsWith('.test.js');
      entries.push({ path: path.relative(repositoryRoot, filename).replaceAll('\\', '/'),
        sha256: sha256(bytes), test: testFile, variables,
        services: [...new Set([...Object.entries(dependencyVariables).filter(([, variable]) => variables.includes(variable)).map(([name]) => name),
          ...(analysis.declaredServices ?? [])])].sort(),
        tools: analysis.tools,
        testRegistrations: analysis.testRegistrations,
        conditionalRegistration: testFile && (analysis.testRegistrations === 0 || analysis.conditionalRegistration),
        declaredReferences, fixtureReferences,
        importSpecifiers: analysis.importSpecifiers, unresolvedImports: analysis.unresolvedImports,
        unresolvedExecutables: analysis.unresolvedExecutables,
        filename });
    }
  }
  const rootRealPath = await realpath(repositoryRoot);
  const known = caseFoldedEntryMap(entries.map(entry => entry.path));
  for (const entry of entries) {
    const imports = new Set();
    const importedFiles = new Set();
    for (const dependency of entry.importSpecifiers) {
      const resolved = await resolveLocalImport(entry.filename, dependency, { rootRealPath, knownEntries: known });
      if (resolved.imported) imports.add(resolved.imported);
      else if (resolved.importedFile) importedFiles.add(resolved.importedFile);
      else entry.unresolvedImports.push({ kind: dependency.kind, specifier: dependency.specifier, reason: resolved.error });
    }
    entry.imports = [...imports].sort();
    entry.importedFiles = [...importedFiles].sort();
    delete entry.importSpecifiers;
    delete entry.filename;
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: 'AST-derived dependency inventory covers core, tests, tools, plugin packages and SDK exports. Two reviewed installed-package load expressions bind all bundled entries and manifests; generated third-party packages are bound by their test sources and host byte digests. Dynamic reads and hashes inside manifests still require execution.',
    entries, totals: { entries: entries.length, tests: entries.filter(entry => entry.test).length,
      externalReferenceConsumers: entries.filter(entry => entry.declaredReferences.length > 0).length,
      unavailableDeclaredReferences: entries.flatMap(entry => entry.declaredReferences).filter(entry => entry.available === false).length,
      conditionalRegistration: entries.filter(entry => entry.conditionalRegistration).length } };
}
