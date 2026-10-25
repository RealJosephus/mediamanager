import { createHash } from 'node:crypto';
import { formatInvariantDate } from '@mediamanager/plugin-sdk/core/invariant-date-format';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
import { dateTicks, MIN_DATE } from '@mediamanager/plugin-sdk/library/records';

export const xmlTvEtagPrefix = 'xmltv-sha256-v1:';
export const isNativeXmlTvEtag = value => typeof value === 'string' && !!clrTrim(value) && value.startsWith(xmlTvEtagPrefix);
export const nativeXmlTvEtagMatchesStored = (incoming, stored) => isNativeXmlTvEtag(incoming) && ordinalIgnoreCaseEquals(incoming, stored);

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const utcDate = value => formatInvariantDate(value ?? MIN_DATE, 'O');
const audioNames = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'];

// .NET Single "R" uses the shortest decimal which round-trips to binary32.
// Its fixed/exponent cutover uses the nine-digit round-trip precision.
function singleRoundTrip(value) {
  const single = Math.fround(value);
  if (Number.isNaN(single)) return 'NaN';
  if (!Number.isFinite(single)) return single < 0 ? '-Infinity' : 'Infinity';
  if (Object.is(single, -0)) return '-0';
  if (single === 0) return '0';
  const bits = new Uint32Array(new Float32Array([single]).buffer)[0];
  const exponent = ((bits >>> 23) & 255) - 127 - 23;
  const significand = BigInt((bits & 0x7fffff) | (exponent === -150 ? 0 : 0x800000));
  const binaryExponent = exponent === -150 ? -149 : exponent;
  const numerator = binaryExponent >= 0 ? significand << BigInt(binaryExponent) : significand;
  const denominator = binaryExponent < 0 ? 1n << BigInt(-binaryExponent) : 1n;
  let decimal;
  for (let precision = 1; precision <= 9; precision++) {
    const decimalExponent = Math.floor(Math.log10(Math.abs(single))) - precision + 1;
    const scaledNumerator = decimalExponent < 0 ? numerator * 10n ** BigInt(-decimalExponent) : numerator;
    const scaledDenominator = decimalExponent > 0 ? denominator * 10n ** BigInt(decimalExponent) : denominator;
    let digits = scaledNumerator / scaledDenominator;
    const remainder = scaledNumerator % scaledDenominator;
    if (remainder * 2n > scaledDenominator || remainder * 2n === scaledDenominator && digits % 2n !== 0n) digits++;
    const candidate = Number(`${single < 0 ? '-' : ''}${digits}e${decimalExponent}`);
    if (Math.fround(candidate) === single) { decimal = candidate; break; }
  }
  decimal ??= single;
  const scientific = decimal.toExponential(), [, sign, digits, fraction = '', rawExponent] = /^(-?)(\d)(?:\.(\d+))?e([+-]?\d+)$/u.exec(scientific);
  const power = Number(rawExponent);
  if (power >= -4 && power < 9) return String(decimal);
  return `${sign}${digits}${fraction ? '.' + fraction : ''}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
}

/** The designated XmlTvProgramEtag's mapped ProgramInfo fingerprint. */
export function nativeXmlTvProgramEtag(info) {
  if (typeof info.Id !== 'string' || !clrTrim(info.Id)) return { etag: null, reason: 'program id is empty' };
  if (typeof info.ChannelId !== 'string' || !clrTrim(info.ChannelId)) return { etag: null, reason: 'channel id is empty' };
  const start = utcDate(info.StartDate), end = utcDate(info.EndDate);
  if (dateTicks(start) === 0n) return { etag: null, reason: 'start date is empty' };
  if (dateTicks(end) === 0n) return { etag: null, reason: 'end date is empty' };
  if (dateTicks(end) <= dateTicks(start)) return { etag: null, reason: 'end date is not after start date' };
  const parts = [];
  const append = (name, value) => parts.push(`${name}|${value == null ? 'N|0|' : 'S|' + String(value).length + '|' + value}\n`);
  append('schema', 'xmltv-programinfo-v1');
  for (const name of ['Id', 'ChannelId', 'Name', 'OfficialRating', 'Overview']) append(name, info[name]);
  append('StartDate', start); append('EndDate', end);
  const genres = info.Genres === undefined ? [] : info.Genres;
  append('Genres.Count', String(genres.length));
  for (const [index, value] of genres.entries()) append(`Genres[${index}]`, value);
  append('OriginalAirDate', info.OriginalAirDate == null ? null : utcDate(info.OriginalAirDate));
  append('IsHD', info.IsHD == null ? null : info.IsHD ? 'true' : 'false');
  append('Audio', info.Audio == null ? null : typeof info.Audio === 'number' ? audioNames[info.Audio] ?? String(info.Audio) : String(info.Audio));
  append('CommunityRating', info.CommunityRating == null ? null : singleRoundTrip(info.CommunityRating));
  append('IsRepeat', info.IsRepeat ? 'true' : 'false');
  for (const name of ['EpisodeTitle', 'ImagePath', 'ImageUrl', 'ThumbImageUrl', 'LogoImageUrl', 'BackdropImageUrl']) append(name, info[name]);
  for (const name of ['IsMovie', 'IsSports', 'IsSeries', 'IsLive', 'IsNews', 'IsKids', 'IsPremiere']) append(name, info[name] ? 'true' : 'false');
  for (const name of ['ProductionYear', 'SeriesId', 'ShowId', 'SeasonNumber', 'EpisodeNumber']) append(name, info[name] == null ? null : String(info[name]));
  for (const name of ['ProviderIds', 'SeriesProviderIds']) {
    const dictionary = info[name] === undefined ? {} : info[name];
    const entries = dictionary instanceof Map ? [...dictionary] : Object.entries(dictionary);
    entries.sort(([left], [right]) => compare(ordinalIgnoreCaseKey(left), ordinalIgnoreCaseKey(right)) || compare(left, right));
    append(name + '.Count', String(entries.length));
    for (const [index, [key, value]] of entries.entries()) {
      append(`${name}[${index}].Key`, key); append(`${name}[${index}].Value`, value);
    }
  }
  return { etag: xmlTvEtagPrefix + createHash('sha256').update(parts.join(''), 'utf8').digest('hex').toUpperCase(), reason: null };
}
