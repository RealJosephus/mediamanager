import { addPerson } from './people.js';
import { clrTrim } from './whitespace.js';

const nullListError = () => new TypeError('Native music artist list is null.');

export async function afterAlbumMetadataRefresh(item, updatePeople) {
  const albumArtists = item.AlbumArtists, artists = item.Artists;
  if (albumArtists == null) throw nullListError();
  if (!albumArtists.length) {
    if (artists == null) throw nullListError();
    if (!artists.length) return;
  }
  const people = [];
  for (const name of albumArtists) if (name != null && clrTrim(name) !== '') {
    addPerson(people, { Name: name, Type: 'AlbumArtist' });
  }
  if (artists == null) throw nullListError();
  for (const name of artists) if (name != null && clrTrim(name) !== '') {
    addPerson(people, { Name: name, Type: 'Artist' });
  }
  await updatePeople(item, people);
}
