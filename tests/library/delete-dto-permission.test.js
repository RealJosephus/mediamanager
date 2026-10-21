import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canDeleteItem } from '../../src/library/delete-permission.js';
import { projectItem, dtoOptions } from '../../src/library/dto.js';
import { entities, native as deletionNative, userFor, permissionOptions, stateFor } from '../http/item-deletion-fixture.js';

const root = new URL('./fixtures/delete-dto-permission/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
test('precomputed CanDelete recording is independently sealed without replacing the action fixture', async () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  for (const file of Object.values(provenance.files)) assert.equal(sha(await readFile(path.resolve(fileURLToPath(root), file.filename))), file.sha256, file.filename);
  const first = await readFile(provenance.files.rawRecording.filename), repeat = await readFile(provenance.repeat.filename);
  assert.deepEqual(first, repeat); assert.equal(sha(repeat), provenance.repeat.sha256); assert.deepEqual(JSON.parse(first), native);
  assert.equal(native.actualFrozenPrecomputedDeletePermission, true);
  assert.deepEqual(native.initialItems, deletionNative.initialItems);
  assert.equal(native.permissionMatrix.length, input.permissionPolicies.length * input.claims.length);
  assert.equal(native.inputSha256, provenance.files['input.json'].sha256);
  assert.equal(sha(await readFile(provenance.sourceControl.path)), provenance.sourceControl.sha256);
  for (const assembly of provenance.assemblies) assert.equal(sha(await readFile(provenance.jellyfin.assemblyDirectory + '/' + assembly.name + '.dll')), assembly.sha256);
  assert.equal(provenance.candidateVerified, false);
});
for (const matrix of native.permissionMatrix) test(`native CanDelete overloads and actual DTO: ${matrix.policy}/${matrix.claim}`, async () => {
  const items = entities(), state = stateFor(items), user = userFor({ policy: matrix.policy, claim: matrix.claim });
  // This permission-only recording has no stream/image relations. Supply
  // that explicit DTO control, including Audio's unconditional HasLyrics read.
  state.dtoRelations = Object.fromEntries(['streamRowsByItem', 'imageRowsByItem']
    .map(name => [name, new Map(items.map(item => [item.Id.replaceAll('-', '').toLowerCase(), []]))]));
  for (const expected of matrix.items) {
    const item = state.byId.get(expected.id), options = permissionOptions(item, state);
    assert.equal(await canDeleteItem(item, null, options), expected.noUser, item.Name + ' no user');
    assert.equal(await canDeleteItem(item, user, options), expected.user, item.Name + ' action');
    assert.equal(await canDeleteItem(item, user, { ...options, precomputedFolders: true }), expected.precomputed, item.Name + ' DTO overload');
    const selected = dtoOptions({ fields: ['CanDelete'], enableuserdata: false, enableimages: false }, false);
    const dto = await projectItem(item, state, user, selected, { ...options, configuration: {} });
    assert.equal(dto.CanDelete, expected.precomputed, item.Name + ' DTO projection');
  }
});
