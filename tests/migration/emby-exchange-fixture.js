import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { embyCatalog, jellyfinCatalog } from '../../src/migration/emby/catalog.js';
import { changesBetween } from '../../src/migration/emby/reconcile.js';
import { writeJellyfin } from '../../src/migration/emby/write-jellyfin.js';
import { dateFields, scalarFields, stateFields } from '../../src/migration/emby/format.js';

export const exchangeId = id => '00000000-0000-4000-8000-' + String(id).padStart(12, '0');

export async function exchangeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-emby-catalog-'));
  const filename = path.join(directory, 'jellyfin.db');
  const emby = new DatabaseSync(':memory:');
  const jellyfin = new SqliteDatabase(filename, { create: true }).database;
  let closed = false;
  const closeJellyfin = () => { if (!closed) { closed = true; jellyfin.close(); } };
  t.after(async () => { emby.close(); closeJellyfin(); await rm(directory, { recursive: true, force: true }); });
  emby.exec(`ATTACH DATABASE ':memory:' AS accounts;
    CREATE TABLE accounts.LocalUsersv2(Id INTEGER PRIMARY KEY,guid BLOB,data TEXT);
    CREATE TABLE MediaItems(Id INTEGER PRIMARY KEY,guid BLOB,type INTEGER,ParentId INTEGER,SeriesId INTEGER,AlbumId INTEGER,
      Container TEXT,IndexNumberEnd INTEGER,UserDataKeyId INTEGER,ProviderIds TEXT,Images TEXT,LockedFields TEXT,
      ${[...scalarFields, ...dateFields].map(field => '"' + field + '"').join(',')});
    CREATE TABLE ItemLinks2(ItemId INTEGER,Type INTEGER,LinkedId INTEGER,LinkOrder INTEGER);
    CREATE TABLE ListItems(ListItemEntryId INTEGER PRIMARY KEY,ListId INTEGER,ListItemId INTEGER,ListItemOrder INTEGER);
    CREATE TABLE ItemExtradataTypes(ExtradataTypeId INTEGER,Name TEXT);
    CREATE TABLE ItemExtradata(ItemId INTEGER,ExtradataTypeId INTEGER,Value TEXT);
    CREATE TABLE ItemPeople2(ItemId INTEGER,PersonId INTEGER,PersonType INTEGER,Role TEXT,ListOrder INTEGER);
    CREATE TABLE MediaStreams2(ItemId INTEGER,StreamIndex INTEGER);
    CREATE TABLE Chapters3(ItemId INTEGER,ChapterIndex INTEGER,MarkerType INTEGER,StartPositionTicks INTEGER,
      Name TEXT,ImagePath TEXT,ImageDateModified INTEGER);
    CREATE TABLE UserDatas(UserDataKeyId INTEGER,userId INTEGER,LastPlayedDateInt INTEGER,
      HideFromResume INTEGER,RatingLastModified INTEGER,PlaystateLastModified INTEGER,
      ${stateFields.map(field => '"' + field + '"').join(',')});`);
  const issues = [], report = (...issue) => issues.push(issue);
  const readEmby = () => embyCatalog(emby, 'isolated-test', report);
  const readJellyfin = () => jellyfinCatalog(jellyfin, report);
  const applyToJellyfin = async (source, target, previousSource = new Map(), previousTarget = new Map(), options) => {
    const changes = changesBetween(source.rows, target.rows, previousSource, previousTarget, report, {
      sourceType: 'emby', sourceHasSearchHistory: source.hasDateLastSearched,
    });
    jellyfin.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    try {
      await writeJellyfin(jellyfin, changes, target, source, report, { previousSource, previousTarget, ...options });
      jellyfin.exec('COMMIT');
    } catch (error) {
      jellyfin.exec('ROLLBACK');
      throw error;
    }
  };
  return { filename, directory, emby, jellyfin, closeJellyfin, issues, report, readEmby, readJellyfin, applyToJellyfin };
}

export async function stoppedEmby({ directory, emby }) {
  const root = path.join(directory, 'emby'), data = path.join(root, 'data');
  await mkdir(data, { recursive: true });
  emby.prepare('VACUUM main INTO ?').run(path.join(data, 'library.db'));
  emby.prepare('VACUUM accounts INTO ?').run(path.join(data, 'users.db'));
  await writeFile(path.join(data, 'device.txt'), 'catalog-test');
  return root;
}

export function withCatalog(instance, type, operation) {
  const db = new DatabaseSync(path.join(instance, type === 'emby' ? 'data/library.db' : 'data/data/jellyfin.db'));
  try { return operation(db); } finally { db.close(); }
}
