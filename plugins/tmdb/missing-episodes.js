import { ItemUpdateType } from '@mediamanager/plugin-sdk/metadata/save-manager';
import { dateTicks, idKey, libraryError, sameId } from '@mediamanager/plugin-sdk/library/records';
import { createPresentationUniqueKey } from '@mediamanager/plugin-sdk/library/presentation-key';
import { fillMissingEpisodeNumbersFromPath } from '@mediamanager/plugin-sdk/metadata/episode-naming';
import { ordinalIgnoreCaseKey } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
import { imageLanguages, PROVIDER_NAME } from './utils.js';
import { calendarDateToUtc } from '@mediamanager/plugin-sdk/metadata/calendar-date';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '@mediamanager/plugin-sdk/database/model';
import { nativeTextBytes, decodeNativeTextBytes } from '@mediamanager/plugin-sdk/database/native-text';
import { createNativeItemCohort } from '@mediamanager/plugin-sdk/library/native-item-cohort';

const tmdbKey = ordinalIgnoreCaseKey('Tmdb');
const int32Maximum = 2147483647n;
const int64Minimum = -9223372036854775808n;
const int64Maximum = 9223372036854775807n;
const integerText = /^[\u0009-\u000d\u0020]*[+-]?\d+[\u0009-\u000d\u0020]*$/u;
const trimIntegerWhitespace = value => value.replace(/^[\u0009-\u000d\u0020]+|[\u0009-\u000d\u0020]+$/gu, '');
const decimalDigit = /^\p{Nd}$/u;

const episodeType = value => String(value?.Type ?? '').split('.').at(-1) === 'Episode';
const tmdbId = item => Object.entries(item?.ProviderIds ?? {})
  .find(([key, value]) => ordinalIgnoreCaseKey(key) === tmdbKey && value != null && String(value).length > 0)?.[1];
const ownsVirtualEpisode = item => episodeType(item) && item.IsVirtualItem === true && tmdbId(item) != null;

function collectionFolderIdKey(value) {
  const key = idKey(value);
  return /^[0-9a-f]{32}$/i.test(key) ? ordinalIgnoreCaseKey(key) : null;
}

/** NumberStyles.Integer + Int32.TryParse for persisted provider-id strings. */
export function parseTmdbSeriesId(value) {
  if (value == null) return null;
  const text = String(value);
  if (!integerText.test(text)) return null;
  let parsed;
  try { parsed = BigInt(trimIntegerWhitespace(text)); } catch { return null; }
  return parsed >= 1n && parsed <= int32Maximum ? Number(parsed) : null;
}

