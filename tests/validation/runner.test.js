import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argumentsFor, auditTestResourceLeases, fullProfileNarrowingEnvironment, fullProfileRuntimeInjection,
  inventoryCandidateDifferences, parseTapSummary, resultOutcome, successfulRun, toolVersionArguments } from '../../tools/validation/run.js';
import { analyzeJavaScriptDependencies, caseFoldedEntryMap, dependencyClosure, filesIn, inventory,
  resolveLocalImport } from '../../tools/validation/inventory.js';
import { assertIsolatedOutput, assertValidationOutputChild, repositoryRoot, validationFileUrl, validationPath } from '../../tools/validation/paths.js';

const complete = '# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

test('validation cannot report success for missing, duplicate, failing or incomplete TAP summaries', () => {
  const counts = parseTapSummary(complete);
  assert.equal(successfulRun(0, counts), true);
  assert.equal(successfulRun(1, counts), false);
  assert.equal(successfulRun(0, parseTapSummary('')), false);
  assert.equal(successfulRun(0, parseTapSummary(complete + complete)), false);
  for (const field of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.equal(successfulRun(0, { ...counts, pass: 2, [field]: 1 }), false, field);
  }
  assert.equal(successfulRun(0, { ...counts, tests: 0, pass: 0 }), false);
  assert.equal(successfulRun(0, { ...counts, tests: 4 }), false);
  const stable = { candidateUnchanged: true, currentInputUnchanged: true, currentReleaseInputReady: true };
  assert.equal(resultOutcome(0, counts, { ...stable, scopeComplete: true }), 'passed');
  assert.equal(resultOutcome(0, counts, { ...stable, scopeComplete: false }), 'incomplete');
  assert.equal(resultOutcome(0, counts, { ...stable, scopeComplete: true, registrationComplete: false }), 'incomplete');
  assert.equal(resultOutcome(0, counts, { ...stable, testResourcesReleased: false }), 'incomplete');
});

test('validation preserves leftover resource evidence and accepts only an absent or empty lease directory', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-resource-audit-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'leases');
  assert.deepEqual(await auditTestResourceLeases(root), { root, released: true, remaining: [] });
  await mkdir(root);
  assert.deepEqual(await auditTestResourceLeases(root), { root, released: true, remaining: [] });
  await mkdir(path.join(root, 'occupied'));
  assert.deepEqual(await auditTestResourceLeases(root), { root, released: false, remaining: ['occupied'] });
  assert.equal(existsSync(path.join(root, 'occupied')), true, 'The audit must retain leaked ownership evidence.');
  const file = path.join(temporary, 'file'); await writeFile(file, 'not a lease directory');
  assert.equal((await auditTestResourceLeases(file)).released, false);
});

test('full validation cannot be narrowed by paths or inherited dialect selectors', () => {
  assert.throws(() => argumentsFor(['--profile', 'full', '--', 'tests/validation/runner.test.js']),
    /cannot be combined with an explicit test subset/u);
  assert.deepEqual(fullProfileNarrowingEnvironment({
    MEDIAMANAGER_TEST_POSTGRES: 'configured',
    MEDIAMANAGER_ARTIST_CONCURRENCY_DIALECT: 'sqlite',
    MEDIAMANAGER_USER_VIEW_QUERY_DIALECT: 'postgres',
    MEDIAMANAGER_EMPTY_DIALECT: '',
  }), ['MEDIAMANAGER_ARTIST_CONCURRENCY_DIALECT', 'MEDIAMANAGER_USER_VIEW_QUERY_DIALECT']);
  assert.deepEqual(fullProfileNarrowingEnvironment({ MEDIAMANAGER_TEST_POSTGRES: 'configured' }), []);
  assert.deepEqual(fullProfileRuntimeInjection({ NODE_OPTIONS: '--import=outside.mjs', NODE_PATH: 'outside' }, []),
    ['NODE_OPTIONS', 'NODE_PATH']);
  assert.deepEqual(fullProfileRuntimeInjection({}, ['--require', 'outside.cjs', '--test']), ['execArgv:--require']);
  assert.deepEqual(fullProfileRuntimeInjection({}, []), []);
  assert.deepEqual(toolVersionArguments('git'), ['--version']);
  assert.deepEqual(toolVersionArguments('ffmpeg'), ['-version']);
});

test('validation dependency closure follows transitive local helper imports without looping', () => {
  const dependencies = { entries: [
    { path: 'tests/example.test.js', imports: ['tests/helper-a.js'] },
    { path: 'tests/helper-a.js', imports: ['tests/helper-b.js'] },
    { path: 'tests/helper-b.js', imports: ['tests/helper-a.js'] },
    { path: 'tests/unrelated.js', imports: [] },
  ] };
  assert.deepEqual(dependencyClosure(dependencies, ['tests/example.test.js']).map(entry => entry.path), [
    'tests/example.test.js', 'tests/helper-a.js', 'tests/helper-b.js',
  ]);
  assert.throws(() => dependencyClosure(dependencies, ['tests/missing.test.js']), /does not contain/u);
  assert.throws(() => dependencyClosure({ entries: [
    { path: 'tests/example.test.js', imports: [], unresolvedImports: [{ reason: 'non-static-specifier' }] },
  ] }, ['tests/example.test.js']), /cannot resolve imports/u);
  assert.throws(() => dependencyClosure({ entries: [
    { path: 'tests/example.test.js', imports: ['tests/missing-helper.js'] },
  ] }, ['tests/example.test.js']), /does not contain/u);
});

