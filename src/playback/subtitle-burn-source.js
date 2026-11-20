import { StorageError, checkAbort } from '../storage/errors.js';
import { identityPathStyle } from '../storage/uri.js';
import { normalizeSubtitleBytes } from './subtitle-charset.js';
import { isExternalSubtitleFallback, subtitleInputFormat } from './subtitle-source.js';

const textFormats = new Map([
  ['srt', 'srt'], ['subrip', 'srt'], ['ass', 'ass'], ['ssa', 'ssa'],
  ['vtt', 'vtt'], ['webvtt', 'vtt'], ['smi', 'smi'], ['sami', 'smi'],
]);
const embedded = stream => !stream.IsExternal || /\.mks$/iu.test(stream.Path ?? '');

export class SubtitleBurnSource {
  constructor({ vfs, identityMap, extraction }) {
    Object.assign(this, { vfs, identityMap, extraction });
  }

  supports(source, stream) {
    if (!stream.IsTextSubtitleStream) return false;
    if (embedded(stream) || isExternalSubtitleFallback(stream)) return Boolean(this.extraction?.supportsSubtitle(source, stream));
    return Boolean(stream.Path && textFormats.has(subtitleInputFormat(stream)));
  }

  async load(source, stream, mediaPath, signal) {
    const path = stream.Path ? this.identityMap.resolve({ identityPath: stream.Path, style: identityPathStyle(stream.Path) }) : mediaPath;
    let bytes, format;
    if (embedded(stream) || isExternalSubtitleFallback(stream)) {
      ({ bytes, format } = await this.extraction.subtitle(source, stream, path, { signal }));
    } else {
      format = subtitleInputFormat(stream);
      const handle = await this.vfs.openRead(path, { signal });
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of handle.stream) {
          checkAbort(signal);
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new StorageError('invalid-response', 'Subtitle exceeds the supported in-memory size.');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks, size);
      } finally { await handle.close(); }
    }
    const extension = textFormats.get(format?.toLowerCase());
    if (!extension) throw new StorageError('not-supported', 'This text subtitle cannot be burned into the video.');
    return { extension, bytes: normalizeSubtitleBytes(bytes) };
  }

  async *fonts(source, mediaPath, signal) {
    if (!this.extraction) return;
    for (const attachment of source.MediaAttachments ?? []) {
      const extension = /\.(ttf|otf|ttc|otc)$/iu.exec(attachment.FileName ?? '')?.[1]?.toLowerCase();
      if (!extension) continue;
      const { bytes } = await this.extraction.attachment(source, attachment, mediaPath, { signal });
      yield { extension, bytes };
    }
  }
}
