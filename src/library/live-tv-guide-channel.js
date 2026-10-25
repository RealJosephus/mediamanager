import { md5Guid, lowerInvariant } from '../core/identity.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { newNativeItemEntity } from './native-item-entity.js';
import { idKey, MIN_DATE } from './records.js';

const channelType = 'MediaBrowser.Controller.LiveTv.LiveTvChannel';
const blank = value => value == null || clrTrim(value) === '';
const equals = (left, right) => left == null || right == null ? left == null && right == null : ordinalIgnoreCaseEquals(left, right);
export const guideChannelId = (serviceName, externalId) => md5Guid(channelType + lowerInvariant((serviceName ?? '') + (externalId ?? '') + '4'));

async function setPrimaryImage(item, selected, getImageFileInfo) {
  const image = item.ImageInfos.find(value => value.Type === 'Primary');
  const remote = /^http/iu.test(selected);
  let fields;
  if (remote) fields = { Path: selected, DateModified: MIN_DATE, Width: 0, Height: 0, BlurHash: null };
  else {
    if (typeof getImageFileInfo !== 'function') throw new TypeError('A local channel image requires mapped file information.');
    const file = await getImageFileInfo(selected);
    fields = { Path: file.FullName, DateModified: file.DateModified, Width: 0, Height: 0 };
    // The FileSystemMetadata overload does not reset an existing BlurHash.
    if (!image) fields.BlurHash = null;
  }
  if (image) Object.assign(image, fields);
  else item.ImageInfos = [...item.ImageInfos, { ...fields, Type: 'Primary' }];
}

/** GuideManager.GetChannel field and image changes, before the caller chooses
 * its actual CreateItem or MetadataImport update persistence boundary. */
export async function materializeGuideChannel(info, { existing = null, serviceName, parent, now = () => new Date(), getImageFileInfo } = {}) {
  if (!parent || typeof serviceName !== 'string') throw new TypeError('Guide channels require a parent and service name.');
  const item = existing?.Type === 'LiveTvChannel' ? existing : newNativeItemEntity(channelType);
  let isNew = item !== existing, updated = false;
  if (isNew) {
    item.Name = info.Name;
    item.Id = guideChannelId(serviceName, info.Id);
    item.DateCreated = new Date(now()).toISOString();
  }
  if (info.Tags != null) {
    if (info.Tags.length !== item.Tags.length || info.Tags.some((tag, index) => !equals(tag, item.Tags[index]))) isNew = true;
    item.Tags = info.Tags;
  }
  if (idKey(item.ParentId) !== idKey(parent.Id)) isNew = true;
  item.ParentId = parent.Id;
  item.ChannelType = info.ChannelType;
  item.ServiceName = serviceName;
  const key = Object.keys(item.ProviderIds ?? {}).find(value => equals(value, 'ExternalServiceId')) ?? 'ExternalServiceId';
  if (!equals(item.ProviderIds?.[key] || null, serviceName)) updated = true;
  if (blank(serviceName)) throw Object.assign(new TypeError("The value cannot be an empty string or composed entirely of whitespace. (Parameter 'value')"),
    { status: 400 });
  item.ProviderIds ??= {};
  Object.defineProperty(item.ProviderIds, key, { value: clrTrim(serviceName), enumerable: true, writable: true, configurable: true });
  for (const [field, incoming] of [['ExternalId', info.Id], ['Number', info.Number], ['Name', info.Name]]) {
    if (item[field] !== incoming) updated = true;
    item[field] = incoming;
  }
  const primary = item.ImageInfos.find(value => value.Type === 'Primary');
  if (!primary || !blank(info.ImageUrl) && primary.Path !== info.ImageUrl) {
    const selected = !blank(info.ImagePath) ? info.ImagePath : !blank(info.ImageUrl) ? info.ImageUrl : null;
    if (selected !== null) { await setPrimaryImage(item, selected, getImageFileInfo); updated = true; }
  }
  return { item, isNew, isUpdated: !isNew && updated };
}
