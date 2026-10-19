import { isNativeAudioFileName } from './audio-item-resolver.js';
import { nativeDirectoryName, nativeFileName, nativeFileNameWithoutExtension } from './native-path.js';
import { sameId } from './records.js';

export const audioBookNativeType = 'MediaBrowser.Controller.Entities.AudioBook';

const withheld = Object.freeze({ withhold: true });

function extension(name) {
  const index = String(name).lastIndexOf('.');
  return index > 0 ? String(name).slice(index).toLowerCase() : '';
}

function int32(value) {
  if (value == null) return null;
  const result = Number(value);
  return Number.isInteger(result) && result >= -2147483648 && result <= 2147483647 ? result : null;
}

/** Frozen AudioBookNameParser projection used by the production AudioBook resolver. */
export function parseAudioBookName(value) {
  const name = String(value ?? '');
  const dated = /^(?<name>.+?)\s*\(\s*(?<year>[0-9]{4})\s*\)\s*$/iu.exec(name);
  if (dated) return Object.freeze({ name: dated.groups.name, year: int32(dated.groups.year) });
  const plain = /^\s*(?<name>[^ ].*?)\s*$/iu.exec(name);
  return Object.freeze({ name: plain?.groups?.name || name, year: null });
}

function bookContext(collectionContext) {
  return collectionContext?.collectionType === 'books';
}

function audioCandidate(candidate) {
  return candidate?.entry?.kind === 'file' && isNativeAudioFileName(candidate.entry.name);
}

function audioBookDraft(name, mixed, { year = null, shortcut = false } = {}) {
  return {
    Name: name,
    IsFolder: false,
    MediaType: 'Audio',
    SourceType: 'Library',
    columns: {
      IsInMixedFolder: mixed,
      ...(year == null ? {} : { ProductionYear: year })
    },
    initialColumns: { Artists: [], AlbumArtists: [] },
    data: { IsShortcut: shortcut }
  };
}

function audioBookClaim(candidate, name, mixed, options) {
  return {
    nativeType: audioBookNativeType,
    primary: candidate,
    consumedPaths: [candidate],
    draft: audioBookDraft(name, mixed, options)
  };
}

export function createAudioBookItemResolver() {
  return Object.freeze({
    id: 'builtin-audio-book-items',
    priority: 50,
    productionMediaScope: 'audiobook-files-and-single-file-directories',
    nativeTypes: { [audioBookNativeType]: { isFolder: false } },
    resolveMultiple({ parent, root, collectionContext, available, deletionSafe }) {
      if (!bookContext(collectionContext)) return null;
      const audio = available.filter(audioCandidate);
      if (!deletionSafe || audio.length !== 1) return null;
      const [candidate] = audio;
      const containingName = nativeFileName(nativeDirectoryName(candidate.identityPath)) ?? '';
      const parsed = parseAudioBookName(containingName);
      return {
        items: [audioBookClaim(candidate, parsed.name, sameId(parent?.Id, root?.Id), { year: parsed.year })],
        extraFiles: available.filter(value => value !== candidate)
      };
    },
    resolveFile({ collectionContext, candidate, deletionSafe }) {
      if (!bookContext(collectionContext) || !audioCandidate(candidate)) return null;
      if (!deletionSafe) return withheld;
      if (extension(candidate.entry.name) === '.cue') return null;
      return audioBookClaim(candidate, nativeFileNameWithoutExtension(candidate.entry.name), true, {
        shortcut: extension(candidate.entry.name) === '.strm'
      });
    },
    async resolveDirectory({ collectionContext, candidate, peekDirectory }) {
      if (!bookContext(collectionContext)) return null;
      const snapshot = await peekDirectory?.(candidate);
      if (snapshot?.listing?.deletionSafe !== true || !Array.isArray(snapshot.candidates)) return withheld;
      const audio = snapshot.candidates.filter(audioCandidate);
      if (audio.length !== 1) return null;
      const parsed = parseAudioBookName(candidate.entry.name);
      return {
        nativeType: audioBookNativeType,
        primary: candidate,
        itemSource: audio[0],
        consumedPaths: [candidate, audio[0]],
        draft: audioBookDraft(candidate.entry.name, false, { year: parsed.year })
      };
    }
  });
}
