import path from 'node:path';
import { MIMEType } from 'node:util';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeGuid } from '../users/native.js';
import { decodeNativeText, decodeNativeTextEncoding } from '../core/native-text.js';
import { identityPathStyle } from '../storage/uri.js';
import { libraryError, nonemptyId } from '../library/records.js';
import { StorageFileSystem } from '../storage/files.js';
import { parseLyrics } from './parser.js';
import { saveLyricBytes, deleteLyricFiles, queueLyricRefresh } from './mutations.js';
import { lyricFailure } from './failure.js';
import { searchRemoteLyrics, readRemoteLyrics, downloadRemoteLyrics } from './providers.js';

const pathColumn = tableDefinition('MediaStreamInfos').columns.find(column => column.name === 'Path');
const prefix = (bytes, values) => values.every((value, index) => bytes[index] === value);
const encodings = {
  unicode: 'utf-16le', 'utf-16': 'utf-16le', unicodefffe: 'utf-16be',
  'utf-32': 'utf-32le', utf8: 'utf-8',
};

function failures(primary, cleanup, label) {
  return lyricFailure([primary, cleanup], label);
}

// HttpContent chooses a declared charset before examining BOMs. Unlike
// StreamReader, its automatic detection does not recognize UTF-32BE.
export function decodeHttpLyrics(bytes, contentType) {
  let charset;
  if (contentType) { try { charset = new MIMEType(contentType).params.get('charset'); } catch { } }
  if (charset == null) {
    if (!prefix(bytes, [0, 0, 254, 255])) return decodeNativeText(bytes);
    charset = 'utf-8';
  }
  const name = encodings[charset.toLowerCase()] ?? charset.toLowerCase();
  const marker = { 'utf-8': [239, 187, 191], 'utf-16le': [255, 254], 'utf-16be': [254, 255],
    'utf-32le': [255, 254, 0, 0], 'utf-32be': [0, 0, 254, 255] }[name];
  if (marker && prefix(bytes, marker)) bytes = bytes.subarray(marker.length);
  // Prevent the shared StreamReader decoder from overriding this explicit
  // charset or swallowing a second BOM. One encoded NUL is removed afterwards.
  const unit = name.startsWith('utf-32') ? 4 : name.startsWith('utf-16') ? 2 : 1;
  return decodeNativeTextEncoding(Buffer.concat([Buffer.alloc(unit), bytes]), name).slice(1);
}

/** Reads stored lyric stream descriptors only. Discovery/refresh and remote
 * provider installation are independent owners; no probe or generator runs. */
export class LyricService {
  constructor({ store, library, vfs, identityMap, metadataIdentityMap = identityMap, fileSystem, monitor, directoryService, metadata, providers = () => [], logger = {} }) {
    Object.assign(this, { store, library, vfs, identityMap: metadataIdentityMap, monitor, directoryService, metadata, providers, logger });
    this.fileSystem = fileSystem ?? new StorageFileSystem({ vfs, identityMap: metadataIdentityMap });
  }

  async withAudio(itemId, { user = null } = {}, operation) {
    if (!nonemptyId(itemId)) throw libraryError(400, "Guid can't be empty. (Parameter 'id')");
    let entered = false;
    try { return await this.library.withItemRecord(itemId, { user }, async item => {
      entered = true; return ['Audio', 'AudioBook'].includes(item.Type) ? await operation(item) : null;
    }); } catch (error) { if (!entered && error?.status === 404) return null; throw error; }
  }

  save(item, format, bytes) { return saveLyricBytes(this, item, format, bytes); }
  delete(item) { return deleteLyricFiles(this, item); }
  queueRefresh(item) { return queueLyricRefresh(this, item); }
  search(item, options) { return searchRemoteLyrics(this, item, options); }
  readRemote(id, options) { return readRemoteLyrics(this, id, options); }
  download(item, id, options) { return downloadRemoteLyrics(this, item, id, options); }

