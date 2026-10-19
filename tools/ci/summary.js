export function ciSummary(scope, result) {
  const lines = ['## Cross-platform CI validation', '',
    `Platform: ${scope.platform}. Discovered: **${scope.discovered.length}**. Selected: **${scope.selected.length}**. Excluded: **${scope.excluded.length}**.`, '',
    `Selection mode: **${scope.impact.mode}**. Event: ${scope.impact.event ?? 'local/manual'}.`, '',
    ...(scope.sharding ? [`Shard: **${scope.sharding.index}/${scope.sharding.total}**; all shard scopes retain the same available-file manifest.`, ''] : []),
    ...(scope.impact.baseSha ? [`Comparison: \`${scope.impact.baseSha}\` → \`${scope.impact.headSha}\`.`, ''] : []),
    ...(scope.impact.fallbackReasons.length ? ['Automatic narrowing fell back to all available tests:', '',
      ...scope.impact.fallbackReasons.slice(0, 12).map(reason => `- ${reason.code}: ${String(reason.path ?? reason.consumer ?? reason.detail ?? '').replaceAll('\n', ' ').slice(0, 240)}`),
      ...(scope.impact.fallbackReasons.length > 12 ? ['- Further comparison details are in impact.json.'] : []), ''] : []),
    ...(scope.impact.mode === 'not-applicable' ? ['No tests executed: every changed file is on the documentation allowlist and has no declared consumer.', ''] : []),
    `Outcome: **${result.outcome}**. ${scope.profile === 'full'
      ? 'The strict full profile retains every discovered test. Release acceptance still requires two independent runs of the same candidate and inputs.'
      : 'This is an explicit available-input subset; release full-profile acceptance remains separate.'}`, '',
    'All selected tests retain the strict zero-failure, zero-skip, registration and unchanged-input gates. Test failures never change selection.', '',
    '### Excluded files', '', '| Test | Dependency or scope reason |', '| --- | --- |'];
  for (const record of scope.excluded) lines.push(`| ${record.path} | ${[...new Set(record.reasons.map(reason =>
    [reason.code, reason.service ?? reason.tool].filter(Boolean).join(': ')))].join(', ').slice(0, 300).replaceAll('|', '\\|')} |`);
  if (!scope.excluded.length) lines.push('| None | All discovered test files selected |');
  if (scope.infrastructureErrors.length) lines.push('', '### Infrastructure errors', '',
    ...scope.infrastructureErrors.slice(0, 20).map(error => `- ${error.code}: ${String(error.filename ?? '').slice(0, 240)}`));
  lines.push('', 'Complete dependency ownership, paths and errors are preserved in the scope.json artifact.');
  return lines.join('\n') + '\n';
}
