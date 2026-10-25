import { writeFile } from 'node:fs/promises';
import { taggedWave } from './tagged-wave.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node record.mjs <output-wave>');
await writeFile(process.argv[2], taggedWave());
