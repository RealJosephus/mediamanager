// Layout acceptance is limited to generated subtitles and manifests whose
// real consumers were exercised by the reader fixtures. Original/copy-only bytes stay exact.
export function subtitleLayoutProjection(text, format) {
  const lines = text.split(/\r\n|\r|\n/u);
  if (['vtt', 'webvtt'].includes(format.toLowerCase())) {
    if (!lines[0].startsWith('WEBVTT')) return text;
    while (lines.at(-1) === '') lines.pop();
  }
  return lines;
}

export function hlsManifestProjection(text) {
  // A bare CR, BOM or a misplaced signature is outside the demonstrated scope.
  if (text.replaceAll('\r\n', '\n').includes('\r') || !text.startsWith('#EXTM3U\n') && !text.startsWith('#EXTM3U\r\n')) return text;
  return text.split(/\r\n|\n/u).filter(line => line !== '').map(line => {
    const match = /^#EXTINF:(\d+(?:\.\d+)?),(.*)$/u.exec(line);
    if (!match || !Number.isFinite(Number(match[1]))) return line;
    return { tag: '#EXTINF', seconds: Number(match[1]), title: match[2] };
  });
}
