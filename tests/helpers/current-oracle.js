import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { repositoryRoot, validationOutputRoot } from '../../tools/validation/paths.js';

const recordings = new Map();

async function record({ label, project, input, environment }) {
  const root = path.join(validationOutputRoot(environment), `${label}-${randomUUID()}`);
  const nativeRoot = path.join(root, 'native');
  const inputFilename = path.resolve(repositoryRoot, input);
  await mkdir(root, { recursive: true });
  await recordOracle({ project, output: nativeRoot, args: [inputFilename, '{output}/native.json'], environment });
  const [inputBytes, nativeBytes] = await Promise.all([
    readFile(inputFilename), readFile(path.join(nativeRoot, 'native.json')),
  ]);
  return { inputBytes, input: JSON.parse(inputBytes), native: JSON.parse(nativeBytes) };
}

export function recordCurrentOracleOnce({ owner, label, project, input, environment = process.env }) {
  if (typeof owner !== 'string' || !owner || !/^[a-z0-9-]+$/u.test(label)) {
    throw new TypeError('A current Oracle recording requires an owner and a lowercase label.');
  }
  const key = `${owner}\0${label}`;
  if (!recordings.has(key)) recordings.set(key, record({ label, project, input, environment }));
  return recordings.get(key);
}
