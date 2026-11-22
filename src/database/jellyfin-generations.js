import { nativeModel } from './model.js';

export const previousFingerprint = '24690f1f413cc531c8ed385851cd0e3f392af7ec470860ee3d0348d285133725';
export const currentFingerprint = '340c9c2d9c27db18798f63420abc7158bec8a9e238760074a84e4f66c67135d0';

const retired = ['20260206200000_FixLibrarySubtitleDownloadLanguages', '20260910120000_MigrateRatingLevels'];
const added = new Set([
  '20260912120000_HarmonizeConflictingUserData', '20260915104305_FixNullEncoderPreset',
  '20260927120000_FixLibrarySubtitleDownloadLanguages', '20260928120000_MigrateRatingLevels',
  '20261002210711_MakeOwnerIdIndexesPartial', '20261024092111_CoverAncestorIdsParentIndex',
]);
const current = [...nativeModel.migrations, ...nativeModel.dataMigrations].sort();
const previous = [...current.filter(id => !added.has(id)), ...retired].sort();
const upgraded = [...current, ...retired].sort();

export function acceptsJellyfinHistory(fingerprint, ids, complete) {
  const histories = fingerprint === currentFingerprint ? [current, upgraded]
    : fingerprint === previousFingerprint ? [previous] : [];
  return histories.some(history => complete
    ? ids.length === history.length && ids.every((id, i) => id === history[i])
    : ids.every(id => history.includes(id)));
}

// Both sources have identical business columns, primary keys and foreign keys.
export function jellyfinIndexes(table, fingerprint) {
  if (fingerprint === currentFingerprint) return table.indices;
  if (fingerprint !== previousFingerprint) throw new Error('Unknown Jellyfin schema fingerprint');
  if (table.name === 'AncestorIds') return [{ name: 'IX_AncestorIds_ParentItemId', columns: ['ParentItemId'], unique: false, filter: null }];
  if (table.name === 'BaseItems') return table.indices.map(index =>
    ['IX_BaseItems_OwnerId', 'IX_BaseItems_ExtraType_OwnerId'].includes(index.name) ? { ...index, filter: null } : index);
  return table.indices;
}
