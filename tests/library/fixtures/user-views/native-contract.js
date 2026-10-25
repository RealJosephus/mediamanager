import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function loadUserViewsNativeContract() {
  const manifestBytes = await readFile(new URL('./native-manifest.json', import.meta.url));
  assert.equal(sha256(manifestBytes), 'eb92bffdca10b4c77b83676a1776728dbb052ba6ec777d4d747522c36e6f24e5', 'Pinned native source/projection manifest');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.projection.file, 'native-contract.json.gz');
  const bytes = await readFile(new URL('./native-contract.json.gz', import.meta.url));
  assert.equal(bytes.length, manifest.projection.bytes);
  assert.equal(sha256(bytes), manifest.projection.sha256);
  const projection = JSON.parse(gunzipSync(bytes));
  assert.equal(projection.schemaVersion, 1);
  const states = projection.states.map(state => ({ database: Object.fromEntries(Object.entries(state.database)
    .map(([table, indexes]) => [table, indexes.map(index => projection.rows[table][index])])), filesystem: state.filesystem }));
  const native = Object.fromEntries(Object.entries(projection.stages).map(([key, entry]) => [key, entry.state === undefined ? entry.value : states[entry.state]]));
  const nativeCases = projection.caseStages.map(stage => ({ ...stage, before: states[stage.before], after: states[stage.after] }));
  const reconstructed = { 'stages.json': native, 'case-stages.json': nativeCases, 'native-http.json': projection.http,
    'server-configuration.json': projection.configuration, 'actors.json': projection.actors, 'summary.json': projection.summary };
  // Every reconstructed source value is bound to its complete native JSON.
  for (const [name, value] of Object.entries(reconstructed)) assert.equal(sha256(JSON.stringify(value)), manifest.sourceFiles[name].semanticSha256, name);
  return { manifest, native, nativeCases, http: projection.http.records, configuration: projection.configuration,
    actors: projection.actors, summary: projection.summary };
}
