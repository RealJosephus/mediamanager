import { BindingError, booleanValue, guidValue, integerValue, queryValue } from './binding.js';
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

export function registerSuggestionsRoutes(add, { library }, { optionalRequestUser }) {
  add('GET', ['/Items/Suggestions', '/Users/{userId}/Suggestions'], async context => {
    const { userId, input } = bind(context);
    const user = await optionalRequestUser(context, userId);
    return library.querySuggestions(input, { user, signal: context.signal });
  }, { abortOnDisconnect: true });
}
