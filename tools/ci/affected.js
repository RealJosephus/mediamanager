import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dependencyClosure } from '../validation/inventory.js';
import { repositoryRoot, validationPath } from '../validation/paths.js';

// Policy names are not readFile inputs; keep them separate from input-path declarations.
const documentation = new Set(['README.md', 'ARCHITECTURE.md', 'STATUS.md', 'VALIDATION.md']
  .map(name => ['.agent-docs', name].join('/')));
const repositoryInspectors = new Set(['tools/validation/inventory.js', 'tools/validation/inputs.js']);
const inventoryPath = filename => /^(?:src|tests|tools|plugins|packages)\//u.test(filename);
const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value) && !/^0+$/u.test(value);
const gitPath = value => typeof value === 'string' && value.length > 0 && !/[\\\0\uFFFD]/u.test(value)
  && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
const globalInput = filename => filename.startsWith('.github/') || filename.startsWith('tools/ci/')
  || filename.startsWith('tools/validation/') || filename.startsWith('scripts/') || filename === 'tools/check.js'
  || /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|Directory\.Build\.(?:props|targets)|global\.json|\.npmrc)$/u.test(filename)
  || ['.gitattributes', '.gitignore', '.gitmodules'].includes(filename);

function git(args) {
  return spawnSync('git', args, { cwd: repositoryRoot, windowsHide: true, encoding: 'utf8',
    timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
}

export function parseGitChanges(output) {
  if (typeof output !== 'string' || output && !output.endsWith('\0')) throw new Error('Git diff must be NUL terminated.');
  const parts = output.split('\0'); parts.pop();
  const changes = [], seen = new Set();
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!/^(?:[AMDT]|[RC][0-9]+)$/u.test(status)) throw new Error('Unsupported Git change status.');
    const previousPath = /^[RC]/u.test(status) ? parts[index++] : undefined;
    const filename = parts[index++];
    if (!gitPath(filename) || previousPath !== undefined && !gitPath(previousPath) || seen.has(filename)) {
      throw new Error('Invalid or duplicate Git change path.');
    }
    seen.add(filename);
    changes.push({ status, path: filename, ...(previousPath !== undefined && { previousPath }) });
  }
  return changes;
}

/** Compare the candidate actually checked out by Actions; never guess a base. */
export async function changedFilesForEvent(environment, { runGit = git, readEvent = readFile } = {}) {
  const result = { event: environment.GITHUB_EVENT_NAME ?? null, baseSha: null, headSha: null,
    changes: [], fallbackReasons: [] };
  const fallback = (code, detail) => { result.fallbackReasons.push({ code, ...(detail && { detail }) }); return result; };
  if (!['push', 'pull_request'].includes(result.event)) return fallback('unsupported-automatic-event');
  let event;
  try { event = JSON.parse(await readEvent(environment.GITHUB_EVENT_PATH, 'utf8')); }
  catch (error) { return fallback('event-unavailable', error.message); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return fallback('invalid-event-payload');
  const head = runGit(['rev-parse', '--verify', 'HEAD']);
  result.headSha = head.status === 0 ? head.stdout.trim() : null;
  if (!commitId(result.headSha) || result.headSha !== environment.GITHUB_SHA) return fallback('candidate-sha-mismatch');
  if (result.event === 'push') {
    result.baseSha = event.before;
    if (event.forced) return fallback('force-push');
    if (event.after !== result.headSha) return fallback('push-head-mismatch');
  } else {
    result.baseSha = event.pull_request?.base?.sha;
    const first = runGit(['rev-parse', '--verify', 'HEAD^1']), second = runGit(['rev-parse', '--verify', 'HEAD^2']);
    if (first.status !== 0 || second.status !== 0 || first.stdout.trim() !== result.baseSha
      || second.stdout.trim() !== event.pull_request?.head?.sha) return fallback('pull-request-merge-parents-mismatch');
  }
  if (!commitId(result.baseSha)) return fallback('missing-base-sha');
  if (runGit(['cat-file', '-e', result.baseSha + '^{commit}']).status !== 0) return fallback('base-commit-unavailable');
  if (runGit(['merge-base', '--is-ancestor', result.baseSha, result.headSha]).status !== 0) return fallback('base-not-ancestor');
  if (runGit(['diff', '--quiet', 'HEAD', '--']).status !== 0) return fallback('dirty-candidate');
  const diff = runGit(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z',
    result.baseSha, result.headSha, '--']);
  if (diff.status !== 0) return fallback('git-diff-unavailable');
  try { result.changes = parseGitChanges(diff.stdout); }
  catch (error) { return fallback('invalid-git-diff', error.message); }
  if (!result.changes.length) return fallback('empty-comparison');
  return result;
}

function relativeInput(filename) {
  if (typeof filename !== 'string') return null;
  const absolute = path.resolve(repositoryRoot, filename);
  const relative = path.relative(repositoryRoot, absolute).replaceAll('\\', '/');
  return gitPath(relative) ? relative : null;
}

/** Version one narrows only test-source edits and reviewed documentation.
 * Resource edits need the complete recursive manifest ownership graph first.
 * Production source, oracle projects and unbound data require all available tests.
 * Runtime media/temp-file I/O is not treated as a repository dependency. */
