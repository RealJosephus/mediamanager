import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { filesIn } from '../../tools/validation/inventory.js';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const pluginRoot = fileURLToPath(new URL('../../plugins/', import.meta.url));
const sdkRoot = fileURLToPath(new URL('../../packages/plugin-sdk/', import.meta.url));
const productionRoots = [sourceRoot, pluginRoot, sdkRoot];
const sdkManifest = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
const reviewedPluginImports = new Set([
  "import(pathToFileURL(path.join(directory,record.package.manifest.mediamanager.entry)).href+'?activation='+randomUUID())",
  'import(pathToFileURL(path.join(directory,next.package.manifest.mediamanager.entry)).href)',
]);
const reviewedResourceReflection = new Map([
  ['plugins/host.js', new Set(['Object.getPrototypeOf(value)', 'Reflect.get(target,key,target)', 'Reflect.getOwnPropertyDescriptor(value,key)'])],
  ['../plugins/local/adapter.js', new Set(['Reflect.get(object,key,object)'])],
]);
const allowedChildProcessModules = [
  'playback/extraction.js',
  'playback/hls.js',
  'playback/remux.js',
  'storage/ffprobe.js',
];

const alternateModules = new Set(['worker_threads', 'cluster', 'vm', 'module', 'process', 'inspector', 'repl']);
const indirectProperties = new Set([
  'binding', '_linkedBinding', 'dlopen', 'execve', 'getBuiltinModule', 'mainModule', 'spawn', 'spawnSync',
  'execSync', 'execFile', 'execFileSync',
  'fork', 'require', 'createRequire', 'Bun', 'Deno', 'Worker', 'WebAssembly', 'eval', 'Function', '__proto__',
  'prototype', 'caller', 'callee',
]);
const indirectIdentifiers = new Set(['Bun', 'Deno', 'Worker', 'WebAssembly', 'createRequire', 'eval', 'Function']);
const reflectiveProperties = new Set([
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getPrototypeOf', 'setPrototypeOf',
  'construct', 'apply', 'get', 'set',
]);

function walkSyntax(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'range'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkSyntax(child, visit, node);
    } else if (value && typeof value === 'object') walkSyntax(value, visit, node);
  }
}

function staticText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticText(node.left); const right = staticText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function propertyName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return staticText(node.property);
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function bindingIdentifier(node, parent) {
  return parent?.type === 'VariableDeclarator' && parent.id === node
    || /^(?:Function|ArrowFunction)/u.test(parent?.type || '') && parent.params.includes(node)
    || parent?.type === 'Property' && parent.key === node && parent.value !== node && !parent.computed
    || parent?.type === 'MethodDefinition' && parent.key === node && !parent.computed
    || parent?.type === 'PropertyDefinition' && parent.key === node && !parent.computed
    || parent?.type === 'MemberExpression' && parent.property === node && !parent.computed
    || parent?.type === 'ImportSpecifier' || parent?.type === 'ImportDefaultSpecifier'
    || parent?.type === 'ImportNamespaceSpecifier';
}

