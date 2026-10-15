import { BindingError, queryValue, HttpResult, notFound } from './binding.js';
import { nativeGuid } from '../users/native.js';
import { enumName } from '../sessions/binding.js';
import { clrTrim } from '../metadata/whitespace.js';
import { imageTypes } from '../metadata/image-paths.js';

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
export function registerImageRoutes(add, { images }) {
  if (!images) return;
  const handled = async action => { try { return await action(); } catch (error) { if (error.status === 404 && error.code === 'image-item-missing') return notFound(); throw error; } };
  add('GET', '/Items/{itemId}/Images', context => handled(() => images.info(guid(context.params.itemId, 'itemId'), { user: context.auth.User })));
  for (const method of ['GET', 'HEAD']) {
    add(method, ['/Items/{itemId}/Images/{imageType}', '/Items/{itemId}/Images/{imageType}/{imageIndex}',
      '/Items/{itemId}/Images/{imageType}/{imageIndex}/{tag}/{format}/{maxWidth}/{maxHeight}/{percentPlayed}/{unplayedCount}'],
    context => handled(() => images.item(bindImageOptions(context), context)), { public: true });
    add(method, ['/UserImage', '/Users/{userId}/Images/{imageType}', '/Users/{userId}/Images/{imageType}/{imageIndex}'], context => {
      const options = bindImageOptions(context, { user: true });
      options.userId ??= context.auth.User?.Id;
      if (!options.userId || /^0+$/.test(options.userId.replaceAll('-', ''))) return new HttpResult(400, 'UserId is required if unauthenticated');
      return handled(() => images.user(options, context));
    }, { public: true });
  }
}
