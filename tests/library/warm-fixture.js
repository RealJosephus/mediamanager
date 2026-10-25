import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export async function currentWarmFixture(root, label) {
  const inputFile = fileURLToPath(new URL('input.json', root));
  const inputBytes = await readFile(inputFile);
  const input = parseLosslessJson(inputBytes.toString('utf8'));
  let recording;
  async function record() {
    const output = path.resolve(validationOutputRoot());
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(path.join(output, `${label}-current-`));
    const consumedInput = path.join(directory, 'input.json');
    await writeFile(consumedInput, inputBytes, { flag: 'wx' });
    const nativeRoot = path.join(directory, 'native');
    await recordOracle({ project: fileURLToPath(new URL('current/Oracle.csproj', root)), output: nativeRoot,
      args: [consumedInput, '{output}/native.json', '{output}/state'] });
    const nativeBytes = await readFile(path.join(nativeRoot, 'native.json'));
    const native = parseLosslessJson(nativeBytes.toString('utf8'));
    assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
    return native;
  }
  return { input, current: () => recording ??= record() };
}
