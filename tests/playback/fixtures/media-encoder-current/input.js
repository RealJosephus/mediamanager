import extraction from '../extraction-reference.json' with { type: 'json' };
import hls from '../hls-reference.json' with { type: 'json' };

export function mediaEncoderInput() {
  const source = structuredClone(extraction.sources[0]);
  for (const stream of source.source.MediaStreams) if (stream.Type === 'Subtitle') stream.SupportsExternalStream = true;
  return { schemaVersion: 1, source, hls,
    cases: [
      { name: 'cli-over-environment-and-xml', cli: '@a', environmentPath: '@b', configPath: '@b' },
      { name: 'environment-over-xml', environmentPath: '@b', configPath: '@a' },
      { name: 'xml-selection', configPath: '@a' },
      { name: 'path-selection' },
      { name: 'empty-cli-overrides-environment', cli: '', environmentPath: '@b', configPath: '@a' },
      { name: 'invalid-cli-never-falls-back', cli: '@missing', configPath: '@a' },
      { name: 'whitespace-cli-is-not-empty', cli: ' ', configPath: '@a' },
      { name: 'old-version-rejected', cli: '@a', versionText: 'ffmpeg version 3.4\n' },
      { name: 'nonzero-valid-version', cli: '@a', exitCode: 7 },
      { name: 'skip-keeps-uninitialized-paths', cli: '@a', configPath: '@b', skip: true },
      { name: 'updating-observer-failure-prefix', cli: '@a', observer: 'updating' },
      { name: 'updated-observer-failure-prefix', cli: '@a', observer: 'updated' },
      { name: 'real-save-io-failure-prefix', cli: '@a', saveDirectory: true },
      { name: 'late-alias-and-current-threads', cli: '@a', observer: 'late-alias', executeHls: true },
      { name: 'second-version-uses-actual-library-fallback', cli: '@a', afterSave: 'libraries-only', executeHls: true },
      { name: 'second-version-target-removed', cli: '@a', afterSave: 'remove' },
    ],
    cpuLimits: [null, 0, -2, 2147483647],
    binding: ['', 'cpuCoreLimit=', 'cpuCoreLimit=0', 'CPUCORELIMIT=-2', 'cpuCoreLimit=%2B1', 'cpuCoreLimit=2147483647',
      'cpuCoreLimit=2147483648', 'cpuCoreLimit=1.2', 'cpuCoreLimit=abc'],
    sourceSelectionBoundary: 'Actual StartupOptions.ConvertToConfig and prefixed environment configuration; the general CLI parser is outside this component fixture.',
  };
}
