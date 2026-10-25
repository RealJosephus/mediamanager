const type = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const key = value => String(value ?? '').replaceAll('-', '').toLowerCase();
const nonempty = value => value != null && key(value) !== '' && key(value) !== '00000000000000000000000000000000';
const asSeries = item => type(item) === 'Series' ? item : null;

function reference(item) {
  if (!['Episode', 'Season'].includes(type(item))) return { resolved: true, value: null };
  // Domain callers can pass an already evaluated getter, including its null result.
  if (Object.hasOwn(item, 'Series')) return { resolved: true, value: asSeries(item.Series) };
  return { resolved: false, explicit: nonempty(item.SeriesId), id: nonempty(item.SeriesId) ? item.SeriesId : item.ParentId };
}

export function resolveSeries(item, byId) {
  const source = reference(item);
  if (source.resolved) return source.value;
  if (source.explicit) return asSeries(byId.get(key(source.id)));
  let parentId = source.id;
  const visited = new Set();
  while (nonempty(parentId) && !visited.has(key(parentId))) {
    visited.add(key(parentId));
    const parent = byId.get(key(parentId));
    if (!parent) return null;
    if (type(parent) === 'Series') return parent;
    parentId = parent.ParentId;
  }
  return null;
}

export async function resolveSeriesAsync(item, lookupById) {
  const source = reference(item);
  if (source.resolved) return source.value;
  if (source.explicit) return asSeries(await lookupById(source.id));
  let parentId = source.id;
  const visited = new Set();
  while (nonempty(parentId) && !visited.has(key(parentId))) {
    visited.add(key(parentId));
    const parent = await lookupById(parentId);
    if (!parent) return null;
    if (type(parent) === 'Series') return parent;
    parentId = parent.ParentId;
  }
  return null;
}
