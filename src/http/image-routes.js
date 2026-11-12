import { MIMEType } from 'node:util';
import { decodeBase64Body } from './base64-body.js';
import { BindingError, queryValue, HttpResult, notFound, noContent, httpError, booleanValue } from './binding.js';
import { nativeGuid, wireGuid } from '../users/native.js';
import { enumName } from '../sessions/binding.js';
import { clrTrim } from '../metadata/whitespace.js';
import { imageTypes } from '../metadata/image-paths.js';
import { mimeToExtension } from './mime-types.js';

const formats = ['Bmp', 'Gif', 'Jpg', 'Png', 'Webp', 'Svg'];
const invalid = (name, value) => new BindingError(name, `The value '${value}' is not valid.`);
function guid(value, name) {
  if (value == null || clrTrim(value) === '') return undefined;
  try { return nativeGuid(value); } catch { throw invalid(name, value); }
}
function enumeration(value, name, names, nullable = false) {
  if (value == null || clrTrim(value) === '') return undefined;
  let result;
  try { result = enumName(clrTrim(value), names); } catch { if (nullable) return undefined; throw invalid(name, value); }
  if (!nullable && typeof result === 'number') throw new BindingError(name, `The value '${value}' is invalid.`);
  return result;
}
function number(value, name, floating = false) {
  if (value == null || clrTrim(value) === '') return undefined;
  const text = value.replace(/\0+$/, '').replace(/^[\x09-\x0d ]+|[\x09-\x0d ]+$/g, '');
  if (floating && /^[+-]?(?:NaN|Infinity)$/i.test(text)) return /nan/i.test(text) ? NaN : text.startsWith('-') ? -Infinity : Infinity;
  if (!(floating ? /^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i : /^[+-]?\d+$/).test(text)) throw invalid(name, value);
  const result = Number(text.replaceAll(',', ''));
  if (!floating && (result < -2147483648 || result > 2147483647)) throw invalid(name, value);
  return result;
}
export function bindImageOptions(context, { user = false } = {}) {
  const query = name => queryValue(context.query, name);
  const source = name => Object.hasOwn(context.params, name) ? context.params[name] : query(name);
  const result = { tag: source('tag'), format: enumeration(source('format'), 'format', formats, !Object.hasOwn(context.params, 'format')) };
  if (user) result.userId = guid(context.params.userId ?? query('userId'), 'userId');
  else result.itemId = guid(context.params.itemId, 'itemId');
  if (!user || context.params.imageType != null) {
    result.imageType = enumeration(context.params.imageType, 'imageType', imageTypes);
    result.imageIndex = number(source('imageIndex'), 'imageIndex');
    for (const key of ['width', 'height', 'maxWidth', 'maxHeight', 'fillWidth', 'fillHeight', 'quality', 'unplayedCount', 'blur']) result[key] = number(source(key), key);
    result.percentPlayed = number(source('percentPlayed'), 'percentPlayed', true);
    result.bg = query('backgroundColor'); result.foreground = query('foregroundLayer');
  }
  return result;
}
export function bindSplashscreenOptions(context) {
  return { tag: queryValue(context.query, 'tag'), format: enumeration(queryValue(context.query, 'format'), 'format', formats, true) };
}

function imageUpload(request, signal) {
  let mimeType, extension;
  try { mimeType = new MIMEType(request.headers['content-type']).essence; }
  catch { /* Missing and malformed Content-Type use the same response. */ }
  if (mimeType?.startsWith('image/')) extension = mimeToExtension(mimeType);
  if (!extension) throw new HttpResult(400, 'Incorrect ContentType.', { text: true });
  return { mimeType, extension, async read() {
    const abort = () => request.destroy();
    const chunks = [];
    let length = 0;
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if (Number(request.headers['content-length']) > 30_000_000) throw new HttpResult(413);
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 30_000_000) throw new HttpResult(413);
        chunks.push(chunk);
      }
    } finally { signal.removeEventListener('abort', abort); }
    const text = Buffer.concat(chunks, length).toString('latin1');
    return decodeBase64Body(text);
  } };
}

function imageMutation(context, { deleteImage = false, reorder = false } = {}) {
  const imageIndex = context.params.imageIndex ?? (deleteImage ? queryValue(context.query, 'imageIndex') : undefined);
  const options = { itemId: guid(context.params.itemId, 'itemId'),
    type: enumeration(context.params.imageType, 'imageType', imageTypes), index: number(imageIndex, 'imageIndex') ?? 0 };
  if (reorder) {
    options.newIndex = number(queryValue(context.query, 'newIndex'), 'newIndex');
    if (options.newIndex === undefined) throw new BindingError('newIndex', 'The newIndex field is required.');
  }
  return options;
}

