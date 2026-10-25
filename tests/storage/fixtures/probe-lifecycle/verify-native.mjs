import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validationExecutable } from '../../../../tools/validation/paths.js';
const root = fileURLToPath(new URL('.', import.meta.url));
const evidence = path.resolve(process.argv[2]);
const results = [];
for (const mode of ['sqlite', 'postgres', 'alist']) {
  const directory = path.join(evidence, mode);
  const run = spawnSync(validationExecutable('dotnet'), [path.join(root, 'bin/Debug/net10.0/Oracle.dll'), 'read-db', path.join(directory, 'with-lyrics.db'), path.join(directory, 'native.json')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const actual = JSON.parse(await readFile(path.join(directory, 'native.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'));
  assert.deepEqual(actual, expected, mode);
  results.push({ mode, equal: true, streams: actual.streams.length, lyrics: actual.item.LyricFiles.length, reader: 'Actual Microsoft.Data.Sqlite read-only; BaseItemMapper.DeserializeBaseItem; MediaStreamRepository.Map' });
}
await writeFile(path.join(evidence, 'native-read-validation.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
