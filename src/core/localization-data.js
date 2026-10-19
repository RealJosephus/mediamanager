import { readFile, readdir } from 'node:fs/promises';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';

const unratedValues = ['n/a', 'unrated', 'not rated', 'nr'];
const present = value => value !== null && value !== undefined && value !== '';

function tryParseRatingAsScore(value) {
  // Int32.TryParse(NumberStyles.Integer) accepts U+0009..000D and U+0020
  // around a sign and digits. Jellyfin removes every trailing '+' before calling it.
  const candidate = value.replace(/\++$/u, '').replace(/\0+$/u, '');
  if (!/^[\x09-\x0d\x20]*[+-]?[0-9]+[\x09-\x0d\x20]*$/u.test(candidate)) return null;
  let parsed;
  try { parsed = BigInt(candidate); }
  catch { return null; }
  return parsed >= -2147483648n && parsed <= 2147483647n ? Number(parsed) : null;
}

function createRatingResolver({ ratingSystems, cultures }, defaultCountry = 'US') {
  const systems = new Map(ratingSystems.map(system => [ordinalIgnoreCaseKey(system.countryCode), system]));
  const system = country => systems.get(ordinalIgnoreCaseKey(country));
  const lookup = (dictionary, rating) => dictionary.get(ordinalIgnoreCaseKey(rating));
  const isUnrated = rating => unratedValues.some(value => ordinalIgnoreCaseEquals(value, clrTrim(rating)));
  const findLanguage = language => cultures.find(culture => ordinalIgnoreCaseEquals(language, culture.DisplayName)
    || ordinalIgnoreCaseEquals(language, culture.Name)
    || culture.ThreeLetterISOLanguageNames.some(value => ordinalIgnoreCaseEquals(language, value))
    || ordinalIgnoreCaseEquals(language, culture.TwoLetterISOLanguageName));

  const resolve = (rating, countryCode) => {
    const numeric = tryParseRatingAsScore(rating);
    if (numeric !== null) return { score: numeric, subScore: null };
    rating = clrTrim(ordinalIgnoreCaseKey(rating).replaceAll('RATED :', '').replaceAll('RATED:', '').replaceAll('RATED ', ''));
    const selectedCountry = present(countryCode) ? countryCode : defaultCountry;
    // The native dictionary lookup is reached after numeric and unrated early
    // returns. An explicitly null server country cannot be a dictionary key.
    if (selectedCountry == null) throw Object.assign(new TypeError("Value cannot be null. (Parameter 'key')"),
      { nativeException: 'ArgumentNullException', parameterName: 'key' });
    const selected = system(selectedCountry);
    if (selected) {
      const direct = lookup(selected.values, rating);
      if (direct !== undefined) return direct;
      const countryText = String(countryCode ?? defaultCountry);
      if (present(countryCode) && rating.length > countryText.length
        && ordinalIgnoreCaseEquals(rating.slice(0, countryText.length), countryText)
        && ['-', ':'].includes(rating[countryText.length])) {
        const normalized = lookup(selected.values, clrTrim(rating.slice(countryText.length + 1)));
        if (normalized !== undefined) return normalized;
      }
    }
    const us = system('us');
    const usValue = us && lookup(us.values, rating);
    if (usValue !== undefined) return usValue;
    for (const candidate of ratingSystems) {
      const value = lookup(candidate.values, rating);
      if (value !== undefined) return value;
    }
    for (const separator of [':', '-']) {
      if (!rating.includes(separator)) continue;
      const countryPart = clrTrim(rating.slice(0, rating.indexOf(separator)));
      const ratingPart = clrTrim(rating.slice(rating.lastIndexOf(separator) + 1));
      if (!ratingPart) continue;
      const resolvedCountry = system(countryPart)?.countryCode ?? findLanguage(countryPart)?.TwoLetterISOLanguageName;
      const countrySystem = resolvedCountry != null ? system(resolvedCountry) : undefined;
      if (countrySystem) {
        const value = lookup(countrySystem.values, ratingPart);
        if (value !== undefined) return value;
        const separatedNumeric = tryParseRatingAsScore(ratingPart);
        if (separatedNumeric !== null) return { score: separatedNumeric, subScore: null };
        // A recognized system prefix owns the value. Unknown and explicitly
        // unrated suffixes are both handled as unrated, without another fallback.
        return null;
      }
      return getRatingScore(ratingPart, resolvedCountry);
    }
    return null;
  };

  function getRatingScore(rating, countryCode) {
    if (rating === null || rating === undefined || rating === '') throw new TypeError('Rating must not be empty.');
    rating = String(rating);
    if (isUnrated(rating)) return null;
    const whole = resolve(rating, countryCode);
    if (whole !== null) return structuredClone(whole);
    const parts = rating.split('/').map(clrTrim).filter(Boolean);
    if (parts.length === 1) return null;
    for (const part of parts) {
      if (isUnrated(part)) continue;
      const value = resolve(part, countryCode);
      if (value !== null) return structuredClone(value);
    }
    return null;
  }
  return getRatingScore;
}

