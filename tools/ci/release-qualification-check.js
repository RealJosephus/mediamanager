import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { verifyReleaseQualification } from './release-qualification.js';

const { GITHUB_ACTIONS, GITHUB_SHA, GITHUB_REPOSITORY, GH_TOKEN } = process.env;
const [runId, output] = process.argv.slice(2);
if (GITHUB_ACTIONS !== 'true' || !GH_TOKEN || !output || !/^[1-9]\d*$/u.test(runId ?? '')) {
  throw new Error('A successful same-candidate qualification_run_id is required before full validation.');
}
const execute = promisify(execFile);
const request = async args => JSON.parse((await execute('gh', ['api', ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout);
const endpoint = `repos/${GITHUB_REPOSITORY}/actions/runs/${runId}`;
const run = await request([endpoint]);
const pages = await request(['--paginate', '--slurp', `${endpoint}/attempts/${run.run_attempt}/jobs?per_page=100`]);
const result = verifyReleaseQualification({ run, jobs: pages.flatMap(page => page.jobs),
  expectedHead: GITHUB_SHA, repository: GITHUB_REPOSITORY, runId });
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.qualified ? 0 : 2;
