import { readFile } from 'node:fs/promises';
import { main } from '../validation/run.js';

const scope = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (scope.schemaVersion !== 1 || scope.profile !== 'ci-available' || !scope.selected.length) throw new Error('Invalid CI scope.');
process.exitCode = await main(['--output', process.argv[3], '--concurrency', '1', '--', ...scope.selected]);
