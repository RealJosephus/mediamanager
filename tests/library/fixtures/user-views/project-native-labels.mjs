import { validationFileUrl } from '../../../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve(process.argv[2]);
const provenance = JSON.parse(await readFile(validationFileUrl('../../../../src/library/resources/user-view-labels-provenance.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const keys = ['HeaderContinueWatching', 'Latest', 'Movies', 'Collections', 'Favorites', 'Genres',
  'HeaderNextUp', 'Shows', 'HeaderFavoriteShows', 'HeaderFavoriteEpisodes', 'TvShows', 'Folders'];
const labels = {};
for (const entry of provenance.sourceFiles) {
  const bytes = await readFile(path.join(source, entry.path));
  assert.equal(sha256(bytes), entry.sha256, entry.path);
  if (!entry.path.endsWith('.json')) continue;
  const raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  labels[path.basename(entry.path, '.json')] = Object.fromEntries(keys.filter(key => key in raw).map(key => [key, raw[key]]));
}
assert.equal(Object.keys(labels).length, 105);
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, source: '.agent-docs/baselines/jellyfin-current/source',
  sourceFiles: provenance.sourceFiles, license: provenance.license, keys, labels }, null, 2) + '\n');
await writeFile(validationFileUrl('./native-labels.json', import.meta.url), bytes, { flag: 'wx' });
console.log(JSON.stringify({ bytes: bytes.length, sha256: sha256(bytes), verifiedSources: provenance.sourceFiles.length }));