test('dependency parser covers compact modules, static dynamic imports, CommonJS and ignores comments', () => {
  const result = analyzeJavaScriptDependencies(`
    import'./compact.js';
    export{x}from'./named.js';
    export*from'./all.js';
    // import './comment-line.js';
    /* export * from './comment-block.js'; */
    await import('./dynamic.js', { with: { type: 'json' } });
    await import(\`./template.js\`);
    require('./common.cjs');
    import './query.js?raw#fragment';
    import 'external-package';
  `);
  assert.deepEqual(result.importSpecifiers, [
    { kind: 'module', specifier: './all.js' },
    { kind: 'require', specifier: './common.cjs' },
    { kind: 'module', specifier: './compact.js' },
    { kind: 'module', specifier: './dynamic.js' },
    { kind: 'module', specifier: './named.js' },
    { kind: 'module', specifier: './query.js?raw#fragment' },
    { kind: 'module', specifier: './template.js' },
  ]);
  assert.deepEqual(result.unresolvedImports, []);
  const dynamic = analyzeJavaScriptDependencies('await import(target); require(factory());');
  assert.equal(dynamic.unresolvedImports.length, 2);
  assert.ok(dynamic.unresolvedImports.every(entry => entry.reason === 'non-static-specifier'));

  const bridges = analyzeJavaScriptDependencies(`
    import { createRequire as makeRequire } from 'node:module';
    import { spawn as launch } from 'node:child_process';
    const load = makeRequire(import.meta.url);
    module.require('./module-helper.cjs');
    load('./created-helper.js');
    launch('ffmpeg', []);
  `);
  assert.deepEqual(bridges.importSpecifiers, [
    { kind: 'require', specifier: './created-helper.js' },
    { kind: 'require', specifier: './module-helper.cjs' },
  ]);
  assert.deepEqual(bridges.tools, ['ffmpeg']);
  const scoped = analyzeJavaScriptDependencies(`
    function seed() { const target = './safe.js'; }
    async function load(target) { return import(target); }
  `);
  assert.deepEqual(scoped.importSpecifiers, []);
  assert.equal(scoped.unresolvedImports[0].reason, 'non-static-specifier');
  for (const source of [
    "import Module from 'node:module'; const load=Module.createRequire(import.meta.url); load('./helper.js');",
    "import { createRequire } from 'node:module'; const factory=createRequire; const load=factory(import.meta.url); load('./helper.js');",
    "const load=module.require; load('./helper.cjs');",
    "const { require: load }=module; load('./helper.cjs');",
  ]) assert.equal(analyzeJavaScriptDependencies(source).importSpecifiers.length, 1);
  const alternateBase = analyzeJavaScriptDependencies("import { createRequire } from 'node:module'; const load=createRequire(new URL('./sub/base.cjs', import.meta.url)); load('./helper.cjs');");
  assert.equal(alternateBase.unresolvedImports[0].reason, 'unsupported-create-require-base');
  const namespaceRequire = analyzeJavaScriptDependencies("import * as Module from 'node:module'; const {createRequire:make}=Module; const load=make(import.meta.url); load('./helper.cjs');");
  assert.deepEqual(namespaceRequire.importSpecifiers, [{ kind: 'require', specifier: './helper.cjs' }]);
  for (const source of [
    "eval(\"require('./hidden.cjs')\")",
    "require.call(null, './hidden.cjs')",
    "const box=[require]; box[0]('./hidden.cjs')",
    "import { createRequire } from 'node:module'; const load=createRequire(import.meta.url); const box={load}; box.load('./hidden.cjs')",
    "import { createRequire } from 'node:module'; const cr=(...args)=>createRequire(...args); cr(import.meta.url)('./hidden.cjs')",
    "{ const load=createRequire(import.meta.url); load('./hidden.cjs'); } { const load=value=>value; }",
    "process.getBuiltinModule('node:child_process').spawn('ffmpeg', [])",
  ]) assert.ok(analyzeJavaScriptDependencies(source).unresolvedImports.length > 0, source);
  const launchAnalysis = analyzeJavaScriptDependencies(`
    import { spawn as launch } from 'node:child_process';
    const execute = launch;
    execute('ffmpeg', []);
    launch(process.env['MEDIAMANAGER_DOTNET'], []);
  `);
  assert.deepEqual(launchAnalysis.tools, ['ffmpeg']);
  assert.deepEqual(launchAnalysis.environmentVariables, ['MEDIAMANAGER_DOTNET']);
  assert.deepEqual(launchAnalysis.unresolvedExecutables, []);
  assert.equal(analyzeJavaScriptDependencies("import { spawn } from 'node:child_process'; spawn(resolveBinary(), []);")
    .unresolvedExecutables[0].reason, 'non-static-executable');
  for (const source of [
    "import cp from 'node:child_process'; cp.spawn('ffmpeg', [])",
    "const { spawn: run }=require('node:child_process'); run('ffmpeg', [])",
    "const run=require('child_process').spawn; run('ffmpeg', [])",
  ]) assert.deepEqual(analyzeJavaScriptDependencies(source).tools, ['ffmpeg']);
  assert.ok(analyzeJavaScriptDependencies("import { spawn } from 'node:child_process'; const box={spawn}; box.spawn('ffmpeg', [])")
    .unresolvedExecutables.length > 0);
  assert.ok(analyzeJavaScriptDependencies("import { spawn } from 'node:child_process'; { const run=spawn; run('ffmpeg', []); } { const run=x=>x; }")
    .unresolvedExecutables.length > 0);
  assert.equal(analyzeJavaScriptDependencies("import 'data:text/javascript,export default 1'")
    .unresolvedImports[0].reason, 'unsupported-url-specifier');
});

