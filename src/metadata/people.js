import { clrTrim } from './whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

export function addPerson(people, value) {
  if (!value?.Name) throw new TypeError('A person must have a name.');
  const person = { ...value, Name: clrTrim(value.Name), ProviderIds: { ...value.ProviderIds } };
  const normalizedType = ['GuestStar', 'Director', 'Producer', 'Writer'].find(type => ordinalIgnoreCaseEquals(type, person.Role));
  if (normalizedType) person.Type = normalizedType;
  const sameCredit = entry => ordinalIgnoreCaseEquals(entry.Name, person.Name) && (entry.Type === person.Type || ['Actor', 'GuestStar'].includes(entry.Type) && ['Actor', 'GuestStar'].includes(person.Type));
  let existing = people.find(entry => sameCredit(entry) && ordinalIgnoreCaseEquals(entry.Role ?? '', person.Role ?? ''));
  if (!existing) {
    if (!person.Role) existing = people.find(sameCredit);
    else {
      existing = people.find((entry) => sameCredit(entry) && !entry.Role);
      if (existing) existing.Role = person.Role;
    }
  }
  if (!existing) { people.push(person); return; }
  if (person.Type === 'GuestStar') existing.Type = 'GuestStar';
  existing.SortOrder = person.SortOrder ?? existing.SortOrder;
  existing.ImageUrl = person.ImageUrl ?? existing.ImageUrl;
  Object.assign(existing.ProviderIds ??= {}, person.ProviderIds);
}
