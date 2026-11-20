import path from 'node:path';
import { md5Guid } from '../core/identity.js';
import { withCleanup } from '../core/operation-failure.js';
import { idKey, VIDEO_TYPES } from '../library/records.js';
import { extractStillImage } from '../media-execution/still-image.js';

const fileVideo = item => item.Path && item.IsFileProtocol !== false && !item.IsShortcut && !item.IsPlaceHolder
  && item.VideoType !== 'Dvd' && item.IsCompleteMedia !== false;
const names = { Primary: ['poster', 'folder', 'cover', 'default', 'movie', 'show'],
  Backdrop: ['backdrop', 'background', 'art'], Logo: ['logo'] };
const imageFormat = value => ['png', 'bmp', 'gif', 'webp'].includes(value) ? value : 'jpeg';
const matches = (names, value) => typeof value === 'string' && names.some(name => value.toLowerCase().includes(name));
const missing = error => ['ENOENT', 'not-found', 'not-directory'].includes(error.code);
const primary = ['Primary'];

export function createMediaImageProviders({ playback, probe, fileSystem, getConfiguration, getCachePath }) {
  const { library } = playback;
  const getSource = async item => (await library.getMediaSources(item.Id)).find(value => idKey(value.Id) === idKey(item.Id));
  const extract = async (item, options, signal) => {
    const configuration = getConfiguration(), virtualPath = playback.accessPath(item);
    const lease = await probe.bridge.lease(virtualPath, { signal, expiresInMs: 60000 + 2 * Math.max(configuration.ImageExtractionTimeoutMs ?? 0, 20000) });
    const bytes = await withCleanup(() => extractStillImage(probe.mediaEncoder, lease.url, { ...options, configuration, signal }),
      [lease.release], 'Image extraction failed.');
    return { bytes, mimeType: 'image/' + (options.format ?? 'jpeg') };
  };
  return { id: 'builtin-media-images', name: 'Media images', providers: [
    { id: 'audio-image-extractor', name: 'Image Extractor', kind: 'image', imageSource: 'dynamic', itemTypes: ['Audio', 'AudioBook'],
      imageTypes: primary, supports: item => item.Path && item.IsFileProtocol !== false && !item.IsShortcut,
      async getImage(item, { signal }) {
        const source = await getSource(item);
        const images = source?.MediaStreams.filter(stream => stream.Type === 'EmbeddedImage');
        if (!images?.length) return null;
        const artist = item.AlbumArtists?.[0], shared = item.Type === 'Audio' && item.Album?.trim() && artist?.trim();
        const hash = shared ? md5Guid(item.Album + '-' + artist) : idKey(item.Id);
        const directory = path.join(getCachePath(), 'extracted-audio-images', hash[0]), filename = path.join(directory, hash + '.jpg');
        try { return { bytes: await fileSystem.readFile(filename, { signal }), mimeType: 'image/jpeg' }; }
        catch (error) { if (!missing(error)) throw error; }
        const image = images.find(value => matches(['front'], value.Comment)) ?? images.find(value => matches(['cover'], value.Comment)) ?? images[0];
        const result = await extract(item, { imageIndex: image.Index, audio: true }, signal);
        await fileSystem.mkdir(directory, { recursive: true, signal });
        try { await fileSystem.writeFile(filename, result.bytes, { flag: 'wx', signal }); }
        catch (error) {
          if (!['EEXIST', 'already-exists'].includes(error.code)) throw error;
          return { bytes: await fileSystem.readFile(filename, { signal }), mimeType: result.mimeType };
        }
        return result;
      },
    },
    { id: 'embedded-video-image-extractor', name: 'Embedded Image Extractor', kind: 'image', imageSource: 'dynamic', itemTypes: [...VIDEO_TYPES],
      order: 99, supports: fileVideo, imageTypesFor: item => item.Type === 'Episode' ? primary : Object.keys(names),
      async getImage(item, { type, signal }) {
        const source = await getSource(item);
        if (!source) return null;
        const labels = names[type];
        const attachment = source.MediaAttachments?.find(value => matches(labels, value.FileName));
        if (attachment) {
          const kind = attachment.MimeType?.split('/').at(-1) || path.extname(attachment.FileName).slice(1).toLowerCase();
          return extract(item, { imageIndex: attachment.Index, container: source.Container, format: imageFormat(kind) }, signal);
        }
        const images = source.MediaStreams.filter(stream => stream.Type === 'EmbeddedImage');
        const stream = images.find(value => matches(labels, value.Comment)) ?? (type === 'Primary' ? images[0] : null);
        return stream ? extract(item, { imageIndex: stream.Index, stream, container: source.Container, format: imageFormat(stream.Codec) }, signal) : null;
      },
    },
    { id: 'screen-grabber', name: 'Screen Grabber', kind: 'image', imageSource: 'dynamic', itemTypes: [...VIDEO_TYPES],
      order: 100, supports: fileVideo, imageTypes: primary,
      async getImage(item, { signal }) {
        if (item.DefaultVideoStreamIndex == null) return null;
        const source = await getSource(item);
        const stream = source?.MediaStreams.find(value => value.Index === item.DefaultVideoStreamIndex)
          ?? source?.MediaStreams.find(value => value.Type === 'Video');
        if (!stream) return null;
        const duration = BigInt(item.RunTimeTicks ?? 0), offset = duration > 0n ? duration / 10n : 100000000n;
        return extract(item, { stream, offset, container: source.Container, stereo: source.Video3DFormat }, signal);
      },
    },
  ] };
}