function profileMutationUser(context) {
  const { params, query, auth } = context;
  const explicitId = guid(params.userId ?? queryValue(query, 'userId'), 'userId');
  if (params.imageType !== undefined) enumeration(params.imageType, 'imageType', imageTypes);
  number(params.index ?? (params.userId && context.request.method === 'DELETE' ? queryValue(query, 'index') : undefined), 'index');
  const id = explicitId && wireGuid(explicitId);
  if (!id || /^0+$/.test(id)) return auth.UserId ?? auth.User?.Id ?? '00000000-0000-0000-0000-000000000000';
  if (!auth.IsAdministrator && id !== auth.UserId) throw httpError(403, 'Forbidden');
  return id;
}

export function registerImageRoutes(add, { images }) {
  if (!images) return;
  const handled = async action => { try { return await action(); } catch (error) { if (error.status === 404 && error.code === 'image-item-missing') return notFound(); throw error; } };
  add('GET', '/Items/{itemId}/Images', context => handled(() => images.info(guid(context.params.itemId, 'itemId'), { user: context.auth.User })));
  const itemPaths = ['/Items/{itemId}/Images/{imageType}', '/Items/{itemId}/Images/{imageType}/{imageIndex}'];
  const elevation = { policy: 'RequiresElevation' };
  add('POST', itemPaths, context => handled(async () => {
    await images.uploadItem(imageMutation(context), context, signal => imageUpload(context.request, signal));
    return noContent();
  }), elevation);
  add('DELETE', itemPaths, context => handled(async () => {
    await images.deleteItem(imageMutation(context, { deleteImage: true }), context);
    return noContent();
  }), elevation);
  add('POST', '/Items/{itemId}/Images/{imageType}/{imageIndex}/Index', context => handled(async () => {
    await images.reorderItem(imageMutation(context, { reorder: true }), context);
    return noContent();
  }), elevation);
  const userPaths = ['/UserImage', '/Users/{userId}/Images/{imageType}', '/Users/{userId}/Images/{imageType}/{index}'];
  add('POST', userPaths, context => handled(async () => {
    await images.updateProfile(profileMutationUser(context), context, signal => imageUpload(context.request, signal));
    return noContent();
  }));
  add('DELETE', userPaths, context => handled(async () => {
    await images.updateProfile(profileMutationUser(context), context);
    return noContent();
  }));
  const remotePath = '/Items/{itemId}/RemoteImages';
  const remoteItemId = context => guid(context.params.itemId, 'itemId');
  add('GET', remotePath, context => handled(() => {
    const query = name => queryValue(context.query, name);
    return images.remoteImages(remoteItemId(context), context, {
      type: enumeration(query('type'), 'type', imageTypes), startIndex: number(query('startIndex'), 'startIndex'),
      limit: number(query('limit'), 'limit'), providerName: query('providerName'),
      includeAllLanguages: booleanValue(query('includeAllLanguages'), 'includeAllLanguages', false),
    });
  }));
  add('GET', remotePath + '/Providers', context => handled(() => images.remoteImages(remoteItemId(context), context)));
  add('POST', remotePath + '/Download', context => handled(async () => {
    const type = enumeration(queryValue(context.query, 'type'), 'type', imageTypes);
    if (type === undefined) throw new BindingError('type', 'The type field is required.');
    await images.downloadRemoteItem({ itemId: remoteItemId(context), type, imageUrl: queryValue(context.query, 'imageUrl') }, context);
    return noContent();
  }), elevation);
  for (const method of ['GET', 'HEAD']) {
    add(method, [...itemPaths,
      '/Items/{itemId}/Images/{imageType}/{imageIndex}/{tag}/{format}/{maxWidth}/{maxHeight}/{percentPlayed}/{unplayedCount}'],
    context => handled(() => images.item(bindImageOptions(context), context)), { public: true });
    add(method, ['/UserImage', '/Users/{userId}/Images/{imageType}', '/Users/{userId}/Images/{imageType}/{imageIndex}'], context => {
      const options = bindImageOptions(context, { user: true });
      options.userId ??= context.auth.User?.Id;
      if (!options.userId || /^0+$/.test(options.userId.replaceAll('-', ''))) return new HttpResult(400, 'UserId is required if unauthenticated');
      return handled(() => images.user(options, context));
    }, { public: true });
    for (const [group, lookup] of Object.entries({ Artists: 'getArtist', Genres: 'getGenre',
      MusicGenres: 'getMusicGenre', Persons: 'getPerson', Studios: 'getStudio' })) {
      const base = `/${group}/{name}/Images/{imageType}`;
      const paths = group === 'Artists' ? [base + '/{imageIndex}'] : [base, base + '/{imageIndex}'];
      add(method, paths, context => handled(() => {
        const { name } = context.params;
        if (clrTrim(name) === '') throw new BindingError('name', 'The name field is required.');
        return images.named(lookup, name, bindImageOptions(context), context);
      }), { public: true });
    }
  }
}
