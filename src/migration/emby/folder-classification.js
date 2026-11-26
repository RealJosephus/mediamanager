import { createHash } from 'node:crypto';
import { DomainStore } from '../../database/domain-store.js';
import { quoteIdentifier } from '../../database/model.js';
import { nativeTextBytes } from '../../database/native-text.js';
import { EMPTY_ID, idKey } from '../../library/records.js';
import { musicArtistType, nonFolderNameTypes } from './format.js';

const emptyParents = ['', EMPTY_ID, idKey(EMPTY_ID)];
const versionKey = 'embyFolderClassificationVersion';

export function repairEmbySqliteFolders(db, sourceRows) {
  const placeholders = values => values.map(() => '?').join(',');
  const legacyFolders = db.prepare(`SELECT Id FROM BaseItems WHERE IsFolder=1 AND
    (Type IN (${placeholders(nonFolderNameTypes)}) OR
      (Type=? AND (ParentId IS NULL OR ParentId IN (${placeholders(emptyParents)}))))`);
  const repair = db.prepare('UPDATE BaseItems SET IsFolder=0 WHERE Id=?');
  for (const { Id } of legacyFolders.all(...nonFolderNameTypes, musicArtistType, ...emptyParents)) {
    if (sourceRows.has('item/' + Id)) repair.run(Id);
  }
}

export async function repairEmbyPostgresFolders(database, originIdentity) {
  if (typeof originIdentity !== 'string' || !originIdentity.startsWith('emby:') || await database.getState(versionKey) === '1') return;
  const originDigest = createHash('sha256').update(originIdentity).digest('hex');
  if ((await database.readInstanceBinding())?.originIdentityDigest !== originDigest) return;
  const store = new DomainStore(database);
  await store.transaction(async db => {
    if (await db.getState(versionKey) === '1') return;
    await db.client.query(`UPDATE ${quoteIdentifier(db.schemaName)}."BaseItems" SET "IsFolder"=false
      WHERE "IsFolder"=true AND ("Type"=ANY($1::bytea[]) OR
        ("Type"=$2 AND ("ParentId" IS NULL OR "ParentId"=ANY($3::bytea[]))))`,
    [nonFolderNameTypes.map(nativeTextBytes), nativeTextBytes(musicArtistType), emptyParents.map(nativeTextBytes)]);
    await db.setState(versionKey, '1');
  }, { isolation: 'read-committed' });
}
