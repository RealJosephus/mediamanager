import patterns from './episode-patterns.json' with { type: 'json' };
import { nativeFileName, nativeFileNameWithoutExtension } from '../library/native-path.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { clrWhitespace, clrTrim } from './whitespace.js';
import { calendarDateToUtc } from './calendar-date.js';

function compile(source) {
  let result = '', inClass = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      const token = source[++index];
      const replacement = token === 'w' ? patterns.RegexWordCharacters : token === 's' ? clrWhitespace : null;
      result += replacement == null ? '\\' + token : inClass ? replacement : `[${replacement}]`;
    } else if (character === '[' && !inClass) {
      inClass = true; result += '[';
      // CLR accepts an initial literal closing bracket in a character class.
      if (source[index + 1] === ']') { result += '\\]'; index++; }
    } else if (character === ']') { inClass = false; result += character; }
    else if (character === '.' && !inClass) result += '[^\\n]';
    else if (character === '$' && !inClass) result += '(?=\\n?(?![^]))';
    else result += character;
  }
  // CLR regexes consume UTF-16 code units. The sealed BMP word character
  // ranges avoid adding supplementary letters to native \w matches.
  return new RegExp(result, 'id');
}
const expressions = patterns.EpisodeExpressions.map(value => ({ ...value, regex: compile(value.Expression) }));
const additional = patterns.MultipleEpisodeExpressions.filter(value => value.IsNamed).map(value => ({ ...value, regex: compile(value.Expression) }));
const int32 = value => {
  if (value == null || !/^[+-]?[0-9]+$/u.test(clrTrim(value))) return null;
  const result = Number(value);
  return Number.isInteger(result) && result >= -2147483648 && result <= 2147483647 ? result : null;
};
const extension = value => {
  const name = nativeFileName(value);
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? '' : name.slice(dot);
};

function parseExpression(path, expression) {
  const result = { EpisodeNumber: null, EndingEpisodeNumber: null, SeasonNumber: null, SeriesName: null,
    IsByDate: false, Year: null, Month: null, Day: null, Success: false };
  const name = expression.IsByDate ? path.replaceAll('_', '-') : path;
  const match = expression.regex.exec(name);
  if (!match || match.length < 3) return result;
  if (expression.IsByDate) {
    // TryParseExact requires both separators to agree. A failed date still
    // counts as a successful by-date match in the pinned native parser.
    const { year, month, day } = match.groups;
    const separator = match[0].match(/[._ -]/u)?.[0];
    const format = expression.DateTimeFormats.find(format => format === (match[0].startsWith(year)
      ? `yyyy${separator}MM${separator}dd` : `dd${separator}MM${separator}yyyy`));
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day)); date.setUTCHours(0, 0, 0, 0);
    if (format && match[0].split(separator).length === 3 && Number(year) >= 1
      && date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day)) {
      Object.assign(result, { Year: Number(year), Month: Number(month), Day: Number(day) });
    }
    result.Success = true;
  } else if (expression.IsNamed) {
    result.SeasonNumber = int32(match.groups?.seasonnumber);
    result.EpisodeNumber = int32(match.groups?.epnumber);
    const ending = match.groups?.endingepnumber;
    if (ending != null) {
      const next = name[match.indices.groups.endingepnumber[1]], number = int32(ending);
      if ((next == null || !'0123456789iIpP'.includes(next)) && number != null && result.EpisodeNumber != null && number >= result.EpisodeNumber) result.EndingEpisodeNumber = number;
    }
    result.SeriesName = match.groups?.seriesname ?? '';
    result.Success = result.EpisodeNumber != null;
  } else {
    result.SeasonNumber = int32(match[1]); result.EpisodeNumber = int32(match[2]);
    result.Success = result.EpisodeNumber != null;
  }
  if (result.SeasonNumber >= 200 && result.SeasonNumber < 1928 || result.SeasonNumber > 2500) result.Success = false;
  result.IsByDate = expression.IsByDate;
  return result;
}

