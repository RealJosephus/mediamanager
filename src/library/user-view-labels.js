import { readFileSync } from 'node:fs';

const labels = JSON.parse(readFileSync(new URL('./resources/user-view-labels.json', import.meta.url), 'utf8'));
const dictionaries = new Map(Object.entries(labels).map(([culture, values]) => [culture.toLowerCase(),
  new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]))]));
const bcp47Names = new Map(Object.keys(labels).map(culture => [culture.replaceAll('_', '-').toLowerCase(), culture.toLowerCase()]));
export function userViewLabel(key, { configuration = {} } = {}) {
  const culture = (configuration.UICulture || 'en-US').toLowerCase();
  const dictionary = dictionaries.get(bcp47Names.get(culture) ?? culture);
  return dictionary?.get(key.toLowerCase()) ?? dictionaries.get('en-us').get(key.toLowerCase()) ?? key;
}
