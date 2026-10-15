import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { describeFile } from '../validation/inventory.js';
import { assertValidationOutputChild, assertIsolatedOutput } from '../validation/paths.js';

const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function resolveDestination(filename) {
  const suffix = [];
  let current = path.resolve(filename);
  while (!existsSync(current)) {
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Reference destination has no existing ancestor.');
    current = parent;
  }
  return path.resolve(realpathSync(current), ...suffix);
}

export function assertFreshReferenceOutput(destination, sources = [], environment = process.env) {
  const output = resolveDestination(destination);
  for (const source of sources) {
    const resolved = realpathSync(source);
    if (contains(resolved, output) || contains(output, resolved)) throw new Error('Reference input and output directories must not overlap.');
  }
  assertValidationOutputChild(destination, environment);
  assertIsolatedOutput(destination, environment);
  if (existsSync(destination)) throw new Error('Reference output already exists.');
}

export async function captureReferenceInput(directory) {
  const identity = await describeFile(path.resolve(directory));
  if (!identity.available || identity.kind !== 'directory') throw new Error('Reference input must be a readable directory without links.');
  return identity;
}

export async function verifyReferenceInput(directory, before) {
  const after = await captureReferenceInput(directory);
  if (after.entriesSha256 !== before.entriesSha256) throw new Error('Reference input contents or file discovery changed.');
  return after;
}