function remoteDateParts(value) {
  const text = value instanceof Date
    ? `${value.getFullYear().toString().padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return { year, premiereDate: calendarDateToUtc(year, month, day) };
}

/** TMDb's date-only value is first made Local, then converted to UTC. */
export function tmdbEpisodePremiereDate(value) {
  return remoteDateParts(value)?.premiereDate ?? null;
}

const utcDate = value => {
  if (value == null) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

export function shouldImportTmdbEpisode(premiereDate, today, {
  importUnaired = false, importMissing = false, isSpecial = false, importSpecials = false
} = {}) {
  const premiere = utcDate(premiereDate), current = utcDate(today);
  if (premiere == null || current == null || isSpecial && !importSpecials) return false;
  return premiere >= current ? importUnaired : importMissing;
}

export function shouldPruneTmdbEpisode(episode, today, {
  pruneAgedOut = false, gracePeriodDays = 0, importSpecials = false
} = {}) {
  if (!ownsVirtualEpisode(episode)) return false;
  if (episode.ParentIndexNumber === 0 && !importSpecials) return true;
  const premiere = utcDate(episode.PremiereDate), current = utcDate(today);
  if (!pruneAgedOut || premiere == null || current == null) return false;
  return premiere < current - Math.max(0, Number(gracePeriodDays) || 0) * 86400000;
}

export function buildTmdbSeasonSortNameTemplate(seasons) {
  const reference = seasons.find(season => !season.IsVirtualItem && season.IndexNumber != null
    && season.ForcedSortName != null && season.ForcedSortName !== '');
  if (!reference) return null;
  const forced = reference.ForcedSortName;
  let start = -1, end = -1;
  // C# walks UTF-16 chars with char.IsDigit. Testing one code unit at a time
  // retains that behavior (including not combining supplementary pairs).
  for (let index = forced.length - 1; index >= 0; index--) {
    if (decimalDigit.test(forced[index])) {
      if (end < 0) end = index;
      start = index;
    } else if (end >= 0) break;
  }
  if (end < 0) return null;
  const prefix = forced.slice(0, start), suffix = forced.slice(end + 1), width = end - start + 1;
  return number => prefix + String(number).padStart(width, '0') + suffix;
}

function updateVirtualEpisode(episode, remote, premiere) {
  let changed = false;
  if (remote.name != null && remote.name !== '' && episode.Name !== remote.name) {
    episode.Name = remote.name; changed = true;
  }
  if (remote.overview != null && remote.overview !== '' && episode.Overview !== remote.overview) {
    episode.Overview = remote.overview; changed = true;
  }
  if (premiere != null && (episode.PremiereDate == null || dateTicks(episode.PremiereDate) !== dateTicks(premiere))) {
    episode.PremiereDate = premiere;
    episode.ProductionYear = remoteDateParts(remote.air_date)?.year ?? null;
    changed = true;
  }
  return changed;
}

function providerEnabled(configuration, collectionFolderIds) {
  const enabled = new Set((configuration?.EnabledMissingEpisodeLibraries ?? []).map(value => ordinalIgnoreCaseKey(value)));
  return (collectionFolderIds ?? []).some(value => {
    const key = collectionFolderIdKey(value);
    return key != null && enabled.has(key);
  });
}

function requireLifecycle(value) {
  if (!value || typeof value.load !== 'function' || typeof value.remove !== 'function') {
    throw libraryError(501, 'Active TMDB missing-episode lifecycle is not wired.');
  }
  return value;
}

function requireActiveLifecycle(value) {
  value = requireLifecycle(value);
  for (const method of ['utcToday', 'update', 'createSeason', 'createEpisode', 'saveStill', 'withItem']) {
    if (typeof value[method] !== 'function') {
      throw libraryError(501, `Active TMDB missing-episode lifecycle is missing ${method}.`);
    }
  }
  return value;
}

function int32(value, label) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new RangeError(`TMDB ${label} is outside Int32.`);
  }
  return value;
}

function uncheckedEpisodeNumber(value) {
  let integer;
  if (typeof value === 'bigint') integer = value;
  else if (Number.isSafeInteger(value)) integer = BigInt(value);
  else throw new RangeError('TMDB episode number is outside Int64.');
  if (integer < int64Minimum || integer > int64Maximum) throw new RangeError('TMDB episode number is outside Int64.');
  return Number(BigInt.asIntN(32, integer));
}

/**
 * The provider owns remote ordering and reconciliation policy. Persistence is
 * injected by MetadataRefreshHost so every child crosses the ordinary item
 * creation/update/deletion lifecycle rather than a provider-specific SQL path.
 */
export function createTmdbMissingEpisodeProvider(client, lifecycleHost) {
  if (!client) throw new TypeError('TMDB missing episodes require a client.');
  const configuration = client.configuration;
  const importUnaired = () => Boolean(configuration?.ImportUnairedEpisodes);
  const importMissing = () => Boolean(configuration?.ImportMissingEpisodes);
  const ensureStill = async (lifecycle, episode, remote, signal) => {
    if ((episode.ImageInfos ?? []).some(image => image.Type === 'Primary') || remote.still_path == null || remote.still_path === '') return false;
    try {
      const url = client.imageUrl(remote.still_path, configuration?.StillSize);
      return url ? await lifecycle.saveStill(episode, url, signal) : false;
    } catch (error) {
      lifecycle.logger?.error?.(error,
        `Error downloading still for virtual episode S${episode.ParentIndexNumber}E${episode.IndexNumber} of ${episode.SeriesName}`);
      return false;
    }
  };
  return {
    id: 'TmdbMissingEpisodeProvider',
    name: PROVIDER_NAME,
    kind: 'custom',
    itemTypes: ['Series'],
    order: 100,
    hasChanged: item => configuration != null && item?.Type === 'Series' && tmdbId(item) != null,
    async fetch(item, { collectionFolderIds, signal, lifecycle = lifecycleHost } = {}) {
      const enabled = (importUnaired() || importMissing()) && providerEnabled(configuration, collectionFolderIds);
      if (!enabled) {
        const owner = requireLifecycle(lifecycle);
        const state = await owner.load(item);
        const removed = [];
        try { const children = await state.recursive();
          for await (const page of children.pages()) for (const episode of page) if (ownsVirtualEpisode(episode)) {
            await owner.remove(episode); removed.push(episode.Id);
          }
        } finally { await state.close(); }
        if (removed.length) item.Children = null;
        return { UpdateType: removed.length ? ItemUpdateType.MetadataImport : ItemUpdateType.None, RemovedItemIds: removed };
      }

      const seriesId = parseTmdbSeriesId(tmdbId(item));
      if (seriesId == null) return { UpdateType: ItemUpdateType.None };
      const language = item.MetadataLanguage;
      const country = item.MetadataCountryCode;
      const imageLanguage = imageLanguages(language, country);
      const remoteSeries = await client.series(seriesId, language, imageLanguage, country, { signal });
      if (remoteSeries?.seasons == null) return { UpdateType: ItemUpdateType.None };

      const owner = requireActiveLifecycle(lifecycle);
      const state = await owner.load(item);
      try {
        return await reconcileEpisodes({ state, lifecycle: owner, item, seriesId, remoteSeries, client, configuration,
          language, imageLanguage, country, signal, importUnaired, importMissing, ensureStill });
      } finally { await state.close(); }
    },
  };
}

async function reconcileEpisodes({ state, lifecycle, item, seriesId, remoteSeries, client, configuration,
  language, imageLanguage, country, signal, importUnaired, importMissing, ensureStill }) {
  const children = await state.recursive();
  return children.aggregationSession(async (database, { plan }) => {
    const suffix = randomUUID().replaceAll('-', '');
    const snapshot = q('mm_missing_snapshot_' + suffix), episodes = q('mm_missing_episodes_' + suffix),
      seasons = q('mm_missing_seasons_' + suffix), updatable = q('mm_missing_updatable_' + suffix);
    const created = await createNativeItemCohort({ linkedChildren: state.linkedChildren });
    let createdOrdinal = 0n;
    try {
      await database.client.query({ text: `CREATE TEMP TABLE ${snapshot} AS ${plan.text}`, values: plan.values });
      await database.client.query(`CREATE TEMP TABLE ${episodes}("Ordinal" bigint PRIMARY KEY,"Season" integer,"Episode" integer,"Owned" boolean,"Physical" boolean);
        CREATE INDEX ON ${episodes}("Season","Episode")`);
      await database.client.query(`CREATE TEMP TABLE ${seasons} AS SELECT DISTINCT ON("IndexNumber") "Ordinal","IndexNumber","ForcedSortName","IsVirtualItem",NULL::bigint AS "CreatedOrdinal"
          FROM ${snapshot} WHERE "ItemType"=$1 AND "IndexNumber" IS NOT NULL ORDER BY "IndexNumber","Ordinal"`, [nativeTextBytes('Season')]);
      const today = lifecycle.utcToday();
      const gracePeriodDays = Math.max(0, Number(configuration?.UpcomingEpisodeGracePeriodDays) || 0);
      const importSpecials = Boolean(configuration?.ImportSpecials);
      let pruned = false;
      let ordinal = 0n;
      for await (const page of children.pages()) for (const episode of page) {
        ordinal++;
        if (!episodeType(episode)) continue;
        const context = await state.contextFor(episode);
        if (episode.IsFileProtocol && (episode.ParentIndexNumber == null || episode.IndexNumber == null)) {
          try { fillMissingEpisodeNumbersFromPath(episode, context, false); }
          catch (error) { lifecycle.logger?.error?.(error, `Error resolving episode number from path for ${episode.Path}`); }
        }
        const ours = ownsVirtualEpisode(episode);
        if (shouldPruneTmdbEpisode(episode, today, { pruneAgedOut: !importMissing(), gracePeriodDays, importSpecials })) {
          await lifecycle.remove(episode); pruned = true; continue;
        }
        if (episode.ParentIndexNumber == null || episode.IndexNumber == null) continue;
        await database.client.query(`INSERT INTO ${episodes} VALUES($1,$2,$3,$4,$5)`,
          [ordinal,episode.ParentIndexNumber,episode.IndexNumber,ours,!ours&&!episode.IsVirtualItem]);
      }
      for (let after = 0n; ;) {
        const page = (await database.client.query(`SELECT own."Ordinal" FROM ${episodes} own WHERE own."Ordinal">$1 AND own."Owned"
          AND EXISTS(SELECT 1 FROM ${episodes} physical WHERE physical."Physical" AND physical."Season"=own."Season" AND physical."Episode"=own."Episode")
          ORDER BY own."Ordinal" LIMIT 128`,[after])).rows;
        if (!page.length) break;
        for (const row of page) await children.withItemAtOrdinal(BigInt(row.Ordinal), async episode => {
          await lifecycle.remove(episode); pruned = true;
        });
        after=BigInt(page.at(-1).Ordinal);
      }
      await database.client.query(`CREATE TEMP TABLE ${updatable} AS SELECT DISTINCT ON(own."Season",own."Episode") own."Season",own."Episode",own."Ordinal"
        FROM ${episodes} own WHERE own."Owned" AND NOT EXISTS(SELECT 1 FROM ${episodes} physical
          WHERE physical."Physical" AND physical."Season"=own."Season" AND physical."Episode"=own."Episode")
        ORDER BY own."Season",own."Episode",own."Ordinal" DESC`);
      const withSeason = async (number,name,operation) => {
        let row = (await database.client.query(`SELECT * FROM ${seasons} WHERE "IndexNumber"=$1 LIMIT 1`,[number])).rows[0];
        if (!row) {
          const season = await lifecycle.createSeason(item,number,name,state,signal);
          await lifecycle.withItem(season,async () => {
            await created.capture(season,{ordinal:++createdOrdinal});
            const position=BigInt((await database.client.query(`SELECT COALESCE(max("Ordinal"),0)+1 AS next FROM ${seasons}`)).rows[0].next);
            await database.client.query(`INSERT INTO ${seasons} VALUES($1,$2,$3,$4,$5)`,[position,number,
              season.ForcedSortName==null?null:nativeTextBytes(season.ForcedSortName),season.IsVirtualItem,createdOrdinal]);
          });
          row = {CreatedOrdinal:createdOrdinal};
        }
        if (row.CreatedOrdinal==null) return children.withItemAtOrdinal(BigInt(row.Ordinal),operation);
        const page = await created.page({after:BigInt(row.CreatedOrdinal)-1n,limit:1});
        try { return await operation(page.entries[0].item); } finally { await page.release(); }
      };

      let added = false, updated = false;
      for (const seasonInfo of remoteSeries.seasons) {
        signal?.throwIfAborted();
        const seasonNumber = int32(seasonInfo.season_number, 'season number');
        const remoteSeason = await client.season(seriesId, seasonNumber, language, imageLanguage, country, { signal });
        if (remoteSeason?.episodes == null) continue;
        for (const remoteEpisode of remoteSeason.episodes) {
          const episodeNumber = uncheckedEpisodeNumber(remoteEpisode.episode_number);
          const premiere = tmdbEpisodePremiereDate(remoteEpisode.air_date);
          if (!shouldImportTmdbEpisode(premiere, today, {
            importUnaired: importUnaired(), importMissing: importMissing(), isSpecial: seasonNumber === 0, importSpecials
          })) continue;
          const current = (await database.client.query(`SELECT "Ordinal" FROM ${updatable} WHERE "Season"=$1 AND "Episode"=$2`,[seasonNumber,episodeNumber])).rows[0];
          if (current) {
            await children.withItemAtOrdinal(BigInt(current.Ordinal), async current => withSeason(seasonNumber,remoteSeason.name,async season => {
            let changed = updateVirtualEpisode(current, remoteEpisode, premiere);
            if (!sameId(current.ParentId, season.Id)) {
              current.ParentId = season.Id; current.SeasonId = season.Id; current.SeasonName = season.Name; changed = true;
            }
            if (current.PresentationUniqueKey == null || current.PresentationUniqueKey === '') {
              current.PresentationUniqueKey = createPresentationUniqueKey(current, { series: item }); changed = true;
            }
            if (changed) { await lifecycle.update(current, ItemUpdateType.MetadataImport, signal, state); updated = true; }
            if (await ensureStill(lifecycle, current, remoteEpisode, signal)) updated = true;
            }));
            continue;
          }
          if ((await database.client.query(`SELECT EXISTS(SELECT 1 FROM ${episodes} WHERE "Season"=$1 AND "Episode"=$2) AS present`,[seasonNumber,episodeNumber])).rows[0].present) continue;
          await database.client.query(`INSERT INTO ${episodes} VALUES($1,$2,$3,FALSE,FALSE)`,[-(++ordinal),seasonNumber,episodeNumber]);
          await withSeason(seasonNumber,remoteSeason.name,async season => {
            const episode = await lifecycle.createEpisode(item,season,remoteEpisode,episodeNumber,premiere,state);
            await lifecycle.withItem(episode,()=>ensureStill(lifecycle,episode,remoteEpisode,signal));
          });
          added = true;
        }
      }

      const reference = (await database.client.query(`SELECT "ForcedSortName" FROM ${seasons} WHERE NOT "IsVirtualItem"
        AND "ForcedSortName" IS NOT NULL AND octet_length("ForcedSortName")>0 ORDER BY "Ordinal" LIMIT 1`)).rows[0];
      const template = reference ? buildTmdbSeasonSortNameTemplate([{ IsVirtualItem:false,IndexNumber:0,
        ForcedSortName:decodeNativeTextBytes(reference.ForcedSortName,'runtime') }]) : null;
      let aligned = false;
      if (template) for (let after=0n;;) {
        const page=(await database.client.query(`SELECT * FROM ${seasons} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`,[after])).rows;
        if(!page.length)break;
        for(const row of page) await withSeason(row.IndexNumber,null,async season=>{
          if(!season.IsVirtualItem)return;
          const desired=template(season.IndexNumber);if(season.ForcedSortName===desired)return;
          season.ForcedSortName=desired;await lifecycle.update(season,ItemUpdateType.MetadataEdit,signal,state);aligned=true;
        });
        after=BigInt(page.at(-1).Ordinal);
      }

      if (added || pruned || updated || aligned) item.Children = null;
      return { UpdateType: added || pruned || updated || aligned ? ItemUpdateType.MetadataImport : ItemUpdateType.None };
    } finally {
      try { await database.client.query(`DROP TABLE IF EXISTS ${updatable},${seasons},${episodes},${snapshot}`); }
      finally { await created.release(); }
    }
  });
}

// Direct maintenance callers use the same full lifecycle as provider Fetch.
export async function pruneDisabledTmdbVirtualEpisodes(lifecycle, series) {
  lifecycle = requireLifecycle(lifecycle);
  const state = await lifecycle.load(series), removed = [];
  try { const children=await state.recursive();
    for await (const page of children.pages()) for (const episode of page) if(ownsVirtualEpisode(episode)) {
      await lifecycle.remove(episode);removed.push(episode.Id);
    }
  } finally { await state.close(); }
  return removed;
}