test('configured media executors resolve only inside their reviewed production boundaries', () => {
  const configured = "import { spawn } from 'node:child_process'; class Copy { run() { return spawn(this.mediaEncoder.encoderPath, [], { shell: false }); } }";
  for (const sourcePath of ['src/playback/extraction.js', 'src/playback/remux.js', 'src/playback/hls.js']) {
    const result = analyzeJavaScriptDependencies(configured, { sourcePath });
    assert.deepEqual(result.tools, ['ffmpeg']); assert.deepEqual(result.unresolvedExecutables, []);
    for (const other of [configured.replace('mediaEncoder', 'unrelated'), configured.replace('this.mediaEncoder.encoderPath', 'resolveBinary()')])
      assert.ok(analyzeJavaScriptDependencies(other, { sourcePath }).unresolvedExecutables.length > 0);
  }
  assert.ok(analyzeJavaScriptDependencies(configured).unresolvedExecutables.length > 0);
  assert.ok(analyzeJavaScriptDependencies(configured, { sourcePath: 'src/unreviewed.js' }).unresolvedExecutables.length > 0);
  for (const name of ['capture', 'collectOutput']) {
    const source = `import { spawn } from 'node:child_process'; async function ${name}(program, args) { return spawn(program, args, { shell: false }); }
      export function readVersion(program) { return ${name}(program, ['-version']); }`;
    const result = analyzeJavaScriptDependencies(source, { sourcePath: 'src/storage/ffprobe.js' });
    assert.deepEqual(result.tools, ['ffmpeg', 'ffprobe']); assert.deepEqual(result.unresolvedExecutables, []);
    assert.ok(analyzeJavaScriptDependencies(source).unresolvedExecutables.length > 0);
    assert.ok(analyzeJavaScriptDependencies(source + `\nexport { ${name} };`, { sourcePath: 'src/storage/ffprobe.js' }).unresolvedExecutables.length > 0);
    assert.ok(analyzeJavaScriptDependencies(source + `\nexport default ${name};`, { sourcePath: 'src/storage/ffprobe.js' }).unresolvedExecutables.length > 0);
  }
  const generic = "import { spawn } from 'node:child_process'; export function run(program, args) { return spawn(program, args, { shell: false }); }";
  assert.ok(analyzeJavaScriptDependencies(generic, { sourcePath: 'src/storage/ffprobe.js' }).unresolvedExecutables.length > 0);
});

test('dependency analysis distinguishes ordinary binding data from process module capabilities', () => {
  const ordinary = analyzeJavaScriptDependencies(`
    const report = {};
    report.binding = { serverId: 'isolated', originIdentityDigest: 'recorded' };
    await transferDatabase(source, destination, { instanceBinding: report.binding });
    const { binding } = report;
    report.getBuiltinModule = 'diagnostic';
    observe(binding, report.getBuiltinModule);
  `);
  assert.deepEqual(ordinary.unresolvedImports, []);
  assert.deepEqual(ordinary.unresolvedExecutables, []);
  for (const source of [
    "process.binding('fs')",
    "process['getBuiltinModule']('node:fs')",
    "globalThis.process.dlopen(module, filename)",
    "const p = process; const alias = p; alias._linkedBinding('hidden')",
    "let p; p = process; p.binding('fs')",
    "const { process: p } = globalThis; p.binding('fs')",
    "import p from 'node:process'; p.binding('fs')",
    "import * as p from 'process'; p.default.binding('fs')",
    "import { getBuiltinModule as load } from 'node:process'; load('fs')",
    "const p = require('node:process'); p.binding('fs')",
    "const p = await import('node:process'); p.getBuiltinModule('fs')",
    "const { binding: load } = process; load('fs')",
    "let load; ({ binding: load } = globalThis.process); load('fs')",
  ]) assert.ok(analyzeJavaScriptDependencies(source).unresolvedImports.some(entry => entry.kind === 'runtime-module'), source);
});

