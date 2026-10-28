import { BindingError, booleanValue, guidValue, httpError } from './binding.js';
import { parseInvariantDate } from '../core/invariant-date-parse.js';
import { clrTrim } from '../metadata/whitespace.js';

const booleans = `hasThemeSong hasThemeVideo hasSubtitles hasSpecialFeature hasTrailer hasParentalRating isHd is4K
  isMissing isUnaired hasOverview hasImdbId hasTmdbId hasTvdbId isMovie isSeries isNews isKids isSports recursive
  isFavorite isPlayed enableUserData isLocked isPlaceHolder hasOfficialRating collapseBoxSetItems is3D
  enableTotalRecordCount enableImages`.split(/\s+/u);
const integers = `parentIndexNumber startIndex limit imageTypeLimit minWidth minHeight maxWidth maxHeight`.split(' ');
const doubles = ['minCommunityRating', 'minCriticRating'];
const dates = ['minPremiereDate', 'minDateLastSaved', 'minDateLastSavedForUser', 'maxPremiereDate'];
const guids = ['userId', 'adjacentTo', 'parentId'];

export function bindTrailerQuery(query) {
  // A collection conversion failure escapes MVC model-state handling even
  // though the action never consumes the successfully bound collection.
  const years = [...query].filter(([name]) => name.toLowerCase() === 'years').map(([, value]) => value);
  for (const entry of years.length > 1 ? years : years[0]?.split(',').filter(value => value !== '') ?? []) {
    const value = clrTrim(entry), hex = /^(?:0x|#|&h)([0-9a-f]+)$/iu.exec(value);
    const number = hex ? BigInt('0x' + hex[1]) : /^[+-]?\d+$/u.test(value) ? BigInt(value) : null;
    if (number === null || (hex ? number > 0xffffffffn : number < -2147483648n || number > 2147483647n)) {
      throw httpError(400, 'Error processing request.');
    }
  }
  const errors = {};
  const bind = (names, valid) => {
    for (const name of names) {
      const values = [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
      if (!values.length) continue;
      const value = clrTrim(values[0]), attempted = values.join(',');
      if (!value && name !== 'enableTotalRecordCount') continue;
      if (!value || !valid(value)) errors[name] = [`The value '${attempted}' is ${value ? 'not valid' : 'invalid'}.`];
    }
  };
  bind(booleans, value => { try { booleanValue(value, 'value'); return true; } catch { return false; } });
  bind(integers, value => /^[+-]?\d+$/u.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647);
  bind(doubles, value => /^[+-]?(?:NaN|Infinity)$/iu.test(value)
    || /^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value));
  bind(dates, value => parseInvariantDate(value) !== null);
  bind(guids, value => { try { guidValue(value, 'value'); return true; } catch { return false; } });
  if (Object.keys(errors).length) {
    const failure = new BindingError('', 'One or more validation errors occurred.'); failure.errors = errors; throw failure;
  }
  return {};
}

export function registerTrailerRoutes(add) {
  add('GET', '/Trailers', () => {
    // The designated action fails after MVC binding and before any library read.
    // Keep its public response boundary without recreating CLR controller state.
    throw new Error('Trailer listing could not be completed.');
  }, { bindQuery: bindTrailerQuery });
}
