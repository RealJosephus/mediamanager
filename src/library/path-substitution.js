import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

const normalize = (value, separator) => separator === '\\' ? value.replaceAll('/', '\\') : value.replaceAll('\\', '/');

export function tryReplaceSubPath(value, from, to) {
  if (typeof value !== 'string' || typeof from !== 'string' || typeof to !== 'string'
    || !value || !from || !to || from.length > value.length) return null;
  const separator = from.includes('/') ? '/' : '\\';
  const source = normalize(from, separator); const candidate = normalize(value, separator);
  const sourceEndsWithSeparator = source.at(-1) === separator;
  if (!ordinalIgnoreCaseEquals(candidate.slice(0, source.length), source)) return null;
  if (candidate.length > source.length && !sourceEndsWithSeparator && candidate[source.length] !== separator) return null;
  let replacementEnd = to.length;
  while (replacementEnd > 0 && to[replacementEnd - 1] === separator) replacementEnd--;
  const replacement = to.slice(0, replacementEnd);
  const remainderIndex = sourceEndsWithSeparator ? source.length - 1 : source.length;
  return replacement + candidate.slice(remainderIndex);
}

export function substitutePath(value, substitutions = []) {
  for (const substitution of substitutions ?? []) {
    const replaced = tryReplaceSubPath(value, substitution?.From, substitution?.To);
    if (replaced != null) return replaced;
  }
  return value;
}

export function substituteNfoImagePath(value, substitutions = []) {
  if (typeof value !== 'string' || ordinalIgnoreCaseEquals(value.slice(0, 4), 'http')) return value;
  return substitutePath(value, substitutions);
}
