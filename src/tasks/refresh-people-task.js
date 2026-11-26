import { md5Guid } from '../core/identity.js';
import { quoteIdentifier as q } from '../database/model.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { nativePersonIdentity } from '../library/identity.js';
import { dateTicks, idKey } from '../library/records.js';
import { nativeDate } from '../users/native.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

const personType = nativeTextBytes('MediaBrowser.Controller.Entities.Person');

async function reconcileCredits(store, signal) {
  return store.transaction(async db => {
    const people = q(db.schemaName) + '."Peoples"', credits = q(db.schemaName) + '."PeopleBaseItemMap"';
    const ranked = `SELECT "Id", first_value("Id") OVER (PARTITION BY "Name", "PersonType" ORDER BY "Id") AS keeper FROM ${people}`;
    // Preserve every distinct role, including when both people already share a credit.
    await db.client.query({ text: `INSERT INTO ${credits} ("ItemId", "PeopleId", "Role", "ListOrder", "SortOrder")
      SELECT c."ItemId", p.keeper, c."Role", c."ListOrder", c."SortOrder" FROM ${credits} c
      JOIN (${ranked}) p ON p."Id" = c."PeopleId" WHERE p."Id" <> p.keeper
      ORDER BY p."Id" ON CONFLICT ("ItemId", "PeopleId", "Role") DO NOTHING`, signal });
    await db.client.query({ text: `DELETE FROM ${people} WHERE "Id" IN (SELECT "Id" FROM (${ranked}) p WHERE "Id" <> keeper)`, signal });
    await db.client.query({ text: `DELETE FROM ${people} p WHERE NOT EXISTS (SELECT 1 FROM ${credits} c WHERE c."PeopleId" = p."Id")`, signal });
    return (await db.client.query({ text: `SELECT DISTINCT "Name" FROM ${people} ORDER BY "Name"`, signal })).rows;
  }, { signal });
}

async function refreshPeople({ store, library, lifecycle, metadataScanner, logger, clock }, { signal, reportProgress }) {
  if (lifecycle.isScanRunning) return;
  const names = await reconcileCredits(store, signal);
  reportProgress(33);
  const initial = await store.run(async db => (await db.client.query({ text: `SELECT "Id" FROM ${q(db.schemaName)}."BaseItems"
    WHERE "Type" = $1`, values: [personType], signal })).rows, { signal });
  const live = new Set();
  const attempt = async (label, action) => {
    signal.throwIfAborted();
    try { await action(); }
    catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw error;
      logger?.error?.(error, 'Error refreshing person ' + label);
    }
  };
  for (const [index, row] of names.entries()) {
    const name = decodeNativeTextBytes(row.Name);
    live.add(idKey(nativePersonIdentity(name, library.options).Id));
    await attempt(name, async () => {
      const item = await library.getOrCreatePerson(name);
      if (!dateTicks(item.DateLastRefreshed)) await metadataScanner.refreshLiveItem(item, { signal, IsAutomated: false });
    });
    reportProgress(33 + 33 * (index + 1) / names.length);
  }
  const dead = initial.filter(row => !live.has(idKey(decodeNativeTextBytes(row.Id)))).map(row => row.Id);
  signal.throwIfAborted();
  if (dead.length) await store.run(db => library.deleteQueryItemsUnsafeFast({ includeitemtypes: ['Person'], islocked: false }, {
    deleteSourceFiles: true, itemIdsPlan: { text: `SELECT "Id" FROM ${q(db.schemaName)}."BaseItems" WHERE "Id" = ANY($1::bytea[])`, values: [dead] },
  }), { signal });
  reportProgress(66);
  const cutoff = nativeDate(new Date(clock().valueOf() - 30 * 86_400_000));
  // Fix the candidate set before refreshing. Each successful refresh can remove its own row from the predicate.
  const candidates = await store.run(async db => (await db.client.query({ text: `SELECT p."Id",
    (p."Overview" IS NOT NULL AND octet_length(p."Overview") > 0) AS overview, image.present
    FROM ${q(db.schemaName)}."BaseItems" p CROSS JOIN LATERAL (SELECT EXISTS (
      SELECT 1 FROM ${q(db.schemaName)}."BaseItemImageInfos" i WHERE i."ItemId" = p."Id" AND i."ImageType" = 0) AS present) image
    WHERE p."Type" = $1 AND (p."DateLastRefreshed" IS NULL OR p."DateLastRefreshed" < $2)
      AND (NOT image.present OR COALESCE(octet_length(p."Overview"), 0) = 0) ORDER BY p."Id"`,
    values: [personType, nativeTextBytes(cutoff)], signal })).rows, { signal });
  for (const [index, row] of candidates.entries()) {
    const id = decodeNativeTextBytes(row.Id);
    await attempt(id, () => metadataScanner.refreshItem(id, { signal, IsAutomated: false,
      MetadataRefreshMode: row.overview ? 'ValidationOnly' : 'FullRefresh', ImageRefreshMode: row.present ? 'ValidationOnly' : 'FullRefresh' }));
    reportProgress(66 + 34 * (index + 1) / candidates.length);
  }
  reportProgress(100);
}

export class RefreshPeopleTaskWorker extends ScheduledTaskWorker {
  constructor({ store, library, lifecycle, metadataScanner, logger, clock = () => new Date(), ...options }) {
    super({ ...options, clock,
      definition: {
        id: md5Guid('Emby.Server.Implementations.ScheduledTasks.Tasks.PeopleValidationTask'), key: 'RefreshPeople',
        configurable: true, categoryKey: 'TasksLibraryCategory', category: 'Library',
        nameKey: 'TaskRefreshPeople', name: 'Refresh People', descriptionKey: 'TaskRefreshPeopleDescription',
        description: 'Updates metadata for actors and directors in your media library.',
        defaultTriggers: [{ Type: 'IntervalTrigger', IntervalTicks: 6_048_000_000_000n }],
      },
      run: operation => refreshPeople({ store, library, lifecycle, metadataScanner, logger, clock }, operation),
    });
  }
}
