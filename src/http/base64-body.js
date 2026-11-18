/** Decode the complete groups consumed by the native upload transform. */
export function decodeBase64Body(value) {
  const text = value.replace(/[\t\n\v\f\r ]/gu, '');
  const end = text.length - text.length % 4;
  const complete = text.slice(0, end);
  const padding = complete.indexOf('=');
  const data = padding < 0 ? complete : complete.slice(0, padding);
  if (/[^A-Za-z0-9+/]/u.test(data)
    || padding >= 0 && (end !== text.length || !/^={1,2}$/u.test(complete.slice(padding)))) {
    throw new SyntaxError('The upload contains invalid Base64 data.');
  }
  return Buffer.from(complete, 'base64');
}
