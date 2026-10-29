import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { affectedUnavailable, applyAffectedSelection, changedFilesForEvent, parseGitChanges, selectAffected } from '../../tools/ci/affected.js';
import { repositoryRoot } from '../../tools/validation/paths.js';
import { analyzeJavaScriptDependencies, caseFoldedEntryMap, inventory, resolveLocalImport } from '../../tools/validation/inventory.js';

const first = 'tests/core/first.test.js', second = 'tests/core/second.test.js', unrelated = 'tests/core/unrelated.test.js';
const base = '1'.repeat(40), head = '2'.repeat(40), branch = '3'.repeat(40);
const entry = (filename, overrides = {}) => ({ path: filename, test: filename.endsWith('.test.js'), imports: [],
  importedFiles: [], fixtureReferences: [], declaredReferences: [], unresolvedImports: [], unresolvedExecutables: [], repositoryInspections: [], ...overrides });
const inspectedEntry = (filename, source, overrides = {}) => {
  const analysis = analyzeJavaScriptDependencies(source, { sourcePath: filename });
  return entry(filename, { repositoryInspections: analysis.repositoryInspections, executionSources: analysis.executionSources, ...overrides });
};
const change = (filename, status = 'M') => ({ status, path: filename });
const comparison = changes => ({ event: 'push', baseSha: base, headSha: head, changes, fallbackReasons: [] });
const plan = (entries, changes, overrides = {}) => selectAffected({ dependencies: { entries },
  tracked: new Set([...entries.map(value => value.path), ...changes.map(value => value.path)]), comparison: comparison(changes), ...overrides });
const codes = value => value.fallbackReasons.map(reason => reason.code);
const success = stdout => ({ status: 0, stdout: stdout ?? '' });

function eventHarness({ eventName = 'push', event = { before: base, after: head, forced: false }, diff = `M\0${first}\0`, overrides = {} } = {}) {
  const calls = [];
  const responses = new Map([
    [JSON.stringify(['rev-parse', '--verify', 'HEAD']), success(head + '\n')],
    [JSON.stringify(['rev-parse', '--verify', 'HEAD^1']), success(base + '\n')],
    [JSON.stringify(['rev-parse', '--verify', 'HEAD^2']), success(branch + '\n')],
    [JSON.stringify(['cat-file', '-e', base + '^{commit}']), success()],
    [JSON.stringify(['merge-base', '--is-ancestor', base, head]), success()],
    [JSON.stringify(['diff', '--quiet', 'HEAD', '--']), success()],
    [JSON.stringify(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, head, '--']), success(diff)],
    ...Object.entries(overrides),
  ]);
  const runGit = args => {
    calls.push(args);
    const response = responses.get(JSON.stringify(args));
    assert.ok(response, `unexpected Git command: ${JSON.stringify(args)}`);
    return response;
  };
  const environment = { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: '/event.json', GITHUB_SHA: head };
  return { calls, run: () => changedFilesForEvent(environment, { runGit, readEvent: async () => JSON.stringify(event) }) };
}

test('Git change parsing preserves exact NUL-delimited names and refuses ambiguous or incomplete output', () => {
  const unusual = 'tests/core/name with spaces\tand\nnewline.test.js';
  assert.deepEqual(parseGitChanges(`M\0${unusual}\0A\0${first}\0`), [change(unusual), change(first, 'A')]);
  assert.deepEqual(parseGitChanges(`R100\0${first}\0${second}\0`), [{ status: 'R100', previousPath: first, path: second }]);
  assert.deepEqual(parseGitChanges(''), []);
  for (const invalid of [`M\0${first}`, `M\0${first}\0M\0${first}\0`, 'U\0conflict\0', 'M\0../outside\0',
    'M\0/absolute\0', 'M\0tests\\escaped.test.js\0', 'M\0tests/invalid\uFFFD.test.js\0', 'R100\0old\0']) {
    assert.throws(() => parseGitChanges(invalid));
  }
});

