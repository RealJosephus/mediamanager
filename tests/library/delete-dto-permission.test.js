import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canDeleteItem } from '../../src/library/delete-permission.js';
import { projectItem, dtoOptions } from '../../src/library/dto.js';
import { idKey } from '../../src/library/records.js';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';
import { entities, userFor, permissionOptions, stateFor } from '../http/item-deletion-state.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const currentOptions = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000 };
const current = () => recordCurrentOracleOnce({ owner: import.meta.url, label: 'delete-dto-permission',
  project: 'tests/library/fixtures/delete-dto-permission/CurrentOracle.csproj',
  input: 'tests/library/fixtures/delete-dto-permission/input.json' });

test('precomputed CanDelete records a current designated Native observation independently of the action fixture', currentOptions, async () => {
  const { inputBytes, input, native } = await current();
  assert.equal(native.permissionMatrix.length, input.permissionPolicies.length * input.claims.length);
  assert.deepEqual(native.permissionMatrix.map(matrix => `${matrix.policy}\0${matrix.claim}`),
    input.permissionPolicies.flatMap(policy => input.claims.map(claim => `${policy}\0${claim}`)));
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  const expectedIds = entities().map(item => idKey(item.Id)).sort();
  for (const matrix of native.permissionMatrix) assert.deepEqual(matrix.items.map(item => item.id).sort(), expectedIds);
});

test('current Native CanDelete overloads and actual DTO projection agree', currentOptions, async t => {
  const { native } = await current();
  for (const matrix of native.permissionMatrix) await t.test(`${matrix.policy}/${matrix.claim}`, async () => {
    const items = entities(), state = stateFor(items);
    const user = userFor({ policy: matrix.policy, claim: matrix.claim });
    // This permission-only recording has no stream/image relations. Supply
    // that explicit DTO control, including Audio's unconditional HasLyrics read.
    state.dtoRelations = Object.fromEntries(['streamRowsByItem', 'imageRowsByItem']
      .map(name => [name, new Map(items.map(item => [item.Id.replaceAll('-', '').toLowerCase(), []]))]));
    for (const expected of matrix.items) {
      const item = state.byId.get(expected.id), options = permissionOptions(item, state);
      assert.ok(item, expected.id);
      assert.equal(await canDeleteItem(item, null, options), expected.noUser, item.Name + ' no user');
      assert.equal(await canDeleteItem(item, user, options), expected.user, item.Name + ' action');
      assert.equal(await canDeleteItem(item, user, { ...options, precomputedFolders: true }), expected.precomputed, item.Name + ' DTO overload');
      const selected = dtoOptions({ fields: ['CanDelete'], enableuserdata: false, enableimages: false }, false);
      const dto = await projectItem(item, state, user, selected, { ...options, configuration: {} });
      assert.equal(dto.CanDelete, expected.precomputed, item.Name + ' DTO projection');
    }
  });
});
