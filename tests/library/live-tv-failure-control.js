export function controlledProviderFailure(kind) {
  if (kind === 'OperationCanceledException') return new DOMException('Controlled provider cancellation.', 'AbortError');
  const code = { NotImplementedException: 'not-implemented', NotSupportedException: 'not-supported',
    FileNotFoundException: 'ENOENT', IOException: 'EIO' }[kind] ?? 'provider-failure';
  return Object.assign(new Error('Controlled provider failure.'), { code });
}
