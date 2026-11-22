// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['claude'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    linked: source => source === 'web',
    // The Claude Desktop sample is read locally, so its lane reads "Desktop"
    // beside the network-backed OAuth/CLI/Web lanes.
    sourceLabel: source => source === 'local' ? 'Desktop' : ''
  });
});
