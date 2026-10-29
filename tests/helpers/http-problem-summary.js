import { projectProblemTrace } from './http-body-projection.js';

// Older filter controls recorded a limited summary with no root trace field.
// This does not compare trace presence or the complete HTTP response. Keep the
// original response separately; full wire comparisons must not use this view.
export function projectProblemSummary(body, status) {
  const projected = projectProblemTrace(body, status);
  if (projected === body) return body;
  const summary = { ...projected };
  delete summary.traceId;
  return summary;
}
