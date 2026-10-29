import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function readTestSelection(filename, expectedSha256) {
  if (typeof filename !== 'string' || !filename || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) {
    throw new Error('The test selection file and SHA-256 are required.');
  }
  const bytes = await readFile(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error('The test selection file changed before execution.');
  }
  const selection = JSON.parse(bytes.toString('utf8'));
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Object.keys(selection).length !== 2 || !Object.hasOwn(selection, 'files') || !Object.hasOwn(selection, 'concurrency')
    || !Array.isArray(selection.files) || selection.files.length === 0
    || selection.files.some(file => typeof file !== 'string' || !file)
    || new Set(selection.files).size !== selection.files.length
    || !Number.isSafeInteger(selection.concurrency) || selection.concurrency < 1) {
    throw new Error('The test selection must contain its complete file list and positive concurrency.');
  }
  return selection;
}
