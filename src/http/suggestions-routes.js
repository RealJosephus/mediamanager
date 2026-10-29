import { BindingError, booleanValue, guidValue, httpError, integerValue, queryValue } from './binding.js';
import { enumName, itemKinds, mediaTypes } from '../sessions/binding.js';

function commaEnums(query, name, names) {
  const values = [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
  return entries.flatMap(value => {
    try { return [String(enumName(value.trim(), names))]; }
    catch { return []; }
  });
}

function bind(context) {
  const errors = {}, value = name => queryValue(context.query, name);
  const read = (reader, supplied, name, fallback) => {
    try { return reader(supplied, name, fallback); }
    catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  };
  const userId = read(guidValue, context.params.userId ?? value('userId'), 'userId');
  const input = {
    mediaTypes: commaEnums(context.query, 'mediaType', mediaTypes),
    itemTypes: commaEnums(context.query, 'type', itemKinds),
    startIndex: read(integerValue, value('startIndex'), 'startIndex'),
    limit: read(integerValue, value('limit'), 'limit'),
    enableTotalRecordCount: read(booleanValue, value('enableTotalRecordCount'), 'enableTotalRecordCount', false),
  };
  if (Object.keys(errors).length) { const error = new BindingError('', ''); error.errors = errors; throw error; }
  return { userId, input };
}

/** SuggestionsController deliberately does not substitute the authenticated
 * user when the optional selector is absent or Guid.Empty. */
export function registerSuggestionsRoutes(add, { library, users }) {
  add('GET', ['/Items/Suggestions', '/Users/{userId}/Suggestions'], async context => {
    const { userId, input } = bind(context);
    let user = null;
    if (userId && !/^0{32}$/u.test(userId)) {
      if (userId !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
      user = await users.getUser(userId);
    }
    return library.querySuggestions(input, { user, signal: context.request?.signal });
  });
}
