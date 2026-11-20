import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyDesignatedJellyfinSourcePackage } from '../validation/designated-jellyfin-source.js';

if (process.argv.length !== 3) throw new Error('Usage: node tools/ci/stage-native-source-offer.js NEW_OUTPUT');
const output = process.argv[2];
const { sourceOfferAttachments } = await verifyDesignatedJellyfinSourcePackage();
await mkdir(output);
for (const { descriptor, bytes } of sourceOfferAttachments) {
  await writeFile(path.join(output, descriptor.path), bytes, { flag: 'wx' });
}