export function selectAffected({ dependencies, tracked, comparison, environment = {} }) {
  const plan = { schemaVersion: 1, mode: 'allavailable', ...comparison,
    fallbackReasons: [...(comparison.fallbackReasons ?? [])], affected: [], matches: [], documentationOnly: [] };
  const fallback = reason => plan.fallbackReasons.push(reason);
  if (plan.fallbackReasons.length) return plan;
  if (!comparison.changes.length) { fallback({ code: 'empty-comparison' }); return plan; }
  for (const change of comparison.changes) {
    if (!['A', 'M'].includes(change.status)) fallback({ code: 'change-needs-base-graph', ...change });
    else if (!tracked.has(change.path)) fallback({ code: 'changed-input-not-tracked', path: change.path });
    else if (globalInput(change.path)) fallback({ code: 'global-validation-input', path: change.path });
    else if (/\.(?:json|wasm)$/u.test(change.path)) fallback({ code: 'recursive-input-ownership-not-proven', path: change.path });
    else if (!change.path.endsWith('.test.js') && !documentation.has(change.path)) {
      fallback({ code: 'unsupported-impact-category', path: change.path });
    }
  }
  if (plan.fallbackReasons.length) return plan;
  const owners = new Map(), directories = [], inspectors = new Set();
  const own = (filename, test, consumer, kind) => {
    if (!filename) return;
    if (!owners.has(filename)) owners.set(filename, []);
    owners.get(filename).push({ test, consumer, kind });
  };
  const ownDirectory = (filename, test, consumer, kind) => {
    const relative = relativeInput(filename);
    if (relative) directories.push({ path: relative, test, consumer, kind });
  };
  for (const test of dependencies.entries.filter(entry => entry.test)) {
    let closure;
    try { closure = dependencyClosure(dependencies, [test.path]); }
    catch (error) { fallback({ code: 'unresolved-dependency-graph', consumer: test.path, detail: error.message }); continue; }
    for (const entry of closure) {
      if (entry.unresolvedExecutables?.length) fallback({ code: 'unresolved-execution-inputs', consumer: entry.path });
      own(entry.path, test.path, entry.path, 'source-closure');
      if (repositoryInspectors.has(entry.path)) inspectors.add(test.path);
      for (const filename of entry.importedFiles ?? []) own(relativeInput(filename), test.path, entry.path, 'imported-file');
      for (const fixture of entry.fixtureReferences ?? []) {
        own(relativeInput(fixture.filename), test.path, entry.path, 'fixture-file');
        ownDirectory(path.dirname(fixture.filename), test.path, entry.path, 'fixture-directory');
      }
      for (const reference of (entry.declaredReferences ?? []).filter(value => value.required)) {
        if (reference.dynamic) {
          const prefix = reference.logicalPath.split(/\$\{|[?*]/u)[0];
          if (!prefix || prefix === '.') { fallback({ code: 'unbounded-declared-input', consumer: entry.path }); continue; }
          ownDirectory(validationPath(prefix.endsWith('/') ? prefix : path.dirname(prefix), repositoryRoot, environment),
            test.path, entry.path, 'declared-input-directory');
        } else {
          own(relativeInput(reference.filename), test.path, entry.path, 'declared-input');
          if (reference.kind === 'directory') ownDirectory(reference.filename, test.path, entry.path, 'declared-input-directory');
          else if (reference.kind === 'file') ownDirectory(path.dirname(reference.filename), test.path, entry.path, 'declared-input-directory');
        }
      }
    }
  }
  if (plan.fallbackReasons.length) return plan;
  const affected = new Set();
  for (const change of comparison.changes) {
    const matches = [...(owners.get(change.path) ?? []), ...directories.filter(directory => change.path.startsWith(directory.path + '/'))];
    // The inventory and input-capture modules inspect tracked repository inputs,
    // including test sources read as data by validation regression tests.
    if (inventoryPath(change.path)) for (const test of inspectors) matches.push({ test, consumer: 'repository-inventory', kind: 'repository-inspection' });
    const specific = matches.filter(match => match.kind !== 'repository-inspection');
    if (!specific.length) {
      if (documentation.has(change.path)) { plan.documentationOnly.push(change.path); continue; }
      fallback({ code: 'changed-input-without-owner', path: change.path }); continue;
    }
    for (const match of matches) {
      affected.add(match.test);
      plan.matches.push({ test: match.test, changedPath: change.path, consumer: match.consumer, kind: match.kind });
    }
  }
  if (plan.fallbackReasons.length) return plan;
  plan.affected = [...affected].sort();
  plan.matches = [...new Map(plan.matches.map(match => [JSON.stringify(match), match])).values()];
  plan.mode = plan.affected.length ? 'affected' : plan.documentationOnly.length === comparison.changes.length ? 'not-applicable' : 'allavailable';
  if (plan.mode === 'allavailable') fallback({ code: 'unproven-empty-selection' });
  return plan;
}

export function applyAffectedSelection(classification, plan) {
  if (!['affected', 'not-applicable'].includes(plan.mode)) return;
  const affected = new Set(plan.affected);
  for (const record of classification.records) {
    record.impact = plan.matches.filter(match => match.test === record.path);
    if (!affected.has(record.path)) { record.selected = false; record.reasons.push({ code: 'not-affected' }); }
  }
}

export function affectedUnavailable(classification, plan) {
  if (plan.mode !== 'affected') return [];
  return plan.affected.flatMap(filename => {
    const record = classification.records.find(record => record.path === filename);
    return record?.selected ? [] : [{ code: 'affected-test-unavailable', filename, reasons: record?.reasons ?? [{ code: 'test-not-discovered' }] }];
  });
}