export function auditMediaExecutionSource(relative, source) {
  const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const expression = node => source.slice(node.start, node.end).replace(/\s+/gu, '');
  walkSyntax(syntax, node => {
    if (node.type === 'ImportExpression') assert.equal(relative === 'plugins/host.js'
      && reviewedPluginImports.has(expression(node)), true,
    `${relative} must not use dynamic import outside the reviewed plugin entry loaders`);
  });
  const childProcessImports = [];
  let spawnCalls = 0;
  walkSyntax(syntax, (node, parent) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (!node.source) return;
      const moduleName = String(node.source.value).replace(/^node:/u, '');
      if (moduleName === 'child_process') childProcessImports.push(node);
      if (alternateModules.has(moduleName)) assert.fail(`${relative} must not load an alternate execution runtime`);
      if (/^(?:data|file|https?):/u.test(String(node.source.value))
        || /\.(?:node|wasm)(?:[?#]|$)/u.test(String(node.source.value))) {
        assert.fail(`${relative} must not use an indirect execution bridge`);
      }
      const specifier = String(node.source.value).replace(/[?#].*$/u, '');
      if (specifier.startsWith('@mediamanager/plugin-sdk/')) {
        const entry = sdkManifest.exports['./' + specifier.slice('@mediamanager/plugin-sdk/'.length)];
        assert.equal(typeof entry, 'string', `${relative} must use a declared plugin SDK export`);
        assert.equal(within(sdkRoot, path.resolve(sdkRoot, entry)), true, `${relative} must not escape the plugin SDK`);
      }
      if (/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/u.test(specifier)) {
        const target = path.resolve(sourceRoot, path.dirname(relative), specifier);
        assert.equal(productionRoots.some(root => within(root, target)), true,
          `${relative} must not import production code from outside src, plugins, or the SDK`);
      }
    }
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        assert.fail(`${relative} must not use an indirect execution bridge`);
      }
      if (node.callee.type === 'Identifier' && ['exec', 'execSync', 'execFile', 'execFileSync', 'fork'].includes(node.callee.name)) {
        assert.fail(`${relative} must use the reviewed argument-array spawn boundary`);
      }
      if (node.callee.type === 'MemberExpression' && node.callee.object?.type === 'Identifier'
        && ['Object', 'Reflect'].includes(node.callee.object.name)
        && reflectiveProperties.has(propertyName(node.callee))) {
        assert.equal(reviewedResourceReflection.get(relative)?.has(expression(node)), true,
          `${relative} must not use an indirect execution bridge`);
      }
      if (node.callee.type === 'Identifier' && node.callee.name === 'spawn') {
        assert.ok(allowedChildProcessModules.includes(relative), `${relative} must not load child_process`);
        spawnCalls++;
        const options = node.arguments.at(-1);
        assert.equal(options?.type, 'ObjectExpression',
          `${relative} must explicitly disable the command shell for every spawn call`);
        assert.equal(options.properties.some(property => property.type === 'SpreadElement'), false,
          `${relative} must not spread unknown command shell options`);
        const shell = options.properties.filter(property => property.type === 'Property'
          && (!property.computed && property.key.type === 'Identifier' && property.key.name === 'shell'
            || property.computed && staticText(property.key) === 'shell'));
        assert.equal(shell.length, 1, `${relative} must declare exactly one command shell option`);
        assert.equal(shell[0].kind === 'init' && shell[0].value?.type === 'Literal' && shell[0].value.value === false, true,
          `${relative} must explicitly disable the command shell for every spawn call`);
      }
    }
    if (node.type === 'MemberExpression') {
      const property = propertyName(node);
      if (property === 'constructor') {
        const readsFunctionKind = parent?.type === 'MemberExpression' && parent.object === node
          && propertyName(parent) === 'name';
        assert.equal(readsFunctionKind, true,
          `${relative} must not use a dynamic Function constructor as an indirect execution bridge`);
      }
      if (indirectProperties.has(property)) assert.fail(`${relative} must not use an indirect execution bridge`);
      if (node.object?.type === 'Identifier' && node.object.name === 'process' && node.computed && property === null) {
        assert.fail(`${relative} must not use an indirect execution bridge`);
      }
      if (node.object?.type === 'Identifier' && node.object.name === 'globalThis' && property === 'process') {
        assert.fail(`${relative} must not use an indirect execution bridge`);
      }
      if (node.object?.type === 'Identifier' && node.object.name === 'globalThis'
        && (node.computed && property === null || property !== 'fetch')) {
        assert.fail(`${relative} must not use an indirect execution bridge`);
      }
      if (node.object?.type === 'Identifier' && node.object.name === 'global') {
        assert.fail(`${relative} must not use an indirect execution bridge`);
      }
    }
    if (node.type === 'Property' && parent?.type === 'ObjectPattern'
      && (indirectProperties.has(node.computed ? staticText(node.key) : node.key?.name || node.key?.value)
        || (node.computed ? staticText(node.key) : node.key?.name || node.key?.value) === 'constructor')) {
      assert.fail(`${relative} must not destructure an indirect execution bridge`);
    }
    if (node.type === 'Identifier' && indirectIdentifiers.has(node.name)) {
      assert.fail(`${relative} must not use an indirect execution bridge`);
    }
    if (node.type === 'Identifier' && node.name === 'spawn'
      && !(parent?.type === 'ImportSpecifier' && parent.local === node)
      && !(parent?.type === 'ImportSpecifier' && parent.imported === node)
      && !(parent?.type === 'CallExpression' && parent.callee === node)) {
      assert.fail(`${relative} may not alias or forward the spawn capability`);
    }
    if (node.type === 'Identifier' && ['process', 'globalThis', 'global'].includes(node.name) && !bindingIdentifier(node, parent)
      && !(parent?.type === 'MemberExpression' && parent.object === node)) {
      assert.fail(`${relative} must not alias or forward an indirect execution bridge`);
    }
  });
  if (!allowedChildProcessModules.includes(relative)) {
    assert.equal(childProcessImports.length, 0, `${relative} must not load child_process`);
    return false;
  }
  assert.equal(childProcessImports.length, 1, `${relative} must use one static named child_process import`);
  assert.equal(childProcessImports[0].type, 'ImportDeclaration', `${relative} must import child_process directly`);
  assert.equal(childProcessImports[0].specifiers.length, 1, `${relative} may import only the unaliased spawn function`);
  const imported = childProcessImports[0].specifiers[0];
  assert.equal(imported.type === 'ImportSpecifier' && imported.imported.name === 'spawn' && imported.local.name === 'spawn', true,
    `${relative} may import only the unaliased spawn function`);
  assert.ok(spawnCalls > 0, `${relative} must actually use its spawn import`);
  return true;
}