test('push comparison binds the checked-out candidate, available ancestor and exact changed paths', async () => {
  const harness = eventHarness();
  assert.deepEqual(await harness.run(), comparison([change(first)]));
  assert.ok(harness.calls.some(args => args[0] === 'merge-base'));
  assert.deepEqual(harness.calls.at(-1), ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, head, '--']);
});

test('PR comparison binds both merge parents instead of diffing against a moving branch name', async () => {
  const event = { pull_request: { base: { sha: base }, head: { sha: branch } } };
  const result = await eventHarness({ eventName: 'pull_request', event }).run();
  assert.equal(result.event, 'pull_request');
  assert.equal(result.baseSha, base);
  assert.equal(result.headSha, head);
  assert.deepEqual(result.changes, [change(first)]);
  assert.deepEqual(result.fallbackReasons, []);
  const changedBase = await eventHarness({ eventName: 'pull_request', event,
    overrides: { [JSON.stringify(['rev-parse', '--verify', 'HEAD^1'])]: success(branch) } }).run();
  assert.deepEqual(codes(changedBase), ['pull-request-merge-parents-mismatch']);
});

test('untrusted comparisons fall back explicitly without selecting a guessed baseline', async () => {
  const scenarios = [
    [{ event: { before: base, after: head, forced: true } }, 'force-push'],
    [{ event: { before: '0'.repeat(40), after: head } }, 'missing-base-sha'],
    [{ event: { before: base, after: branch } }, 'push-head-mismatch'],
    [{ event: null }, 'invalid-event-payload'],
    [{ overrides: { [JSON.stringify(['rev-parse', '--verify', 'HEAD'])]: success(branch) } }, 'candidate-sha-mismatch'],
    [{ overrides: { [JSON.stringify(['cat-file', '-e', base + '^{commit}'])]: { status: 1 } } }, 'base-commit-unavailable'],
    [{ overrides: { [JSON.stringify(['merge-base', '--is-ancestor', base, head])]: { status: 1 } } }, 'base-not-ancestor'],
    [{ overrides: { [JSON.stringify(['diff', '--quiet', 'HEAD', '--'])]: { status: 1 } } }, 'dirty-candidate'],
    [{ diff: '' }, 'empty-comparison'],
    [{ diff: `M\0${first}` }, 'invalid-git-diff'],
    [{ eventName: 'workflow_dispatch' }, 'unsupported-automatic-event'],
  ];
  for (const [options, expected] of scenarios) assert.deepEqual(codes(await eventHarness(options).run()), [expected]);
  const unreadable = await changedFilesForEvent({ GITHUB_EVENT_NAME: 'push' }, {
    readEvent: async () => { throw new Error('missing event'); }, runGit: () => assert.fail('must not guess without event'),
  });
  assert.deepEqual(codes(unreadable), ['event-unavailable']);
});

test('an edited test selects itself, transitive importing tests and repository inspection tests', () => {
  const inspector = 'tests/validation/inspector.test.js', helper = 'tests/helpers/shared.js';
  const entries = [entry(first), entry(second, { imports: [helper] }), entry(helper, { imports: [first] }), entry(unrelated),
    inspectedEntry(inspector, "import { inventory as scan } from '../../tools/validation/inventory.js'; await scan();",
      { imports: ['tools/validation/inventory.js'] }), entry('tools/validation/inventory.js')];
  const result = plan(entries, [change(first)]);
  assert.equal(result.mode, 'affected');
  assert.deepEqual(result.affected, [first, second, inspector].sort());
  assert.ok(result.matches.some(match => match.test === second && match.consumer === first && match.kind === 'source-closure'));
  assert.ok(result.matches.some(match => match.test === inspector && match.kind === 'repository-inspection'));
  assert.ok(!result.affected.includes(unrelated));
});

