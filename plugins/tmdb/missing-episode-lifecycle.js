import { saveMetadataItem } from '@mediamanager/plugin-sdk/metadata/save-item';
import { publishNativeImageInfos } from '@mediamanager/plugin-sdk/metadata/images';
import { ItemUpdateType } from '@mediamanager/plugin-sdk/metadata/save-manager';
import { copyNativeItemState, newNativeItemEntity } from '@mediamanager/plugin-sdk/library/native-item-entity';
import { createPresentationUniqueKey } from '@mediamanager/plugin-sdk/library/presentation-key';
import { EMPTY_ID, guid, idKey, MIN_DATE, sameId } from '@mediamanager/plugin-sdk/library/records';

const seasonNativeType = 'MediaBrowser.Controller.Entities.TV.Season';
const episodeNativeType = 'MediaBrowser.Controller.Entities.TV.Episode';

function utcToday(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('TMDB missing-episode clock returned an invalid date.');
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}
function airDateYear(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getFullYear() : null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Persistence boundary used only by TMDB's per-Series virtual episode pass.
 * It composes the ordinary TV cleanup, ItemCreationService, repository update
 * and image hosts; no provider-specific row writes are allowed here.
 */
export class TmdbMissingEpisodeLifecycleHost {
  constructor({ seriesLifecycle, itemCreation, loadContext, updates, images, refreshSeason,
    logger = { error() {} }, now = () => new Date().toISOString() }) {
    if (!seriesLifecycle || !itemCreation || typeof loadContext !== 'function' || !updates || !images
      || typeof refreshSeason !== 'function') {
      throw new TypeError('TMDB missing episodes require TV, creation, update, image and nested-refresh lifecycles.');
    }
    Object.assign(this, { seriesLifecycle, itemCreation, loadContext, updates, images, refreshSeason, logger, now });
  }

  utcToday() { return utcToday(this.now()); }

  load(series) { return this.seriesLifecycle.load(series); }

  async withItem(item, operation) {
    const owner = this.itemCreation.retainItem(item);
    try { return await operation(item); }
    finally { owner.release(); await this.loadContext.linkedChildren.flushReleases(); }
  }

  async remove(item) {
    await this.seriesLifecycle.remove(item);
  }

  async update(item, reason, signal, state) {
    return this.loadContext.withContext(item.Id, { draft: item, includeChildren: false }, async loaded => {
      await saveMetadataItem(this.updates, loaded, { Item: loaded.item, People: null }, reason, { signal });
      if (loaded.item !== item) copyNativeItemState(item, loaded.item);
    });
  }

  async createSeason(series, number, name, state, signal) {
    const season = newNativeItemEntity(seasonNativeType);
    const owner = this.itemCreation.retainItem(season);
    try {
    const timestamp = this.now();
    Object.assign(season, {
      Id: guid(state.getNewItemId(`${guid(series.Id).replaceAll('-', '')}Season${number}`, seasonNativeType)),
      Name: name ?? null,
      IndexNumber: number,
      IsVirtualItem: true,
      ParentId: series.Id,
      SeriesId: series.Id,
      SeriesName: series.Name,
      SeriesPresentationUniqueKey: state.presentationUniqueKey,
      DateCreated: timestamp,
      DateModified: timestamp,
      DateLastRefreshed: MIN_DATE,
      DateLastSaved: MIN_DATE,
      ProviderIds: {},
      LockedFields: [],
    });
    // AddChild/CreateItem does not consume the request token. A later nested
    // refresh failure deliberately leaves this independently committed season.
    await this.itemCreation.createItems([season], series);
    const result = await this.refreshSeason(season, series, {
      MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true, signal
    });
    const refreshed = result?.Item ?? await this.itemCreation.getItemById(season.Id) ?? season;
    return refreshed;
    } finally { owner.release(); await this.loadContext.linkedChildren.flushReleases(); }
  }

  async createEpisode(series, season, remote, episodeNumber, premiereDate, state) {
    const seasonNumber = season.IndexNumber ?? 0;
    const episode = newNativeItemEntity(episodeNativeType);
    const owner = this.itemCreation.retainItem(episode);
    try {
    const timestamp = this.now();
    Object.assign(episode, {
      Id: guid(state.getNewItemId(`${guid(series.Id).replaceAll('-', '')}Season${seasonNumber}Episode${episodeNumber}`, episodeNativeType)),
      Name: remote.name ?? null,
      IndexNumber: episodeNumber,
      ParentIndexNumber: seasonNumber,
      IsVirtualItem: true,
      ParentId: season.Id,
      PremiereDate: premiereDate,
      ProductionYear: airDateYear(remote.air_date),
      Overview: remote.overview ?? null,
      SeasonId: season.Id,
      SeasonName: season.Name,
      SeriesId: series.Id,
      SeriesName: series.Name,
      SeriesPresentationUniqueKey: state.presentationUniqueKey,
      DateCreated: timestamp,
      DateModified: timestamp,
      ProviderIds: remote.id > 0 ? { Tmdb: String(remote.id) } : {},
      LockedFields: [],
    });
    episode.PresentationUniqueKey = createPresentationUniqueKey(episode, { series });
    await this.itemCreation.createItems([episode], season);
    return episode;
    } finally { owner.release(); await this.loadContext.linkedChildren.flushReleases(); }
  }

  async saveStill(item, url, signal) {
    return this.loadContext.withContext(item.Id, { draft: item, includeChildren: false }, async loaded => {
      const images = loaded.context.images;
      if (images.some(image => image.Type === 'Primary')) return false;
      await this.images.saveRemote(loaded, images, { Type: 'Primary', Url: url }, { signal });
      publishNativeImageInfos(loaded.item, images);
      await saveMetadataItem(this.updates, loaded, { Item: loaded.item, People: null, Images: images },
        ItemUpdateType.ImageUpdate, { signal });
      if (loaded.item !== item) copyNativeItemState(item, loaded.item);
      return true;
    });
  }
}
