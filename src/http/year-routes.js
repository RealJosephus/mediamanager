import { BindingError, booleanValue, guidValue, integerValue, notFound, queryValue } from './binding.js';
import { enumName, itemKinds, mediaTypes } from '../sessions/binding.js';
import { itemImageTypes } from '../library/dto.js';
import { controllerItemFields } from './item-fields.js';

function commaEnums(query, name, names) {
  const values = [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
  return entries.flatMap(value => {
    try { return [String(enumName(value.trim(), names))]; } catch { return []; }
  });
}

function bindList(context, sortNames) {
  const errors = {}, value = name => queryValue(context.query, name);
  const read = (reader, name, fallback) => {
    try { return reader(value(name), name, fallback); }
    catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  };
  const input = {
    startIndex: read(integerValue, 'startIndex'), limit: read(integerValue, 'limit'),
    parentId: read(guidValue, 'parentId'), recursive: read(booleanValue, 'recursive', true),
    fields: commaEnums(context.query, 'fields', controllerItemFields),
    includeItemTypes: commaEnums(context.query, 'includeItemTypes', itemKinds),
    excludeItemTypes: commaEnums(context.query, 'excludeItemTypes', itemKinds),
    mediaTypes: commaEnums(context.query, 'mediaTypes', mediaTypes),
    sortBy: commaEnums(context.query, 'sortBy', sortNames),
    sortOrder: commaEnums(context.query, 'sortOrder', ['Ascending', 'Descending']),
    enableuserdata: read(booleanValue, 'enableUserData'), enableimages: read(booleanValue, 'enableImages', true),
    imagetypelimit: read(integerValue, 'imageTypeLimit'), enableimagetypes: commaEnums(context.query, 'enableImageTypes', itemImageTypes),
  };
  if (!input.enableimagetypes.length) delete input.enableimagetypes;
  read(guidValue, 'userId');
  if (Object.keys(errors).length) { const error = new BindingError('', ''); error.errors = errors; throw error; }
  return input;
}

/** Register the scoped list and the independent by-name detail action. */
export function registerYearRoutes(add, { library, users }, { optionalRequestUserId, sortNames }) {
  add('GET', '/Years', async context => {
    const input = bindList(context, sortNames), userId = optionalRequestUserId(context);
    const hasUser = Boolean(userId && !/^0{32}$/u.test(userId));
    const user = hasUser ? await users.getUser(userId) : null;
    return library.queryYears(input, { user, hasUser, signal: context.request?.signal });
  });
  add('GET', '/Years/{year}', async context => {
    const year = integerValue(context.params.year, 'year');
    const userId = optionalRequestUserId(context);
    return await library.getYearDto(year, { resolveUser: userId && !/^0{32}$/u.test(userId)
      ? () => users.getUser(userId) : undefined }) ?? notFound();
  });
}