test('repository inspection follows scanner bindings while ordinary provider exports remain ordinary helpers', () => {
  const filename = 'tests/validation/inspection.test.js';
  const inspections = source => analyzeJavaScriptDependencies(source, { sourcePath: filename }).repositoryInspections;
  for (const source of [
    "import { inventory } from '../../tools/validation/inventory.js';",
    "import { describeFile as describe, sha256 } from '../../tools/validation/inventory.js'; describe('one file'); sha256(bytes);",
    "import * as evidence from '../../tools/validation/inventory.js'; evidence.describeFile('one file'); evidence['sha256'](bytes);",
    "import * as evidence from '../../tools/validation/inventory.js'; const { describeFile } = evidence; describeFile('one file');",
    "import { inputsUnchanged } from '../../tools/validation/inputs.js'; inputsUnchanged(before, after);",
    "import { parseTapSummary } from '../../tools/validation/run.js'; parseTapSummary(tap);",
    "import { inventory as scan } from '../../tools/validation/inventory.js'; function ordinary(scan) { return scan(); } ordinary(local);",
    "import * as evidence from '../../tools/validation/inventory.js'; { const evidence = local; evidence.inventory(); }",
    "const inventory = local; inventory(); // import { inventory } from '../../tools/validation/inventory.js';",
    "const text = `import { inventory } from '../../tools/validation/inventory.js'; inventory();`;",
  ]) assert.deepEqual(inspections(source), [], source);
  const inventoryUse = [{ provider: 'tools/validation/inventory.js', entrypoint: 'inventory' }];
  for (const source of [
    "import { inventory as scan } from '../../tools/validation/inventory.js'; await scan();",
    "import { inventory } from '../../tools/validation/inventory.js'; const scan = inventory; await scan();",
    "import { inventory } from '../../tools/validation/inventory.js'; consume(inventory);",
    "import * as evidence from '../../tools/validation/inventory.js'; await evidence.inventory();",
    "import * as evidence from '../../tools/validation/inventory.js'; await evidence['inventory']();",
    "import * as evidence from '../../tools/validation/inventory.js'; const { inventory: scan } = evidence; await scan();",
    "import * as evidence from '../../tools/validation/inventory.js'; evidence[selected]();",
    "import * as evidence from '../../tools/validation/inventory.js'; consume(evidence);",
    "const evidence = await import('../../tools/validation/inventory.js'); consume(evidence);",
    "const { inventory: scan } = require('../../tools/validation/inventory.js'); scan();",
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const evidence = load('../../tools/validation/inventory.js'); evidence.inventory();",
    "export { inventory as scan } from '../../tools/validation/inventory.js';",
    "export * from '../../tools/validation/inventory.js';",
  ]) assert.deepEqual(inspections(source), inventoryUse, source);
  assert.deepEqual(inspections("import { captureInputIdentity as capture } from '../../tools/validation/inputs.js'; await capture(options);"),
    [{ provider: 'tools/validation/inputs.js', entrypoint: 'captureInputIdentity' }]);
  for (const provider of ['tools/validation/run.js', 'tools/ci/run.js']) {
    assert.deepEqual(inspections(`import { main as run } from '../../${provider}'; await run();`),
      [{ provider, entrypoint: 'main' }]);
  }
});

test('ordinary oracle descriptors do not expand an edited test to unrelated Native consumers, while scanner helpers retain repository ownership', () => {
  const oracle = 'tests/helpers/oracle.js', scanner = 'tests/helpers/scanner.js', inspector = 'tests/validation/inspection.test.js';
  const entries = [entry(first),
    entry(unrelated, { imports: [oracle] }),
    inspectedEntry(oracle, "import { describeFile } from '../../tools/validation/inventory.js'; export const describe = file => describeFile(file);",
      { imports: ['tools/validation/inventory.js'] }),
    entry(inspector, { imports: [scanner] }),
    inspectedEntry(scanner, "import { captureInputIdentity as capture } from '../../tools/validation/inputs.js'; export const scan = options => capture(options);",
      { imports: ['tools/validation/inputs.js'] }),
    entry('tools/validation/inventory.js'), entry('tools/validation/inputs.js')];
  const result = plan(entries, [change(first)]);
  assert.equal(result.mode, 'affected');
  assert.deepEqual(result.affected, [first, inspector].sort());
  assert.ok(result.matches.some(match => match.test === inspector && match.kind === 'repository-inspection'));
  assert.ok(!result.matches.some(match => match.test === unrelated));
});

