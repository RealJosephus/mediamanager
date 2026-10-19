import { readFile } from 'node:fs/promises';
import { main } from '../validation/run.js';
import { ciExecutionArguments } from './scope.js';

const scope = JSON.parse(await readFile(process.argv[2], 'utf8'));
process.exitCode = await main(ciExecutionArguments(scope, process.argv[3]));
