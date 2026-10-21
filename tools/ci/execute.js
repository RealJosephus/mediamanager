import { readFile } from 'node:fs/promises';
import { main } from '../validation/run.js';
import { ciExecutionArguments } from './scope.js';

const scope = JSON.parse(await readFile(process.argv[2], 'utf8'));
const extra = process.argv.slice(4);
if (extra.length && (extra.length !== 1 || extra[0] !== '--preflight-only' || scope.releasePair !== true)) {
  throw new Error('Only release-pair input freezing may request a CI preflight.');
}
process.exitCode = await main([...ciExecutionArguments(scope, process.argv[3]), ...extra]);