test('actual Node scanner CLI entries retain source closure and repository ownership without treating file paths as execution', async () => {
  const filename = 'tests/validation/inspection.test.js';
  const prefix = "import { execFile as launch } from 'node:child_process'; import { fileURLToPath } from 'node:url'; import path from 'node:path'; import { repositoryRoot } from '../../tools/validation/paths.js';\n";
  const cases = [
    ["launch(process.execPath, ['tools/validation/run.js', '--profile', 'full']);", 'tools/validation/run.js'],
    ["const executable = process.execPath; const args = ['tools/ci/run.js']; launch(executable, args);", 'tools/ci/run.js'],
    ["const script = fileURLToPath(new URL('../../tools/validation/run.js', import.meta.url)); launch(process.execPath, [script]);", 'tools/validation/run.js'],
    ["launch(process.execPath, [path.join(repositoryRoot, 'tools', 'ci', 'run.js')]);", 'tools/ci/run.js'],
    ["const repository = fileURLToPath(new URL('../../', import.meta.url)); launch(process.execPath, [path.join(repository, 'tools/ci/run.js')], { cwd: repository });", 'tools/ci/run.js'],
    ["import { realpath } from 'node:fs/promises'; const repository = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')); launch(process.execPath, [path.join(repository, 'tools/ci/run.js')], { cwd: repository });", 'tools/ci/run.js'],
    ["import * as child from 'node:child_process'; child.spawnSync(process.execPath, ['tools/validation/run.js']);", 'tools/validation/run.js'],
    ["launch(process.execPath, ['--', path.resolve('tools/validation/run.js')]);", 'tools/validation/run.js'],
  ];
  for (const [body, provider] of cases) {
    const analysis = analyzeJavaScriptDependencies(prefix + body, { sourcePath: filename });
    assert.deepEqual(analysis.executionSources, [provider], body);
    assert.deepEqual(analysis.repositoryInspections, [{ provider, entrypoint: 'main' }], body);
    const dependency = analysis.importSpecifiers.find(value => value.kind === 'execution-source');
    assert.ok(dependency, body);
    const resolved = await resolveLocalImport(path.join(repositoryRoot, filename), dependency,
      { knownEntries: caseFoldedEntryMap([provider]) });
    assert.deepEqual(resolved, { imported: provider }, body);
    const entries = [entry(first), entry(second),
      inspectedEntry(filename, prefix + body, { imports: [resolved.imported] }), entry(provider)];
    for (const changed of [first, second]) {
      const result = plan(entries, [change(changed)]);
      assert.equal(result.mode, 'affected');
      assert.deepEqual(result.affected, [changed, filename].sort(), body);
    }
  }
  for (const body of [
    "readFile('tools/validation/run.js');",
    "const source = fileURLToPath(new URL('../../tools/ci/run.js', import.meta.url)); readFile(source);",
    "launch(process.execPath, ['--check', 'tools/validation/run.js']);",
    "launch(process.execPath, ['-e', 'void 0', 'tools/validation/run.js']);",
    "launch(process.execPath, ['another-script.js', 'tools/validation/run.js']);",
    "launch(process.execPath, ['tools/validation/run.js'], { cwd: path.join(repositoryRoot, 'unrelated') });",
    "import { realpath } from 'node:fs/promises'; const repository = await realpath(selectedDirectory); launch(process.execPath, [path.join(repository, 'tools/ci/run.js')], { cwd: repository });",
    "launch('ffmpeg', ['tools/validation/run.js']);",
  ]) {
    const analysis = analyzeJavaScriptDependencies(prefix + body, { sourcePath: filename });
    assert.deepEqual(analysis.executionSources, [], body);
    assert.deepEqual(analysis.repositoryInspections, [], body);
    assert.ok(!analysis.importSpecifiers.some(value => value.kind === 'execution-source'), body);
  }
  const providerOnly = analyzeJavaScriptDependencies(prefix + "launch(process.execPath, ['tools/validation/inventory.js']);", { sourcePath: filename });
  assert.deepEqual(providerOnly.executionSources, ['tools/validation/inventory.js']);
  assert.deepEqual(providerOnly.repositoryInspections, [], 'Executing definitions alone does not call the exported inventory function.');
});

