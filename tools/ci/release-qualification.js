// Qualification only authorizes scheduling the expensive full matrix. It is
// never evidence of full-suite, product or release acceptance.
export function verifyReleaseQualification({ run, jobs, expectedHead, repository, runId }) {
  const errors = [];
  if (!/^[1-9]\d*$/u.test(String(runId)) || !/^[a-f0-9]{40}$/u.test(expectedHead ?? '')
    || String(run?.id) !== String(runId) || run?.head_sha !== expectedHead
    || run?.repository?.full_name !== repository || run?.path !== '.github/workflows/ci.yml'
    || run?.event !== 'workflow_dispatch' || run?.status !== 'completed' || run?.conclusion !== 'success') {
    errors.push('Qualification must be a successful manual validation run of this exact candidate and repository.');
  }
  const platforms = ['ubuntu-24.04', 'windows-2025', 'macos-15'];
  for (const os of platforms) {
    const matches = (jobs ?? []).filter(job => job.name === `${os} / shard 1 / Node 24 / PostgreSQL 17`);
    const job = matches[0];
    if (matches.length !== 1 || job?.status !== 'completed' || job.conclusion !== 'success'
      || String(job.run_id) !== String(runId) || job.head_sha !== expectedHead
      || job.run_attempt !== run?.run_attempt || !(job.runner_id > 0)) {
      errors.push(`${os}: qualification requires a successful validation job from the current attempt.`);
    }
  }
  if ((jobs ?? []).some(job => /\/ shard [2-9]\d* \//u.test(job.name ?? '') || job.conclusion === 'failure')) {
    errors.push('Use a focused three-platform qualification, not an automatic or full-pair matrix.');
  }
  return { schemaVersion: 1, qualified: errors.length === 0, headSha: expectedHead,
    runId: String(runId), attempt: run?.run_attempt ?? null, url: run?.html_url ?? null, errors };
}
