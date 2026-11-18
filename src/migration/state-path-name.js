import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function assertExactStateEntry(filename, label) {
  const names = await readdir(path.dirname(filename));
  if (!names.includes(path.basename(filename))) {
    throw new Error(`${label} collides with an existing filesystem name: ${filename}`);
  }
}
