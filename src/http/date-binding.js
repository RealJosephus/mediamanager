import { BindingError } from './binding.js';
import { parseLegacyPlayedDateValue } from '../core/invariant-date-parse.js';

export function parsePlayedDate(query, { name = 'datePlayed', now = new Date(), offsetMinutes } = {}) {
  const values = query instanceof URLSearchParams ? [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value) : Array.isArray(query) ? query : query == null ? [] : [query];
  // LegacyDateTimeModelBinder intentionally does not bind repeated values.
  if (values.length !== 1) return undefined;
  const raw = values[0], result = parseLegacyPlayedDateValue(raw, { now, offsetMinutes });
  if (result !== null) return result;
  throw new BindingError(name, `The value '${raw}' is not valid.`);
}
