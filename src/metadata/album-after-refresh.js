import { addPerson } from './people.js';
import { clrTrim } from './whitespace.js';

const nullListError = nativeException => Object.assign(new TypeError('Native music artist list is null.'), { nativeException });

export async function afterAlbumMetadataRefresh(item, updatePeople) {
  const albumArtists = item.AlbumArtists, artists = item.Artists;
  if (albumArtists == null) throw nullListError('ArgumentNullException');
  if (!albumArtists.length) {
    if (artists == null) throw nullListError('ArgumentNullException');
    if (!artists.length) return;
  }
  const people = [];
  for (const name of albumArtists) if (name != null && clrTrim(name) !== '') {
    addPerson(people, { Name: name, Type: 'AlbumArtist' });
  }
  if (artists == null) throw nullListError('NullReferenceException');
  for (const name of artists) if (name != null && clrTrim(name) !== '') {
    addPerson(people, { Name: name, Type: 'Artist' });
  }
  await updatePeople(item, people);
}
