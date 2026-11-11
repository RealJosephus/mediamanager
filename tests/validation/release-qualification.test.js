import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReleaseQualification } from '../../tools/ci/release-qualification.js';

const fixture = () => {
  const expectedHead = 'a'.repeat(40), runId = '44', repository = 'controlled/project';
  return { expectedHead, runId, repository,
    run: { id: 44, head_sha: expectedHead, repository: { full_name: repository }, path: '.github/workflows/ci.yml',
      event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1 },
    jobs: ['ubuntu-24.04', 'windows-2025', 'macos-15'].map(os => ({ name: `${os} / shard 1 / Node 24 / PostgreSQL 17`,
      run_id: 44, head_sha: expectedHead, run_attempt: 1, runner_id: 10, status: 'completed', conclusion: 'success' })) };
};

test('full scheduling requires successful three-platform qualification on the same candidate', () => {
  assert.equal(verifyReleaseQualification(fixture()).qualified, true);
  const changes = [
    options => { options.run.head_sha = 'b'.repeat(40); },
    options => { options.run.repository.full_name = 'other/project'; },
    options => { options.run.path = '.github/workflows/release-package.yml'; },
    options => { options.run.event = 'push'; },
    options => { options.run.status = 'in_progress'; },
    options => { options.run.conclusion = 'failure'; },
    options => { options.jobs.pop(); },
    options => { options.jobs.push(options.jobs[0]); },
    options => { options.jobs[0].conclusion = 'skipped'; },
    options => { options.jobs[0].runner_id = 0; },
    options => { options.jobs[0].run_attempt = 2; },
    options => { options.jobs[0].head_sha = 'b'.repeat(40); },
    options => { options.jobs.push({ ...options.jobs[0], name: 'ubuntu-24.04 / shard 2 / Node 24 / PostgreSQL 17' }); },
  ];
  for (const change of changes) {
    const options = fixture(); change(options);
    assert.equal(verifyReleaseQualification(options).qualified, false);
  }
});