  // WITH HOLD freezes the Native stream selection while file operations run
  // outside the read transaction. The later real metadata refresh can write.
  streamPaths(itemId, consume) {
    return this.store.run(() => this.store.runChild(async database => {
      await database.transaction(() => database.client.query(`DECLARE lyric_mutation_paths NO SCROLL CURSOR WITH HOLD FOR
        SELECT "Path" FROM ${q(database.schemaName)}."MediaStreamInfos"
        WHERE "ItemId"=$1::bytea AND "StreamType"=5 ORDER BY "StreamIndex"`, [nativeTextBytes(nativeGuid(itemId))]), { readOnly: true });
      let failed = false, primary;
      const service = this;
      async function* pages() {
        for (;;) {
          const rows = (await database.client.query('FETCH FORWARD 128 FROM lyric_mutation_paths')).rows;
          if (!rows.length) return;
          yield rows.map(row => { const value = decodeValue(pathColumn, row.Path, 'postgres'); return service.library.options.expandPath?.(value) ?? value; });
        }
      }
      try { return await consume(pages()); }
      catch (error) { failed = true; primary = error; throw error; }
      finally {
        try { await database.client.query('CLOSE lyric_mutation_paths'); }
        catch (error) { database.discardConnection(error); if (failed) throw failures(primary, error, 'Lyric mutation and cursor cleanup failed.'); throw error; }
      }
    }));
  }

  async read(itemId, { user = null, signal } = {}) {
    if (!nonemptyId(itemId)) throw libraryError(400, "Guid can't be empty. (Parameter 'id')");
    return await this.store.run(async database => {
      let selected;
      try { selected = await this.library.withItemRecord(itemId, { user }, async item =>
        ['Audio', 'AudioBook'].includes(item.Type) ? item.Id : null); }
      catch (error) { if (error?.status === 404) return null; throw error; }
      if (selected === null) return null;
      let cursorCleanup, cursorCleanupFailed = false;
      try { return await database.transaction(async () => {
        await database.client.query(`DECLARE lyric_stream_entries NO SCROLL CURSOR FOR
          SELECT "Path" FROM ${q(database.schemaName)}."MediaStreamInfos"
          WHERE "ItemId"=$1::bytea AND "StreamType"=5 ORDER BY "StreamIndex"`, [nativeTextBytes(nativeGuid(selected))]);
        let failed = false, primary;
        try {
          for (;;) {
            signal?.throwIfAborted();
            const rows = (await database.client.query('FETCH FORWARD 128 FROM lyric_stream_entries')).rows;
            if (!rows.length) return null;
            for (const row of rows) {
              signal?.throwIfAborted();
              const stored = decodeValue(pathColumn, row.Path, 'postgres'), identity = this.library.options.expandPath?.(stored) ?? stored;
              if (identity === '') throw libraryError(400, "The value cannot be an empty string. (Parameter 'path')");
              const access = this.identityMap.resolve({ identityPath: identity, style: identityPathStyle(identity) });
              let handle, readFailed = false, readFailure;
              try {
                handle = await this.vfs.openRead(access, { signal });
                const chunks = [];
                for await (const chunk of handle.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
                // The designated Native manager sends File paths through its
                // local HTTP proxy too. A Local handle without Content-Type
                // therefore uses HttpContent's no-charset policy as well.
                const bytes = Buffer.concat(chunks), content = decodeHttpLyrics(bytes, handle.contentType);
                const parsed = parseLyrics(path.basename(identity), content);
                if (parsed !== null) return parsed;
              } catch (error) { readFailed = true; readFailure = error; throw error; }
              finally {
                try { await handle?.close(); }
                catch (error) { if (readFailed) throw failures(readFailure, error, 'Lyric read and storage cleanup failed.'); throw error; }
              }
            }
          }
        } catch (error) { failed = true; primary = error; throw error; }
        finally {
          try { await database.client.query('CLOSE lyric_stream_entries'); }
          catch (error) {
            cursorCleanupFailed = true; cursorCleanup = error;
            if (failed) throw failures(primary, error, 'Lyric read and cursor cleanup failed.');
            throw error;
          }
        }
      }, { readOnly: true, signal }); }
      finally { if (cursorCleanupFailed) database.discardConnection(cursorCleanup); }
    }, { signal });
  }
}
