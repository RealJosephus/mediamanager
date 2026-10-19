import { randomUUID } from 'node:crypto';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { removeDiacritics } from '../sessions/user-data.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nonemptyId } from './records.js';

/** DistinctNames preserves the first spelling, punctuation and whitespace.
 * Lookup failures are individual failures; an empty successful-ID relation
 * retains MusicManager's unrestricted random-audio selection. */
export async function withMusicGenreSelector(database, library, nameLists, select) {
  const name = q('mm_mix_genres_' + randomUUID().replaceAll('-', ''));
  await database.client.query(`CREATE TEMP TABLE ${name} ("Key" bytea PRIMARY KEY, "Name" bytea, "GenreId" bytea)`);
  try {
    for await (const names of nameLists) for (let offset = 0; offset < names.length; offset += 128) {
      const first = new Map();
      for (const entry of names.slice(offset, offset + 128)) {
        const key = ordinalIgnoreCaseKey(removeDiacritics(entry));
        if (!first.has(key)) first.set(key, entry);
      }
      if (!first.size) continue;
      const inserted = await database.client.query({ text: `/* mix-distinct-name-page */
        INSERT INTO ${name} ("Key", "Name") SELECT * FROM unnest($1::bytea[], $2::bytea[])
        ON CONFLICT ("Key") DO NOTHING RETURNING "Key"`, values: [[...first.keys()].map(nativeTextBytes), [...first.values()].map(nativeTextBytes)] });
      const added = new Set(inserted.rows.map(row => decodeNativeTextBytes(row.Key))), keys = [], ids = [];
      for (const [key, value] of first) if (added.has(key)) {
        let genre = null;
        try { genre = await library.getMusicGenre(value); } catch { /* Native per-name fallback. */ }
        if (nonemptyId(genre?.Id)) { keys.push(key); ids.push(genre.Id); }
      }
      if (keys.length) await database.client.query({ text: `UPDATE ${name} selected SET "GenreId" = value."Id"
        FROM unnest($1::bytea[], $2::bytea[]) value("Key", "Id") WHERE selected."Key" = value."Key"`, values: [keys.map(nativeTextBytes), ids.map(nativeTextBytes)] });
    }
    return await select(Object.freeze({
      text: `SELECT "GenreId" AS "Id" FROM ${name} WHERE "GenreId" IS NOT NULL`,
      values: Object.freeze([]), emptyMatchesAll: true,
    }));
  } finally { await database.client.query(`DROP TABLE ${name}`); }
}
