import patterns from './naming-patterns.json' with { type: 'json' };
import { clrWhitespace as whitespace, clrTrim, clrTrimEnd } from './whitespace.js';

const compile = source => new RegExp(source.replaceAll('\\,', ',').replaceAll('[^\\s]', `[^${whitespace}]`).replaceAll('\\s', `[${whitespace}]`)
  .replaceAll('\\w', '[\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}]').replaceAll('\\W', '[^\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}]'), 'iu');
const dates = patterns.CleanDateTimes.map(compile), strings = patterns.CleanStrings.map(compile);

export function cleanMetadataName(name) {
  if (!name) return name;
  let result = name;
  for (const pattern of strings) {
    const match = pattern.exec(result);
    if (match?.groups && Object.hasOwn(match.groups, 'cleaned')) result = clrTrim(match.groups.cleaned);
  }
  return result;
}

export function parseMetadataName(name) {
  let Name = name, Year = null;
  if (!name) return { Name, Year };
  for (const pattern of dates) {
    const match = pattern.exec(name);
    if (match?.length === 5 && match[1] != null && match[2] != null) { Name = clrTrimEnd(match[1]); Year = Number(match[2]); break; }
  }
  return { Name: cleanMetadataName(Name), Year };
}