async function createLocalizationData() {
  const resource = new URL('./resources/', import.meta.url);
  const countries = JSON.parse(await readFile(new URL('countries.json', resource), 'utf8'));
  const cultures = (await readFile(new URL('iso6392.txt', resource), 'utf8')).split(/\r?\n/).filter(line=>line.trim()).flatMap(line=>{
    const parts = line.split('|');
    if (parts.length !== 5) throw new Error('Invalid ISO culture resource.');
    if (!parts[3].trim()) return [];
    const twoLetter = parts[2].trim() ? parts[2] : '';
    const threeLetter = parts[1].trim() ? [parts[0],parts[1]] : [parts[0]];
    return [{Name:twoLetter.includes('-')?twoLetter:parts[3],DisplayName:parts[3],TwoLetterISOLanguageName:twoLetter,
      ThreeLetterISOLanguageName:threeLetter[0],ThreeLetterISOLanguageNames:threeLetter}];
  });
  const ratings = new Map();
  const ratingSystems = [];
  const ratingsRoot = new URL('ratings/', resource);
  for (const file of (await readdir(ratingsRoot)).sort()) {
    const system = JSON.parse(await readFile(new URL(file, ratingsRoot), 'utf8'));
    const values = new Map();
    for (const entry of system.ratings ?? []) for (const name of entry.ratingStrings) {
      const key = ordinalIgnoreCaseKey(name), previous = values.get(key);
      values.set(key, { Name: previous?.Name ?? name, RatingScore: entry.ratingScore, Value: entry.ratingScore?.score ?? null });
    }
    ratings.set(ordinalIgnoreCaseKey(system.countryCode), [...values.values()]);
    ratingSystems.push({ countryCode: system.countryCode, values: new Map([...values].map(([key, value]) => [key, value.RatingScore])) });
  }
  const resolvers = new Map();
  const resolverSystems = {};
  const resolverOrder = [];
  for (const system of ratingSystems) {
    const country = ordinalIgnoreCaseKey(system.countryCode);
    resolverOrder.push(country);
    resolverSystems[country] = Object.fromEntries([...system.values]
      .map(([name, score]) => [name, [score.score, score.subScore]]));
  }
  const resolverLanguages = {};
  for (const culture of cultures) {
    const aliases = [culture.DisplayName, culture.Name,
      ...culture.ThreeLetterISOLanguageNames, culture.TwoLetterISOLanguageName];
    for (const alias of aliases) {
      const key = ordinalIgnoreCaseKey(alias);
      // findLanguage returns the first culture in the frozen resource order.
      if (!Object.hasOwn(resolverLanguages, key)) {
        resolverLanguages[key] = ordinalIgnoreCaseKey(culture.TwoLetterISOLanguageName);
      }
    }
  }
  const parentalRatingResolverData = Object.freeze({
    systems: Object.freeze(resolverSystems),
    order: Object.freeze(resolverOrder),
    languages: Object.freeze(resolverLanguages),
  });
  const resolver = country => {
    const key = country == null ? country : ordinalIgnoreCaseKey(country);
    if (!resolvers.has(key)) resolvers.set(key, createRatingResolver({ ratingSystems, cultures }, country));
    return resolvers.get(key);
  };
  return {
    countries,
    findLanguage(language) {
      if (language == null || language === '') return null;
      return cultures.find(culture => ordinalIgnoreCaseEquals(language, culture.DisplayName)
        || ordinalIgnoreCaseEquals(language, culture.Name)
        || culture.ThreeLetterISOLanguageNames.some(name => ordinalIgnoreCaseEquals(language, name))
        || ordinalIgnoreCaseEquals(language, culture.TwoLetterISOLanguageName)) ?? null;
    },
    cultures(culture = 'en-US') {
      const unique = new Map();
      for (const item of cultures) if (!unique.has(item.DisplayName.toLowerCase())) unique.set(item.DisplayName.toLowerCase(), item);
      const collator = new Intl.Collator(culture);
      return [...unique.values()].sort((a,b)=>collator.compare(a.DisplayName,b.DisplayName));
    },
    options: [{Name:'English',Value:'en-US'}],
    parentalRatings(country = 'US') {
      const values = structuredClone(ratings.get(ordinalIgnoreCaseKey(country)) ?? []);
      values.push({Name:'Unrated',Value:null,RatingScore:null});
      for (const [name,score] of [['Approved',0],['10',10],['13',13],['14',14],['21',21],['XXX',1000],['Banned',1001]]) {
        const exists = score === 21 ? values.some(value=>value.Value >= 21) : values.some(value=>value.Value===score);
        if (!exists) values.push({Name:name,Value:score,RatingScore:{score,subScore:null}});
      }
      return values.sort((a,b)=> (a.Value ?? -Infinity)-(b.Value ?? -Infinity) ||
        (a.RatingScore?.subScore ?? -Infinity)-(b.RatingScore?.subScore ?? -Infinity));
    },
    ratingScore(rating, countryCode, defaultCountry = 'US') {
      return resolver(defaultCountry)(rating, countryCode);
    },
    parentalRatingResolverData() {
      return parentalRatingResolverData;
    },
  };
}

// Resource loading is shared by HTTP and library code. Top-level initialization
// makes the rating resolver authoritative even for standalone LibraryService
// instances instead of silently falling back to stored development-era values.
const localizationData = await createLocalizationData();

export function loadLocalizationData() { return localizationData; }
export const getRatingScore = (rating, countryCode, defaultCountry) => localizationData.ratingScore(rating, countryCode, defaultCountry);
