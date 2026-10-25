// Limited to the current image response directives. Ambiguous, repeated and
// unknown directives retain exact spelling instead of being normalized away.
export function imageHeaderProjection(headers) {
  const result = { ...headers }, cache = result['cache-control'];
  if (cache != null) {
    const names = new Set(), known = new Set(['public', 'private', 'no-cache', 'no-store', 'must-revalidate', 'immutable', 'max-age']);
    const directives = cache.split(',').map(value => value.trim());
    const parsed = directives.map(value => {
      const match = /^([\w-]+)(?:\s*=\s*(\d+))?$/u.exec(value);
      const name = match?.[1].toLowerCase();
      if (!known.has(name) || names.has(name) || (name === 'max-age') !== (match?.[2] != null)) return null;
      names.add(name);
      return [name, match[2] ?? null];
    });
    if (parsed.every(Boolean) && !(names.has('public') && names.has('private')))
      result['cache-control'] = parsed.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }
  // Only the bare attachment token is in this acceptance scope. Filenames,
  // quoting, fallback, controls and extended parameters stay byte-exact.
  if (/^\s*attachment\s*$/iu.test(result['content-disposition'] ?? '')) result['content-disposition'] = 'attachment';
  return result;
}
