import { BindingError, commaGuidValues, guidValue, httpError, integerValue, queryValue } from './binding.js';
import { controllerItemFields } from './item-fields.js';
import { enumName } from '../sessions/binding.js';
import { clrTrim } from '../metadata/whitespace.js';

const empty = '0'.repeat(32);
const filterNames = ['', 'IsFolder', 'IsNotFolder', 'IsUnplayed', 'IsPlayed', 'IsFavorite', '', 'IsResumable', 'Likes', 'Dislikes', 'IsFavoriteOrLikes'];
function enums(query, name, names) {
  const values = [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
  return entries.flatMap(value => { try { return [enumName(clrTrim(value), names)]; } catch { return []; } });
}
function bind(context, latest) {
  const result = {}, errors = {}; let failure;
  const nullable = name => { const value = queryValue(context.query, name); return value == null || clrTrim(value) === '' ? undefined : value; };
  const readers = { UserId: () => guidValue(nullable('userId'), 'userId', context.auth.UserId),
    StartIndex: () => integerValue(nullable('startIndex'), 'startIndex'), Limit: () => integerValue(nullable('limit'), 'limit') };
  if (!latest) Object.assign(readers, { channelId: () => guidValue(context.params.channelId, 'channelId'),
    ParentId: () => guidValue(nullable('folderId'), 'folderId', empty) });
  for (const [name, read] of Object.entries(readers)) {
    try { result[name] = read(); }
    catch (error) { if (!(error instanceof BindingError)) throw error; failure ??= error; Object.assign(errors, error.errors); }
  }
  if (failure) { failure.errors = errors; throw failure; }
  if (!result.UserId || result.UserId === empty) result.UserId = context.auth.UserId ?? empty;
  if (result.UserId !== empty && result.UserId !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
  return result;
}
function filters(query, values) {
  const mappings = { IsFolder: ['IsFolder', true], IsNotFolder: ['IsFolder', false], IsUnplayed: ['IsPlayed', false],
    IsPlayed: ['IsPlayed', true], IsFavorite: ['IsFavorite', true], IsResumable: ['IsResumable', true],
    Likes: ['IsLiked', true], Dislikes: ['IsLiked', false], IsFavoriteOrLikes: ['IsFavoriteOrLiked', true] };
  for (const pair of [['IsFolder', 'IsNotFolder'], ['IsUnplayed', 'IsPlayed'], ['Likes', 'Dislikes']]) {
    if (pair.every(value => values.includes(value))) throw Object.assign(httpError(400, "Conflicting filters (Parameter 'filters')"), { nativeException: 'ArgumentException' });
  }
  for (const value of values) if (mappings[value]) query[mappings[value][0]] = mappings[value][1];
}
export function registerChannelItemRoutes(add, { channels, users }, { sortNames }) {
  for (const latest of [false, true]) add('GET', latest ? '/Channels/Items/Latest' : '/Channels/{channelId}/Items', async context => {
    const input = bind(context, latest);
    // Controller user lookup precedes GetOrderBy and ApplyFilters. Preserve
    // its null result so the service does not perform a second lookup.
    input.User = input.UserId === empty ? null : await users.getUser(input.UserId);
    input.Fields = enums(context.query, 'fields', controllerItemFields).filter(value => typeof value === 'string');
    input.ChannelIds = latest ? commaGuidValues(context.query, 'channelIds') : [input.channelId]; delete input.channelId;
    if (!latest) {
      const sortBy = enums(context.query, 'sortBy', sortNames), sortOrder = enums(context.query, 'sortOrder', ['Ascending', 'Descending']);
      // GetOrderBy reads sortBy through IReadOnlyList before assigning its
      // result array. Excess explicit orders fail at that collection index.
      if (sortBy.length && sortOrder.length > sortBy.length) throw Object.assign(httpError(400,
        "Index was out of range. Must be non-negative and less than the size of the collection. (Parameter 'index')"), { nativeException: 'ArgumentOutOfRangeException' });
      input.OrderBy = sortBy.map((field, index) => [field, sortOrder[index] ?? sortOrder[0] ?? 'Ascending']);
    }
    filters(input, enums(context.query, 'filters', filterNames));
    return latest ? channels.getLatestChannelItems(input) : channels.getChannelItems(input);
  });
}