test('file-reference admission requires an AST read capability instead of reader words inside diagnostic source text', () => {
  const input = '.test-input/fixtures/actual-input.json';
  const references = body => analyzeJavaScriptDependencies(`const input = '${input}';\n${body}`,
    { sourcePath: 'tests/validation/inspection.test.js' }).referenceDeclarations;
  for (const body of [
    "const example = \"readFile('tools/validation/run.js')\";",
    "// readFile(input);\nconst example = `readFileSync(input)`;",
    "const example = \"new SqliteDatabase(input)\";",
    "import { readFile as read } from 'node:fs/promises'; const unused = true;",
  ]) assert.deepEqual(references(body), [{ logicalPath: input, dynamic: false, required: false }], body);
  for (const body of [
    'await readFile(input);', 'readFileSync(input);', 'fs.readFile(input);', "fs['openSync'](input);", 'new SqliteDatabase(input);',
    "import { readFile as read } from 'node:fs/promises'; await read(input);",
    "import { readFileSync as read } from 'node:fs'; read(input);",
    'const read = fs.readFile; await read(input);', 'const { readFile: read } = fs; await read(input);',
    'const read = readFile.bind(fs); await read(input);', 'readFile.call(fs, input);',
    'async function consume(read = readFile) { return read(input); } await consume();',
    'await Promise.resolve(input).then(readFile);',
  ]) assert.deepEqual(references(body), [{ logicalPath: input, dynamic: false, required: true }], body);
});

test('actual BookPhoto edits retain their Native consumers and real repository scanners without inheriting every oracle descriptor user', async () => {
  const dependencies = await inventory();
  const changed = ['tests/library/book-photo-global-runtime.test.js', 'tests/library/book-photo-global.test.js'];
  const result = selectAffected({ dependencies, tracked: new Set(dependencies.entries.map(value => value.path)),
    comparison: comparison(changed.map(filename => change(filename))) });
  assert.equal(result.mode, 'affected');
  assert.deepEqual(result.fallbackReasons, []);
  for (const filename of [...changed, 'tests/validation/fixture-urls.test.js', 'tests/validation/runner.test.js',
    'tests/validation/recorded-inputs.test.js', 'tests/validation/sealed-input-contracts.test.js',
    'tests/validation/input-identity.test.js', 'tests/validation/ci-scope.test.js']) {
    assert.ok(result.affected.includes(filename), filename);
  }
  for (const filename of ['tests/core/configuration-file.test.js', 'tests/http/display-preferences.test.js',
    'tests/metadata/photo-provider.test.js']) assert.ok(!result.affected.includes(filename), filename);
  const classification = { records: result.affected.map(filename => ({ path: filename, selected: !changed.includes(filename),
    reasons: changed.includes(filename) ? [{ code: 'service-not-provisioned', service: 'jellyfinDll' }] : [] })) };
  applyAffectedSelection(classification, result);
  assert.deepEqual(affectedUnavailable(classification, result).map(value => value.filename).sort(), [...changed].sort());
  assert.ok(changed.every(filename => result.affected.includes(filename)), 'Missing supply must not erase an actual changed consumer.');
  const broadcast = dependencies.entries.find(value => value.path === 'tools/ci/macos-broadcast.js');
  assert.ok(broadcast.executionSources.includes('tools/ci/run.js'), 'The actual owned macOS strict CLI retains its executed source.');
  const caller = 'tests/validation/inspection-cli.test.js';
  const source = "import { execFile } from 'node:child_process'; execFile(process.execPath, ['tools/ci/execute.js', scopeFile, output]);";
  const analysis = analyzeJavaScriptDependencies(source, { sourcePath: caller });
  const dependency = analysis.importSpecifiers.find(value => value.kind === 'execution-source');
  const resolved = await resolveLocalImport(path.join(repositoryRoot, caller), dependency,
    { knownEntries: caseFoldedEntryMap(dependencies.entries.map(value => value.path)) });
  assert.deepEqual(resolved, { imported: 'tools/ci/execute.js' });
  const cliDependencies = { entries: [...dependencies.entries,
    inspectedEntry(caller, source, { imports: [resolved.imported] })] };
  const withCli = selectAffected({ dependencies: cliDependencies, tracked: new Set(cliDependencies.entries.map(value => value.path)),
    comparison: comparison(changed.map(filename => change(filename))) });
  assert.equal(withCli.mode, 'affected');
  assert.ok(withCli.affected.includes(caller), 'A real execution source that invokes main retains repository inspection ownership.');
});