test('local dependency resolution binds query imports and rejects missing, outside and linked targets', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-import-resolution-'));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const repository = path.join(temporary, 'repository');
  const source = path.join(repository, 'src');
  const outside = path.join(temporary, 'outside');
  await mkdir(source, { recursive: true });
  await mkdir(outside);
  const importer = path.join(source, 'main.js');
  const dependency = path.join(source, 'dependency.js');
  const hashDependency = path.join(source, 'dependency.cjs#other');
  await writeFile(importer, '');
  await writeFile(dependency, '');
  await writeFile(hashDependency, "module.exports = 'other';");
  await writeFile(path.join(outside, 'dependency.js'), '');
  const options = { repository, rootRealPath: await realpath(repository),
    knownEntries: new Map([['src/dependency.js', 'src/dependency.js']]) };
  assert.deepEqual(await resolveLocalImport(importer,
    { kind: 'module', specifier: './dependency.js?raw#fragment' }, options), { imported: 'src/dependency.js' });
  assert.deepEqual(await resolveLocalImport(importer,
    { kind: 'module', specifier: './missing.js' }, options), { error: 'local-target-not-found' });
  assert.deepEqual(await resolveLocalImport(importer,
    { kind: 'require', specifier: './dependency.cjs#other' }, options),
  { error: 'local-target-unsupported-extension' });
  assert.deepEqual(await resolveLocalImport(importer,
    { kind: 'module', specifier: '../../outside/dependency.js' }, options), { error: 'local-target-outside-repository' });
  const linked = path.join(source, 'linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await resolveLocalImport(importer,
    { kind: 'module', specifier: './linked/dependency.js' }, options), { error: 'local-target-symbolic-link' });
  if (process.platform === 'win32') {
    assert.deepEqual(await resolveLocalImport(importer,
      { kind: 'module', specifier: './DEPENDENCY.js' }, options), { imported: 'src/dependency.js' });
  }
  const packageDirectory = path.join(source, 'package');
  await mkdir(packageDirectory);
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ main: 'actual.cjs' }));
  await writeFile(path.join(packageDirectory, 'actual.cjs'), "module.exports = 'actual';");
  await writeFile(path.join(packageDirectory, 'index.js'), "export default 'wrong';");
  const packageKnown = caseFoldedEntryMap(['src/package/actual.cjs', 'src/package/index.js']);
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'require', specifier: './package' },
    { repository, rootRealPath: await realpath(repository), knownEntries: packageKnown }),
  { imported: 'src/package/actual.cjs' });
  await writeFile(path.join(source, 'extension.cjs'), "module.exports = 'wrong';");
  await writeFile(path.join(source, 'extension.json'), '"actual"');
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'require', specifier: './extension' },
    { repository, rootRealPath: await realpath(repository), knownEntries: packageKnown }),
  { importedFile: 'src/extension.json' });
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'module', specifier: './dependency.js' },
    { ...options, knownEntries: new Map([['src/dependency.js', 'src/package/index.js']]) }),
  { error: 'known-source-realpath-mismatch' });
  assert.throws(() => caseFoldedEntryMap(['src/Foo.js', 'src/foo.js']), /case-fold collision/u);
});

test('reference discovery binds actual reads without treating assertion identities or source text as inputs', () => {
  const analyze = analyzeJavaScriptDependencies(`
    import { readFile, writeFile } from 'node:fs/promises';
    const input = await readFile(new URL('../../.test-input/evidence/actual.json', import.meta.url));
    assert.equal(expected, '.test-input/evidence/identity.json');
    assert.equal(await readFile('.test-input/evidence/asserted-read.json'), expected);
    await writeFile('.test-input/evidence/output.json', input);
    // readFile('.test-input/evidence/comment.json');
    const sourceText = "readFile('.test-input/evidence/quoted-source.json')";
  `);
  assert.deepEqual(analyze.referenceDeclarations, [
    { logicalPath: '.test-input/evidence/actual.json', dynamic: false, required: true },
    { logicalPath: '.test-input/evidence/identity.json', dynamic: false, required: false },
    { logicalPath: '.test-input/evidence/asserted-read.json', dynamic: false, required: true },
    { logicalPath: '.test-input/evidence/output.json', dynamic: false, required: false, usage: 'output-declaration' }
  ]);
});

