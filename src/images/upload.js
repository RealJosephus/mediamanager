import mimeExtensions from './resources/image-mime-extensions.json' with { type: 'json' };

const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const mediaType = new RegExp(`^\\s*(${token}/${token})(?:\\s*;\\s*${token}(?:\\s*=\\s*(?:${token}|\"(?:[^\"\\\\\\r\\n]|\\\\[\\x00-\\x7f])*\"))?)*\\s*$`);

export function imageUploadExtension(contentType) {
  if (typeof contentType !== 'string') return null;
  const match = mediaType.exec(contentType);
  return match ? mimeExtensions[match[1].toLowerCase()] ?? null : null;
}

/** Decode complete transform blocks; an incomplete final block has no output. */
export async function* decodeBase64Stream(stream, { signal } = {}) {
  let pending = '';
  for await (const bytes of stream) {
    signal?.throwIfAborted();
    const input = pending + Buffer.from(bytes).toString('latin1').replace(/[\x09-\x0d\x20]/g, '');
    const length = input.length - input.length % 4;
    pending = input.slice(length);
    if (!length) continue;
    const block = input.slice(0, length), decoded = Buffer.from(block, 'base64');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block) || decoded.toString('base64') !== block) {
      throw Object.assign(new Error('The image body contains an invalid Base64 transform block.'), { code: 'invalid-base64' });
    }
    yield decoded;
  }
  signal?.throwIfAborted();
}
