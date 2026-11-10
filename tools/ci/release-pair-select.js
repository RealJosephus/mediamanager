import { execFile } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { selectReleasePairArtifacts } from './release-pair.js';
import { fullShardCount } from '../validation/full-partitions.js';

const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA, GITHUB_OUTPUT, GH_TOKEN } = process.env;
if (process.argv.length !== 3 || GITHUB_ACTIONS !== 'true' || !GITHUB_OUTPUT || !GH_TOKEN) {
  throw new Error('Use the Actions release-pair selector with a fresh provenance file.');
}

const execute = promisify(execFile);
const run = `repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
async function rows(endpoint, field) {
  const { stdout } = await execute('gh', ['api', '--paginate', '--slurp', `${run}/${endpoint}?per_page=100`],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const pages = JSON.parse(stdout);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page?.[field]))) {
    throw new Error(`GitHub did not return the ${field} provenance.`);
  }
  return pages.flatMap(page => page[field]);
}

let jobs, available, selected;
// The dependency can finish before both GitHub indexes expose its uploads.
for (let read = 0; read < 5; read++) {
  if (read > 0) await delay(2000);
  [jobs, available] = await Promise.all([rows(`attempts/${GITHUB_RUN_ATTEMPT}/jobs`, 'jobs'), rows('artifacts', 'artifacts')]);
  ({ selected } = selectReleasePairArtifacts({ jobs, available, expectedHead: GITHUB_SHA, runId: GITHUB_RUN_ID, attempt: GITHUB_RUN_ATTEMPT }));
  if (selected.length === 3 * fullShardCount) break;
}
await writeFile(process.argv[2], JSON.stringify({ jobs, available }) + '\n', { flag: 'wx' });
await appendFile(GITHUB_OUTPUT, `ids=${selected.map(entry => entry.id).join(',')}\nonly_name=${selected.length === 1 ? selected[0].name : ''}\n`);