async function sourceFiles(directory) {
  return (await filesIn(directory)).filter(filename => /\.(?:c|m)?js$/u.test(filename));
}

test('production process execution stays inside the audited probe and packet-copy boundary', async () => {
  const processModules = [];
  for (const filename of (await Promise.all(productionRoots.map(sourceFiles))).flat()) {
    const relative = path.relative(sourceRoot, filename).replaceAll('\\', '/');
    const source = await readFile(filename, 'utf8');
    if (auditMediaExecutionSource(relative, source)) processModules.push(relative);
  }
  assert.deepEqual(processModules.sort(), allowedChildProcessModules);
});

test('plugin entry and resource exceptions remain limited to their reviewed expressions', () => {
  for (const expression of reviewedPluginImports) {
    assert.equal(auditMediaExecutionSource('plugins/host.js', expression + ';'), false);
    assert.throws(() => auditMediaExecutionSource('../plugins/local/adapter.js', expression + ';'), /dynamic import/u);
  }
  for (const source of ["await import('node:child_process');", 'await import(entry);',
    "Reflect.get(process, 'getBuiltinModule')('node:child_process');", 'Object.getPrototypeOf(process);']) {
    assert.throws(() => auditMediaExecutionSource('plugins/host.js', source), /dynamic import|indirect execution bridge/u);
  }
  assert.throws(() => auditMediaExecutionSource('../plugins/local/adapter.js',
    "import { spawn } from 'node:child_process'; spawn('ffmpeg', [], { shell: false });"), /must not load child_process/u);
  assert.throws(() => auditMediaExecutionSource('../packages/plugin-sdk/bridge.js',
    "import '../../tools/check.js';"), /outside src/u);
  assert.throws(() => auditMediaExecutionSource('../plugins/local/adapter.js',
    "import '@mediamanager/plugin-sdk/undeclared';"), /declared plugin SDK export/u);
});