test('inventory includes shared native evidence verifiers in the selected input closure', async () => {
  const dependencies = await inventory();
  const identity = dependencyClosure(dependencies, ['tests/library/current-identity-http.test.js']);
  assert.ok(identity.some(entry => entry.path === 'tests/helpers/current-identity-scenario.js'));
  assert.ok(identity.some(entry => entry.path === 'tools/compat/record-current-identities.js'));
  assert.ok(identity.some(entry => entry.path === 'tools/compat/identity-side-effect-input.js'));
  assert.ok(identity.some(entry => entry.path === 'tools/compat/current-native-reference.js'));
  assert.ok(identity.flatMap(entry => entry.services).includes('nativeInstance'));
  assert.equal(identity.flatMap(entry => entry.declaredReferences)
    .some(reference => reference.required && reference.logicalPath.startsWith('.test-input/evidence/core-flow-20260926/')), false,
  'new identity evidence must not inherit unavailable historical preparation inputs');
  assert.ok(!identity.some(entry => entry.path === 'tests/library/native-identity-inputs.js'),
    'current identities must not depend on unavailable historical recordings');

  const byName = dependencyClosure(dependencies, ['tests/library/current-byname-filter-http.test.js',
    'tests/library/current-artist-filter-side-http.test.js']);
  assert.ok(byName.some(entry => entry.path === 'tests/helpers/current-byname-filter-scenario.js'));
  assert.ok(byName.some(entry => entry.path === 'tools/compat/artist-filter-input.js'));
  assert.ok(byName.some(entry => entry.path === 'tools/compat/current-native-reference.js'));
  const byNameFixture = byName.flatMap(entry => entry.fixtureReferences)
    .find(reference => reference.relativePath === ['.', 'fixtures', 'current-byname-filters', 'input-identities.json'].join('/'));
  assert.ok(byNameFixture, 'the original controlled by-name inputs must retain their exact byte bindings');
  const byNameBinding = JSON.parse(await readFile(byNameFixture.filename, 'utf8'));
  assert.equal(Object.keys(byNameBinding).length, 5);
  assert.ok(Object.values(byNameBinding).every(value => /^[a-f0-9]{64}$/u.test(value)));
  assert.ok(byName.flatMap(entry => entry.services).includes('nativeInstance'));
  assert.ok(!byName.flatMap(entry => entry.declaredReferences).some(reference => reference.required
    && reference.logicalPath.startsWith('.test-input/')), 'current comparisons must not inherit historical recording requirements');

  const conflicts = dependencyClosure(dependencies, ['tests/library/current-identity-conflicts-http.test.js']);
  for (const filename of ['tests/helpers/current-conflict-scenario.js', 'tests/helpers/current-identity-scenario.js',
    'tools/compat/record-current-identities.js', 'tools/compat/identity-side-effect-input.js',
    'tools/compat/current-native-reference.js', 'tools/validation/native-instance-inputs.js']) {
    assert.ok(conflicts.some(entry => entry.path === filename), filename);
  }
  assert.ok(conflicts.flatMap(entry => entry.services).includes('nativeInstance'));
  assert.equal(conflicts.some(entry => entry.path === 'tests/library/native-conflict-inputs.js'), false);
  assert.ok(!conflicts.flatMap(entry => entry.declaredReferences).some(reference => reference.required
    && reference.logicalPath.startsWith('.test-input/')), 'current conflict inputs come from independent same-run discovery');

  const syncPlayDate = dependencyClosure(dependencies, ['tests/sessions/syncplay-date-impact-http.test.js']);
  for (const filename of ['tools/compat/record-syncplay-date-impact.mjs', 'tools/compat/current-native-reference.js',
    'tools/validation/native-instance-inputs.js', 'tests/sessions/syncplay-date-impact-scenario.js']) {
    assert.ok(syncPlayDate.some(entry => entry.path === filename), filename);
  }
  assert.equal(syncPlayDate.some(entry => entry.path === 'tests/sessions/syncplay-date-impact-inputs.js'), false,
    'the current actual comparison must not require historical recordings');
  for (const variable of ['MEDIAMANAGER_TEST_NATIVE_INSTANCE', 'MEDIAMANAGER_TEST_POSTGRES']) {
    assert.ok(syncPlayDate.flatMap(entry => entry.variables).includes(variable), variable);
  }

  const queryFactory = dependencyClosure(dependencies, ['tests/library/native-query-scope.test.js']);
  assert.ok(queryFactory.some(entry => entry.path === 'tests/library/native-query-inputs.js'));
  assert.equal(queryFactory.some(entry => entry.path === 'tests/library/native-query-default-inputs.js'), false,
    'The explicit-profile factory unit test does not acquire an external recording.');

  const currentFilterConsumers = ['classification-filter-http', 'extra-placeholder-filter-http', 'image-type-filter-http',
    'navigation-date-filter-http', 'official-rating-filter-http', 'official-rating-range-http', 'rating-permissions-http',
    'static-audio-source-evidence', 'static-audio-source-permissions-http', 'static-source-permissions-http',
    'tag-filter-http', 'tag-permissions-http'];
  const currentFilterProfilePath = path.join(repositoryRoot, 'tests/library/fixtures/filter-http-current/current-profile.json');
  const currentFilterProfile = JSON.parse(await readFile(currentFilterProfilePath, 'utf8'));
  assert.equal(currentFilterProfile.kind, 'same-workflow-current-native-filter-http');
  assert.equal(currentFilterProfile.historicalRecordingReused, false);
  assert.ok(currentFilterProfile.inputs.length > 0);
  assert.equal(new Set(currentFilterProfile.inputs.map(entry => entry.filename)).size, currentFilterProfile.inputs.length);
  for (const descriptor of currentFilterProfile.inputs) {
    assert.equal(typeof descriptor.filename, 'string'); assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0);
  }
  for (const name of currentFilterConsumers) {
    const closure = dependencyClosure(dependencies, ['tests/library/' + name + '.test.js']);
    for (const filename of ['tests/library/current-filter-http.js',
      'tests/library/fixtures/filter-http-current/record-native.js', 'tests/library/fixtures/filter-http-current/scenario.js',
      'tools/compat/current-native-reference.js', 'tools/validation/native-instance-inputs.js',
      'tools/validation/native-build-inputs.js']) assert.ok(closure.some(entry => entry.path === filename), name + ': ' + filename);
    for (const service of ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'])
      assert.ok(closure.flatMap(entry => entry.services).includes(service), name + ': ' + service);
    for (const historical of ['native-query-inputs', 'native-query-default-inputs', 'native-item-filter-evidence'])
      assert.equal(closure.some(entry => entry.path === 'tests/library/' + historical + '.js'), false, name + ': ' + historical);
    assert.ok(closure.flatMap(entry => entry.fixtureReferences).some(entry => entry.filename === currentFilterProfilePath),
      name + ': current execution input manifest must be discoverable');
    assert.equal(closure.flatMap(entry => entry.fixtureReferences)
      .some(entry => /\/(?:classification-filters|extra-placeholder-filters|image-type-filters|navigation-date-filters|official-rating-filters|official-rating-range|rating-permissions|tag-filters|tag-permissions)\/provenance\.json$/u
        .test(entry.filename.replaceAll('\\', '/')) || /\/native-query-inputs\/(?:binding|static-source-permissions|static-audio-source-permissions)\.json$/u
        .test(entry.filename.replaceAll('\\', '/'))), false,
    name + ': an unconsumed historical seal must not enter current inputs');
  }

  const staticPermissions = dependencyClosure(dependencies, ['tests/library/static-source-permissions-http.test.js']);
  assert.ok(staticPermissions.some(entry => entry.path === 'tests/library/native-static-source-evidence.js'));
  assert.ok(staticPermissions.some(entry => entry.path === 'tests/library/native-filter-input.js'));
  assert.ok(staticPermissions.flatMap(entry => entry.variables).includes('MEDIAMANAGER_FILTER_WIRE_EVIDENCE'));
  const audioPermissions = dependencyClosure(dependencies, ['tests/library/static-audio-source-permissions-http.test.js']);
  assert.ok(audioPermissions.some(entry => entry.path === 'tests/library/native-static-audio-source-evidence.js'));
  assert.ok(audioPermissions.some(entry => entry.path === 'tests/library/native-filter-input.js'));
  const audioFixture = audioPermissions.flatMap(entry => entry.fixtureReferences)
    .find(entry => entry.relativePath === ['.', 'fixtures', 'filter-http-current', 'static-audio-binding.json'].join('/'));
  assert.ok(audioFixture, 'The current Audio matrix and exact recovered neutral input must be discoverable.');
  const audioBinding = JSON.parse(await readFile(audioFixture.filename, 'utf8'));
  assert.equal(audioBinding.kind, 'same-workflow-current-native-static-audio');
  assert.equal(audioBinding.cases.length, 8);
  assert.equal(audioBinding.neutralFixture.sha256, 'ce88db7c19e262d371e36e63f8f7fb3541242151d481458999d4720cab9257db');
  for (const descriptor of [audioBinding.originalNeutralFixture, audioBinding.neutralFixture,
    audioBinding.nativeRecorder, audioBinding.requestMatrix]) {
    assert.equal(typeof descriptor.filename, 'string'); assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.ok(audioPermissions.flatMap(entry => entry.variables).includes('MEDIAMANAGER_FILTER_WIRE_EVIDENCE'));

  const extraction = dependencyClosure(dependencies, ['tests/playback/extraction.test.js']);
  assert.ok(extraction.some(entry => entry.path === 'src/playback/extraction.js'));
  assert.ok(extraction.flatMap(entry => entry.tools).includes('ffmpeg'));
  assert.ok(extraction.flatMap(entry => entry.tools).includes('ffprobe'));

  const runner = dependencyClosure(dependencies, ['tests/validation/runner.test.js']);
  assert.ok(runner.some(entry => entry.path === 'tools/validation/inventory.js'));
});

test('validation root mapping preserves logical identities, trailing directory URLs and unrelated paths', () => {
  const docs = '.test-input';
  const environment = { MEDIAMANAGER_VALIDATION_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'inputs'),
    MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'item-filter-inputs'),
    MEDIAMANAGER_USER_VIEW_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'user-view-inputs'),
    MEDIAMANAGER_IDENTITY_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'identity-inputs'),
    MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'byname-filter-inputs'),
    MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'native-conflict-inputs'),
    MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT: path.join(repositoryRoot, '.test-output', 'syncplay-date-impact-inputs'),
    MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT: path.join(repositoryRoot, '.agent-temp', 'baseline'),
    MEDIAMANAGER_VALIDATION_REFERENCE_ROOT: path.join(repositoryRoot, '.agent-temp', 'http-reference'),
    MEDIAMANAGER_TEST_NATIVE_INSTANCE: path.join(repositoryRoot, '.agent-temp', 'native'),
    MEDIAMANAGER_TEST_NATIVE_SQLITE: path.join(repositoryRoot, '.agent-temp', 'native.db') };
  assert.equal(validationPath(`${docs}/evidence/sample/input.json`, repositoryRoot, environment),
    path.join(environment.MEDIAMANAGER_VALIDATION_INPUT_ROOT, 'sample', 'input.json'));
  for (const [name, variable] of [['item-filter', 'MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT'],
    ['user-view', 'MEDIAMANAGER_USER_VIEW_INPUT_ROOT'], ['identity', 'MEDIAMANAGER_IDENTITY_INPUT_ROOT'],
    ['byname-filter', 'MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT'], ['native-conflict', 'MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT'],
    ['syncplay-date-impact', 'MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT']]) {
    assert.equal(validationPath(`${docs}/evidence/${name}-inputs/scenario/input.json`, repositoryRoot, environment),
      path.join(environment[variable], 'scenario', 'input.json'));
    assert.equal(validationPath(`${docs}/evidence/${name}-inputs-other/input.json`, repositoryRoot, environment),
      path.join(environment.MEDIAMANAGER_VALIDATION_INPUT_ROOT, `${name}-inputs-other`, 'input.json'),
    'the new input namespace must stop at its path-segment boundary');
  }
  assert.equal(validationPath(`${docs}/baselines/jellyfin-current/source/a.cs`, repositoryRoot, environment),
    path.join(environment.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT, 'source', 'a.cs'));
  assert.equal(validationPath('.test-input/evidence/core-flow-20260926/reference/config/system.xml', repositoryRoot, environment),
    path.join(environment.MEDIAMANAGER_VALIDATION_REFERENCE_ROOT, 'config', 'system.xml'));
  assert.equal(validationPath('.test-input/evidence/core-flow-20260926/reference/bootstrap.json', repositoryRoot, environment),
    path.join(environment.MEDIAMANAGER_VALIDATION_REFERENCE_ROOT, 'bootstrap.json'));
  assert.equal(validationPath('.test-input/reference-instance/data/data/jellyfin.db', repositoryRoot, environment),
    path.join(environment.MEDIAMANAGER_TEST_NATIVE_INSTANCE, 'data', 'data', 'jellyfin.db'));
  assert.equal(validationPath('.test-input/evidence/core-flow-20260926/initial.db', repositoryRoot, environment),
    environment.MEDIAMANAGER_TEST_NATIVE_SQLITE);
  assert.equal(validationPath(`${docs}/evidence-other/a.json`, repositoryRoot, environment),
    path.join(repositoryRoot, '.test-input', 'evidence-other', 'a.json'));
  const url = validationFileUrl('./', pathToFileURL(path.join(repositoryRoot, 'tests') + path.sep));
  assert.equal(url.pathname.endsWith('/'), true);
  assert.equal(fileURLToPath(new URL('input.json', url)), path.join(repositoryRoot, 'tests', 'input.json'));
  for (const absolute of ['C:/validation/reference/tool.exe', 'C:\\validation\\reference\\tool.exe']) {
    assert.equal(fileURLToPath(validationFileUrl(absolute, url)), path.resolve(absolute));
  }
  assert.throws(() => validationFileUrl('https://example.invalid/input.json'), /file:/u);
});

