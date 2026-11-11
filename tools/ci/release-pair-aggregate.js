import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aggregateReleasePairs } from './release-pair.js';

if (process.argv.length !== 5 || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Use the Actions release-pair aggregation with artifacts, workflow provenance and a fresh output directory.');
const output = path.resolve(process.argv[4]);
await mkdir(output);
const { jobs, available } = await readFile(process.argv[3], 'utf8').then(JSON.parse).catch(() => ({}));
const result = await aggregateReleasePairs({ artifacts: path.resolve(process.argv[2]), jobs, available, expectedHead: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  validationResult: process.env.MEDIAMANAGER_CI_VALIDATION_RESULT });
await writeFile(path.join(output, 'strict-pair-receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ outcome: result.outcome, strictPairAcceptance: result.strictPairAcceptance,
  releaseAcceptance: false, platforms: result.platforms.length, errors: result.errors }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Strict full pair\n\nOutcome: **${result.outcome}**. Three-platform strict pair acceptance: **${result.strictPairAcceptance}**.\n\nRelease acceptance remains **false**. Product capability and production-scale acceptance require separate evidence.\n`);
}
process.exitCode = result.strictPairAcceptance ? 0 : 2;
