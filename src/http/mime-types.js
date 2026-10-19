import mappings from './resources/mime-types.json' with { type: 'json' };
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const mimeTypes = new Map(Object.entries(mappings.extensionMimeTypes).map(([extension, mime]) => [ordinalIgnoreCaseKey(extension), mime]));
const extensions = new Map(Object.entries(mappings.mimeExtensions).map(([mime, extension]) => [ordinalIgnoreCaseKey(mime), extension]));
const videos = new Set(mappings.videoExtensions.map(ordinalIgnoreCaseKey));
const required = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty string.`);
};
function extensionOf(filename) {
  for (let index = filename.length - 1; index >= 0; index--) {
    if (filename[index] === '.') return index === filename.length - 1 ? '' : filename.slice(index);
    if (filename[index] === '/' || filename.charCodeAt(index) === 92) break;
  }
  return '';
}

export function getMimeType(filename, defaultValue = 'application/octet-stream') {
  required(filename, 'The filename');
  const extension = extensionOf(filename), key = ordinalIgnoreCaseKey(extension);
  return mimeTypes.get(key) ?? (videos.has(key) ? 'video/' + extension.slice(1) : defaultValue);
}

export function mimeToExtension(mimeType) {
  required(mimeType, 'The MIME type');
  const separator = mimeType.indexOf(';');
  return extensions.get(ordinalIgnoreCaseKey(separator < 0 ? mimeType : mimeType.slice(0, separator))) ?? null;
}