test('validation output rejects reference and native input descendants without creating files', () => {
  const protectedRoot = path.join(repositoryRoot, '.agent-temp', 'protected-validation-input');
  const validationInput = path.join(repositoryRoot, '.agent-temp', 'declared-validation-input');
  const runtimeRoot = path.join(repositoryRoot, '.agent-temp', 'declared-runtime');
  const environment = { MEDIAMANAGER_JELLYFIN_SOURCE: protectedRoot,
    MEDIAMANAGER_TEST_NATIVE_INSTANCE: path.join(repositoryRoot, '.agent-temp', 'native-validation-input'),
    MEDIAMANAGER_TEST_NATIVE_SQLITE: path.join(repositoryRoot, '.agent-temp', 'query-validation-input', 'initial.db'),
    MEDIAMANAGER_VALIDATION_REFERENCE_ROOT: path.join(repositoryRoot, '.agent-temp', 'http-reference-input'),
    MEDIAMANAGER_VALIDATION_INPUT_ROOT: validationInput,
    MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT: path.join(repositoryRoot, '.agent-temp', 'filter-query-input'),
    MEDIAMANAGER_USER_VIEW_INPUT_ROOT: path.join(repositoryRoot, '.agent-temp', 'view-query-input'),
    MEDIAMANAGER_IDENTITY_INPUT_ROOT: path.join(repositoryRoot, '.agent-temp', 'identity-input'),
    MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT: path.join(repositoryRoot, '.agent-temp', 'byname-filter-input'),
    MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT: path.join(repositoryRoot, '.agent-temp', 'native-conflict-input'),
    MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT: path.join(repositoryRoot, '.agent-temp', 'syncplay-date-impact-input'),
    MEDIAMANAGER_JELLYFIN_DLL: path.join(runtimeRoot, 'jellyfin.dll') };
  assert.throws(() => assertIsolatedOutput(protectedRoot, environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.join(protectedRoot, 'result'), environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.join(environment.MEDIAMANAGER_TEST_NATIVE_INSTANCE, 'result'), environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.dirname(environment.MEDIAMANAGER_TEST_NATIVE_SQLITE), environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.join(path.dirname(environment.MEDIAMANAGER_TEST_NATIVE_SQLITE), 'result'), environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.join(environment.MEDIAMANAGER_VALIDATION_REFERENCE_ROOT, 'result'), environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.join(validationInput, 'result'), environment), /outside reference/u);
  for (const variable of ['MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT', 'MEDIAMANAGER_USER_VIEW_INPUT_ROOT',
    'MEDIAMANAGER_IDENTITY_INPUT_ROOT', 'MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT', 'MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT',
    'MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT']) {
    assert.throws(() => assertIsolatedOutput(environment[variable], environment), /outside reference/u);
    assert.throws(() => assertIsolatedOutput(path.join(environment[variable], 'result'), environment), /outside reference/u);
    assert.doesNotThrow(() => assertIsolatedOutput(environment[variable] + '-results', environment));
  }
  assert.throws(() => assertIsolatedOutput(path.join(runtimeRoot, 'result'), environment), /outside reference/u);
  assert.throws(() => assertIsolatedOutput(path.dirname(validationInput), environment), /outside reference/u);
  assert.doesNotThrow(() => assertIsolatedOutput(protectedRoot + '-results', environment));
});

