// PR-3b: I17 surfaces that need a served provider path. The isolation audit delegates them here instead of
// printing UNVERIFIED; `test:edge` fails unless every delegated case passes.
export const EDGE_DELEGATIONS = Object.freeze({
  'analyze-foreign': 'analyze-clothing ownership on a served provider path: foreign request IDs, anonymous and frozen owners',
  'analysis-status-owned': 'own ai_analysis_status positive control after a claimed provider-double analysis',
  'analyzed-save-owned': 'owned analyzed Save through finalize-analyzed-item with a real analysis claim',
  'attribution-populated': 'populated AI attribution history after a provider-analyzed Save',
});
export const delegatedLine = (key) => `DELEGATED: ${EDGE_DELEGATIONS[key]} -> test:edge EDGE-RUNTIME ${key}`;