test('media execution guard rejects alias, dynamic bridge, shell, and unreviewed-module bypasses', () => {
  assert.equal(auditMediaExecutionSource('storage/ffprobe.js',
    "import { spawn } from 'node:child_process'; spawn('ffprobe', [], { shell: false });"), true);
  assert.throws(() => auditMediaExecutionSource('storage/ffprobe.js',
    "import { exec as launch } from 'node:child_process'; launch('ffmpeg');"), /unaliased spawn/u);
  assert.throws(() => auditMediaExecutionSource('storage/ffprobe.js',
    "const launch = process.getBuiltinModule('node:' + 'child_process').spawn; launch('ffmpeg');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('storage/ffprobe.js',
    "import { spawn } from 'node:child_process'; spawn('ffmpeg', [], { shell: true });"), /command shell/u);
  assert.throws(() => auditMediaExecutionSource('storage/ffprobe.js',
    "import { spawn } from 'node:child_process'; spawn('ffmpeg', [], { shell: false, shell: true });"),
  /exactly one command shell/u);
  assert.throws(() => auditMediaExecutionSource('storage/ffprobe.js',
    "import { spawn } from 'node:child_process'; spawn('ffmpeg', [], { shell: false, ...{ shell: true } });"),
  /spread unknown command shell/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "import { spawn } from 'node:child_process'; spawn('ffmpeg', [], { shell: false });"), /must not load child_process/u);
  for (const source of [
    "const { spawn } = await import('node:' + 'child_' + 'process'); spawn('ffmpeg', [], { shell: false });",
    "const { spawn } = await import(`node:${'child_process'}`); spawn('ffmpeg', [], { shell: false });",
    "const bridge = 'child_process'; const { spawn } = await import(bridge); spawn('ffmpeg', [], { shell: false });",
    "const load = specifier => import(specifier); const { Worker } = await load('node:worker_threads'); new Worker('worker.js');",
    "const { spawn } = await import /* split token from call */ ('node:child_process'); spawn('ffmpeg', [], { shell: false });",
  ]) {
    assert.throws(() => auditMediaExecutionSource('library/query.js', source), /dynamic import/u);
  }
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "import * as runtime from 'node:module'; const load = runtime['create' + 'Require'](import.meta.url); load('child_process');"),
  /alternate execution runtime/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const key = 'getBuiltinModule'; process[key]('node:child_process').spawn('ffmpeg');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const host = process; const bridge = 'node:child_' + 'process'; host.getBuiltinModule(bridge).spawn('ffmpeg', [], { shell: true });"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const host = process; const method = 'get' + 'BuiltinModule'; host[method]('node:child_process').spawn('ffmpeg');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "process.dlopen(module, './payload.node');"), /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "process.execve('calc', [], process.env);"), /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "(()=>{}).constructor(\"process.getBuiltinModule('node:child_process').execFile('calc')\")();"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const { constructor: build }=(()=>{}); build(\"process.getBuiltinModule('node:child_process').execFile('calc')\")();"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const build=Object.getOwnPropertyDescriptor(()=>{},'constructor').value; build('return process')();"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const load=Object.getOwnPropertyDescriptor(process,'getBuiltinModule').value; load('node:child_process').execFile('calc');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const suffix=()=> 'cess', method=()=> 'getBuiltinModule', action=()=> 'execFile'; globalThis['pro'+suffix()][method()]('node:child_process')[action()]('calc');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const k='getBuiltinModule', action='execFile'; global.process[k]('node:child_process')[action]('calc');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "const g=global, k=()=> 'getBuiltinModule', action=()=> 'execFile'; g.process[k()]('node:child_process')[action()]('calc');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "import proc from 'node:process'; proc[()=> 'getBuiltinModule']('node:child_process');"),
  /alternate execution runtime/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "import inspector from 'node:inspector'; new inspector.Session();"), /alternate execution runtime/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "import repl from 'node:repl'; repl.start().eval('process.exit()');"), /alternate execution runtime/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "function seed(){ const method='cwd'; const launch='pid'; } function run(method, launch){ process[method]('node:child_process')[launch]('calc'); } run('getBuiltinModule','execFile');"),
  /indirect execution bridge/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js', "import '../../tools/check.js';"),
    /outside src/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js', "import '../../tests/compat/native-shutdown.test.js';"),
    /outside src/u);
  assert.throws(() => auditMediaExecutionSource('library/query.js',
    "import 'data:text/javascript,globalThis.process.getBuiltinModule(\\'node:child_process\\').execFile(\\'calc\\')';"),
  /indirect execution bridge/u);
  assert.equal(auditMediaExecutionSource('library/query.js',
    "{ const key = 'left'; } { const key = 'right'; }"), false);
});