test('validation recorder outputs reject junction and symlink escapes below the configured root', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-validation-output-'));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const output = path.join(temporary, 'output');
  const outside = path.join(temporary, 'outside');
  const escape = path.join(output, 'escape');
  await mkdir(output);
  await mkdir(outside);
  await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  const environment = { MEDIAMANAGER_VALIDATION_OUTPUT_ROOT: output,
    MEDIAMANAGER_JELLYFIN_SOURCE: path.join(temporary, 'protected-source') };
  assert.equal(assertValidationOutputChild(path.join(output, 'ordinary', 'capture'), environment),
    path.join(output, 'ordinary', 'capture'));
  assert.throws(() => assertValidationOutputChild(path.join(escape, 'capture'), environment), /cannot escape/u);
  assert.throws(() => assertValidationOutputChild(output, environment), /must be a child/u);
  assert.throws(() => assertValidationOutputChild(path.join(temporary, 'sibling'), environment), /must be a child/u);
});

test('validation file discovery rejects symbolic-link and junction entries instead of omitting them', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-validation-discovery-'));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const source = path.join(temporary, 'source');
  const outside = path.join(temporary, 'outside');
  await mkdir(source); await mkdir(outside);
  await writeFile(path.join(outside, 'hidden.test.js'), '');
  await symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(filesIn(source), /Symbolic links are not supported in validation discovery/u);
  await assert.rejects(filesIn(path.join(source, 'linked')), /Symbolic links are not supported in validation discovery/u);
});

