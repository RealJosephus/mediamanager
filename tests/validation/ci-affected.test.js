import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { affectedUnavailable, applyAffectedSelection, changedFilesForEvent, parseGitChanges, selectAffected } from '../../tools/ci/affected.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

const first = 'tests/core/first.test.js', second = 'tests/core/second.test.js', unrelated = 'tests/core/unrelated.test.js';
const base = '1'.repeat(40), head = '2'.repeat(40), branch = '3'.repeat(40);
const entry = (filename, overrides = {}) => ({ path: filename, test: filename.endsWith('.test.js'), imports: [],
  importedFiles: [], fixtureReferences: [], declaredReferences: [], unresolvedImports: [], unresolvedExecutables: [], ...overrides });
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
    entry(inspector, { imports: ['tools/validation/inventory.js'] }), entry('tools/validation/inventory.js')];
  const result = plan(entries, [change(first)]);
  assert.equal(result.mode, 'affected');
  assert.deepEqual(result.affected, [first, second, inspector].sort());
  assert.ok(result.matches.some(match => match.test === second && match.consumer === first && match.kind === 'source-closure'));
  assert.ok(result.matches.some(match => match.test === inspector && match.kind === 'repository-inspection'));
  assert.ok(!result.affected.includes(unrelated));
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
  const doc = '.agent-docs/STATUS.md';
  const result = plan([entry(first)], [change(doc)]);
  assert.equal(result.mode, 'not-applicable');
  assert.deepEqual(result.documentationOnly, [doc]);
  assert.deepEqual(result.affected, []);
  const consumed = plan([entry(first, { declaredReferences: [{ required: true, dynamic: false,
    logicalPath: doc, filename: path.join(repositoryRoot, doc), kind: 'file' }] })], [change(doc)]);
  assert.equal(consumed.mode, 'affected');
  assert.deepEqual(consumed.affected, [first]);
  assert.equal(plan([entry(first)], [change('.agent-docs/another.md')]).mode, 'allavailable');
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
  const noOp = plan([entry(first), entry(second)], [change('.agent-docs/STATUS.md')]);
  const classification = structuredClone(initial);
  applyAffectedSelection(classification, noOp);
  assert.ok(classification.records.every(record => record.selected === false));
  assert.deepEqual(affectedUnavailable(classification, noOp), []);
});
