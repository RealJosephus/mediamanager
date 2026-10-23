import { md5Guid, lowerInvariant } from '../core/identity.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { newNativeItemEntity } from './native-item-entity.js';
import { dateTicks, idKey, MIN_DATE } from './records.js';

const programType = 'MediaBrowser.Controller.LiveTv.LiveTvProgram';
const blank = value => value == null || clrTrim(value) === '';
const equals = (left, right) => left == null || right == null ? left == null && right == null : ordinalIgnoreCaseEquals(left, right);
const providerKey = (values, name) => Object.keys(values ?? {}).find(key => ordinalIgnoreCaseEquals(key, name));
const providerId = (values, name) => values?.[providerKey(values, name)] || null;
function setProviderId(values, name, value) {
  Object.defineProperty(values, providerKey(values, name) ?? name, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

export const guideProgramId = externalId => md5Guid(programType + lowerInvariant('Emby' + (externalId ?? '') + '4'));

function updateImage(item, info, type, urlName) {
  const image = item.ImageInfos.find(value => value.Type === type);
  const imagePath = type === 'Primary' ? info.ImagePath : null;
  const imageUrl = info[urlName];
  if (image?.Path != null && (equals(image.Path, imageUrl) || equals(image.Path, imagePath))) return false;
  const selected = !blank(imagePath) ? imagePath : !blank(imageUrl) ? imageUrl : null;
  if (selected !== null) {
    const fields = { Path: selected, DateModified: MIN_DATE, Width: 0, Height: 0, BlurHash: null };
    // BaseItem.SetImage mutates an existing image in place. Its identity can
    // already be captured by an image consumer during this refresh.
    if (image) Object.assign(image, fields);
    else item.ImageInfos = [...item.ImageInfos, { ...fields, Type: type }];
    return true;
  }
  // Native removal changes the live entity but does not itself request a save.
  item.ImageInfos = [...new Set(item.ImageInfos.filter(value => value !== image))];
  return false;
}

/** GuideManager.GetProgram consumes one initialized ProgramInfo. Persistence
 * and bounded SQL ownership belong to the caller, not this field projection. */
export async function materializeGuideProgram(info, { existing = null, channel, now = () => new Date(), metadataChanged } = {}) {
  if (!channel || typeof metadataChanged !== 'function') {
    throw new TypeError('Guide program materialization requires its channel and metadata change callback.');
  }
  const id = guideProgramId(info.Id), isNew = existing == null;
  const item = existing ?? newNativeItemEntity(programType);
  if (isNew) {
    item.Name = info.Name;
    item.Id = id;
    item.DateCreated = new Date(now()).toISOString();
    item.DateModified = new Date(now()).toISOString();
  } else if (!blank(info.Etag) && info.Etag.startsWith('xmltv-sha256-v1:')
    && equals(info.Etag, providerId(item.ProviderIds, 'ProgramEtag'))) {
    // This prefix is the native XMLTV producer's consumed-field protocol.
    // Other providers must retain the field-by-field update path.
    return { item, isNew: false, isUpdated: false };
  }
  let updated = false;
  if (!equals(info.ShowId, item.ShowId)) { item.ShowId = info.ShowId; updated = true; }
  if (idKey(item.ParentId) !== idKey(channel.Id)) { item.ParentId = channel.Id; updated = true; }
  item.Audio = info.Audio;
  item.ChannelId = channel.Id;
  item.CommunityRating = info.CommunityRating;
  item.EpisodeTitle = info.EpisodeTitle;
  item.ExternalId = info.Id;
  if (!blank(info.SeriesId) && !equals(item.ExternalSeriesId, info.SeriesId)) {
    item.ExternalSeriesId = info.SeriesId; updated = true;
  }
  const isSeries = info.IsSeries || info.EpisodeTitle != null && info.EpisodeTitle !== '';
  if (isSeries) item.SeriesName = info.Name;
  item.Tags = [['IsLive', 'Live'], ['IsPremiere', 'Premiere'], ['IsNews', 'News'], ['IsSports', 'Sports'],
    ['IsKids', 'Kids'], ['IsRepeat', 'Repeat'], ['IsMovie', 'Movie']]
    .filter(([name]) => info[name]).map(([, tag]) => tag);
  if (isSeries) item.Tags.push('Series');
  // ToArray and dictionary enumeration preserve native null failure prefixes.
  if (info.Genres == null) throw Object.assign(new TypeError('Object reference not set to an instance of an object.'),
    { nativeException: 'NullReferenceException', status: 500 });
  item.Genres = [...info.Genres];
  if (info.IsHD === true) { item.Width = 1280; item.Height = 720; }
  item.IsMovie = info.IsMovie;
  item.IsRepeat = info.IsRepeat;
  if (item.IsSeries !== isSeries) { item.IsSeries = isSeries; updated = true; }
  item.Name = info.Name;
  item.OfficialRating = info.OfficialRating;
  item.Overview = info.Overview;
  item.RunTimeTicks = dateTicks(info.EndDate) - dateTicks(info.StartDate);
  // The native manager adds Series IDs to the provider-owned dictionary and
  // then assigns that same dictionary to the entity, including Etag writes.
  for (const [key, value] of Object.entries(info.SeriesProviderIds)) setProviderId(info.ProviderIds, 'Series' + key, value);
  item.ProviderIds = info.ProviderIds;
  if (dateTicks(item.StartDate) !== dateTicks(info.StartDate)) { item.StartDate = info.StartDate; updated = true; }
  if (item.EndDate == null || dateTicks(item.EndDate) !== dateTicks(info.EndDate)) { item.EndDate = info.EndDate; updated = true; }
  item.ProductionYear = info.ProductionYear;
  if (!isSeries || info.IsRepeat) item.PremiereDate = info.OriginalAirDate;
  item.IndexNumber = info.EpisodeNumber;
  item.ParentIndexNumber = info.SeasonNumber;
  for (const [type, name] of [['Primary', 'ImageUrl'], ['Thumb', 'ThumbImageUrl'], ['Logo', 'LogoImageUrl'], ['Backdrop', 'BackdropImageUrl']]) {
    updated = updateImage(item, info, type, name) || updated;
  }
  if (blank(info.Etag)) updated = true;
  else if (!equals(info.Etag, providerId(item.ProviderIds, 'ProgramEtag'))) {
    item.ProviderIds ??= {};
    setProviderId(item.ProviderIds, 'ProgramEtag', clrTrim(info.Etag)); updated = true;
  }
  if (isNew || updated) await metadataChanged(item);
  return { item, isNew, isUpdated: !isNew && updated };
}