test('test sources used as explicit file or fixture-directory data retain every consumer', () => {
  const sample = 'tests/fixtures/shared/sample.test.js';
  const filename = path.join(repositoryRoot, sample);
  const fixtures = [{ filename: path.join(repositoryRoot, 'tests/fixtures/shared/manifest.json'), kind: 'file' }];
  const result = plan([entry(sample), entry(first, { importedFiles: [filename] }), entry(second, { fixtureReferences: fixtures }),
    entry(unrelated, { fixtureReferences: [{ filename: path.join(repositoryRoot, 'tests/fixtures/unrelated/manifest.json'), kind: 'file' }] })], [change(sample, 'A')]);
  assert.equal(result.mode, 'affected');
  assert.deepEqual(result.affected, [first, second, sample].sort());
  assert.ok(result.matches.some(match => match.test === first && match.kind === 'imported-file'));
  assert.ok(result.matches.some(match => match.test === second && match.kind === 'fixture-directory'));
});

test('resource edits require complete recursive ownership even when one static consumer is known', () => {
  for (const resource of ['tests/fixtures/recording.json', 'src/codec.wasm']) {
    const result = plan([entry(first, { importedFiles: [path.join(repositoryRoot, resource)] }), entry(unrelated)], [change(resource)]);
    assert.equal(result.mode, 'allavailable');
    assert.deepEqual(codes(result), ['recursive-input-ownership-not-proven']);
    assert.deepEqual(result.affected, []);
  }
});

test('production, oracle, infrastructure, deleted and renamed inputs cannot use a current-only graph', () => {
  const scenarios = [
    [change('src/runtime.js'), 'unsupported-impact-category'],
    [change('tests/fixtures/Native.cs'), 'unsupported-impact-category'],
    [change('.github/workflows/ci.yml'), 'global-validation-input'],
    [change('tools/ci/run.js'), 'global-validation-input'],
    [change('tools/validation/inputs.js'), 'global-validation-input'],
    [change('package-lock.json'), 'global-validation-input'],
    [change(first, 'D'), 'change-needs-base-graph'],
    [{ status: 'R100', path: second, previousPath: first }, 'change-needs-base-graph'],
  ];
  for (const [changed, expected] of scenarios) {
    const result = plan([entry(first), entry(second)], [changed]);
    assert.equal(result.mode, 'allavailable');
    assert.deepEqual(codes(result), [expected]);
  }
});

