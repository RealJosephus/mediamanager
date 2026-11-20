const ambiguousInputFormats = new Set(['m2ts', 'wmv', 'mts', 'vob', 'mpg', 'mpeg', 'rec', 'dvr-ms', 'ogm', 'divx', 'tp', 'rmvb', 'rtp', 'm4v', 'strm', 'iso']);

export function nativeInputFormat(container) {
  container = container?.toLowerCase();
  if (!/^[a-z0-9,-]+$/u.test(container ?? '') || ambiguousInputFormats.has(container)) return;
  return container === 'ts' ? 'mpegts' : container.replaceAll('mkv', 'matroska');
}

export function mediaSeekTime(ticks) {
  const milliseconds = ticks / 10000n;
  const field = value => String(value).padStart(2, '0');
  return `${field(milliseconds / 3600000n % 24n)}:${field(milliseconds / 60000n % 60n)}:${field(milliseconds / 1000n % 60n)}.${String(milliseconds % 1000n).padStart(3, '0')}`;
}