test('registration reporter does not count Node synthetic wrappers as test registrations', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-registration-reporter-'));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const empty = path.join(temporary, 'empty.test.js');
  const output = path.join(temporary, 'registrations.json');
  await writeFile(empty, '// intentionally empty\n');
  const selected = path.relative(repositoryRoot, empty).replaceAll('\\', '/');
  const reporter = pathToFileURL(path.join(repositoryRoot, 'tools/validation/tap-registration-reporter.js')).href;
  const childEnvironment = { ...process.env, MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: output,
    MEDIAMANAGER_TEST_REGISTRATION_ROOT: repositoryRoot,
    MEDIAMANAGER_TEST_REGISTRATION_SELECTED: JSON.stringify([selected]) };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, empty], { cwd: repositoryRoot,
    env: childEnvironment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(output), true, `${result.stdout}\n${result.stderr}`);
  const registration = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(registration.missing, [selected]);
  assert.equal(registration.files[0].registrations, 0);
});

test('inventory hashes are cross-checked against the candidate snapshot', () => {
  const dependencies = { entries: [{ path: 'src/a.js', sha256: 'expected' }] };
  assert.deepEqual(inventoryCandidateDifferences(dependencies,
    { entries: [{ path: 'src/a.js', available: true, sha256: 'expected' }] }), []);
  assert.deepEqual(inventoryCandidateDifferences(dependencies,
    { entries: [{ path: 'src/a.js', available: true, sha256: 'changed' }] }),
  [{ path: 'src/a.js', reason: 'sha256-mismatch' }]);
});