test('missing source or execution edges anywhere in the test graph force all available tests', () => {
  for (const overrides of [{ imports: ['tests/helpers/absent.js'] }, { unresolvedImports: [{ reason: 'dynamic-import' }] },
    { unresolvedExecutables: [{ reason: 'non-static-executable' }] }]) {
    const result = plan([entry(first), entry(unrelated, overrides)], [change(first)]);
    assert.equal(result.mode, 'allavailable');
    assert.ok(codes(result).some(code => ['unresolved-dependency-graph', 'unresolved-execution-inputs'].includes(code)));
  }
  const untracked = plan([entry(first)], [change(first)], { tracked: new Set() });
  assert.deepEqual(codes(untracked), ['changed-input-not-tracked']);
  const ownerless = plan([entry(unrelated, { imports: ['tools/validation/inventory.js'] }), entry('tools/validation/inventory.js')], [change(first)]);
  assert.deepEqual(codes(ownerless), ['changed-input-without-owner'], 'repository inspection alone does not prove the changed test was discovered');
  assert.deepEqual(codes(plan([entry(first)], [])), ['empty-comparison']);
});

test('documentation no-op requires the exact allowlist, a complete graph and no declared consumers', () => {
  const doc = 'README.md';
  const result = plan([entry(first)], [change(doc)]);
  assert.equal(result.mode, 'not-applicable');
  assert.deepEqual(result.documentationOnly, [doc]);
  assert.deepEqual(result.affected, []);
  const consumed = plan([entry(first, { declaredReferences: [{ required: true, dynamic: false,
    logicalPath: doc, filename: path.join(repositoryRoot, doc), kind: 'file' }] })], [change(doc)]);
  assert.equal(consumed.mode, 'affected');
  assert.deepEqual(consumed.affected, [first]);
  assert.equal(plan([entry(first)], [change('docs/another.md')]).mode, 'allavailable');
  assert.equal(plan([entry(first, { unresolvedImports: [{ reason: 'dynamic' }] })], [change(doc)]).mode, 'allavailable');
  const mixed = plan([entry(first)], [change(first), change(doc)]);
  assert.equal(mixed.mode, 'affected');
  assert.deepEqual(mixed.affected, [first]);
  assert.deepEqual(mixed.documentationOnly, [doc]);
});

test('affected tests remain required when availability checks reject them; no failure shrinks the requested impact', () => {
  const result = plan([entry(first), entry(second), entry(unrelated)], [change(first), change(second)]);
  const classification = { records: [
    { path: first, selected: true, reasons: [] },
    { path: second, selected: false, reasons: [{ code: 'service-not-provisioned', service: 'nativeInstance' }] },
    { path: unrelated, selected: true, reasons: [] },
  ] };
  applyAffectedSelection(classification, result);
  assert.deepEqual(classification.records.map(record => record.selected), [true, false, false]);
  assert.deepEqual(classification.records[2].reasons, [{ code: 'not-affected' }]);
  const before = structuredClone(result);
  assert.deepEqual(affectedUnavailable(classification, result), [{ code: 'affected-test-unavailable', filename: second,
    reasons: [{ code: 'service-not-provisioned', service: 'nativeInstance' }] }]);
  assert.deepEqual(result, before);
  classification.records[0].selected = false;
  classification.records[0].reasons.push({ code: 'input-unavailable' });
  assert.deepEqual(affectedUnavailable(classification, result).map(error => error.filename), [first, second]);
});

test('fallback and manual modes preserve existing availability selection, while proven documentation is an explicit no-op', () => {
  const initial = { records: [{ path: first, selected: true, reasons: [] }, { path: second, selected: false, reasons: [{ code: 'unavailable' }] }] };
  for (const mode of ['allavailable', 'exact']) {
    const classification = structuredClone(initial);
    const result = { mode, affected: [], matches: [] };
    applyAffectedSelection(classification, result);
    assert.deepEqual(classification, initial);
    assert.deepEqual(affectedUnavailable(classification, result), []);
  }
  const noOp = plan([entry(first), entry(second)], [change('README.md')]);
  const classification = structuredClone(initial);
  applyAffectedSelection(classification, noOp);
  assert.ok(classification.records.every(record => record.selected === false));
  assert.deepEqual(affectedUnavailable(classification, noOp), []);
});