export function resolveEpisodePath(path, { directory = false, named, optimistic, absolute } = {}) {
  let Container = null, IsStub = false, StubType = null;
  if (!directory) {
    const suffix = extension(path);
    if (!patterns.VideoFileExtensions.some(value => ordinalIgnoreCaseEquals(value, suffix))) {
      if (!path || !patterns.StubFileExtensions.some(value => ordinalIgnoreCaseEquals(value, suffix))) return null;
      IsStub = true;
      const token = extension(nativeFileNameWithoutExtension(path)).replace(/^\.+/u, '');
      StubType = patterns.StubTypes.find(value => ordinalIgnoreCaseEquals(value.Token, token))?.StubType ?? null;
    }
    Container = suffix.replace(/^\.+/u, '');
  }
  const name = directory ? (path ?? '') + '.mp4' : path;
  let parsed;
  for (const expression of expressions) {
    if (absolute != null && expression.SupportsAbsoluteEpisodeNumbers !== absolute
      || named != null && expression.IsNamed !== named || optimistic != null && expression.IsOptimistic !== optimistic) continue;
    const result = parseExpression(name, expression);
    if (result.Success) { parsed = result; break; }
  }
  if (!parsed && !IsStub) return null;
  if (parsed) {
    const extended = parsed.SeriesName ? additional : [...expressions.filter(value => value.IsNamed), ...additional];
    for (const expression of extended) {
      const result = parseExpression(name, expression);
      if (!result.Success) continue;
      if (!parsed.SeriesName) parsed.SeriesName = result.SeriesName;
      if (parsed.EndingEpisodeNumber == null && result.EndingEpisodeNumber != null && parsed.EpisodeNumber != null && result.EndingEpisodeNumber >= parsed.EpisodeNumber) parsed.EndingEpisodeNumber = result.EndingEpisodeNumber;
      if (parsed.SeriesName && (parsed.EpisodeNumber == null || parsed.EndingEpisodeNumber != null)) break;
    }
    if (parsed.SeriesName) parsed.SeriesName = clrTrim(clrTrim(parsed.SeriesName).replace(/^[_\.\-]+|[_\.\-]+$/gu, ''));
  }
  const { Success, ...fields } = parsed ?? { EpisodeNumber: null, EndingEpisodeNumber: null, SeasonNumber: null,
    SeriesName: null, IsByDate: false, Year: null, Month: null, Day: null };
  return { Container, IsStub, StubType, ...fields };
}

export function fillMissingEpisodeNumbersFromPath(item, loaded = {}, replaceAllMetadata = false) {
  const series = loaded.resolveSeries ? loaded.resolveSeries(item) : loaded.series;
  const absolute = series && ordinalIgnoreCaseEquals(series.DisplayOrder, 'absolute') ? true : undefined;
  let parsed = null;
  if (item.IsFileProtocol) {
    parsed = resolveEpisodePath(item.Path, { directory: ['Dvd', 'BluRay', 2, 3].includes(item.VideoType), absolute });
    if (!parsed) {
      const parent = loaded.parent;
      if (!parent) throw new Error('The episode parent is absent during filename resolution.');
      if (parent.Type === 'Folder') parsed = resolveEpisodePath(parent.Path, { directory: true, absolute });
    }
  }
  if (!parsed) return false;
  let changed = false;
  const assign = (field, value) => { if ((item[field] ?? null) !== value) changed = true; item[field] = value; };
  if (parsed.IsByDate) {
    if (item.IndexNumber != null) assign('IndexNumber', null);
    if (item.IndexNumberEnd != null) assign('IndexNumberEnd', null);
    if (item.PremiereDate == null && parsed.Year != null && parsed.Month != null && parsed.Day != null) {
      assign('PremiereDate', calendarDateToUtc(parsed.Year, parsed.Month, parsed.Day));
    }
    if (item.ProductionYear == null && parsed.Year != null) assign('ProductionYear', parsed.Year);
  } else {
    for (const [field, value] of [['IndexNumber', parsed.EpisodeNumber], ['IndexNumberEnd', parsed.EndingEpisodeNumber], ['ParentIndexNumber', parsed.SeasonNumber]]) {
      if (item[field] == null || replaceAllMetadata) assign(field, value);
    }
  }
  if (item.ParentIndexNumber == null) {
    const season = loaded.resolveSeason ? loaded.resolveSeason(item) : loaded.season;
    if (season?.IndexNumber != null) assign('ParentIndexNumber', season.IndexNumber);
  }
  return changed;
}
