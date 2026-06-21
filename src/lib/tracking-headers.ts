/**
 * Cost-attribution / trace-propagation tracking headers.
 *
 * SECURITY: every header built here identifies an internal run / brand / audience
 * and MUST only ever be sent to internal sibling services (runs-service,
 * billing-service, key-service). NEVER forward them to an external vendor
 * (Serper, Gmail/People, Google Ads, Google OAuth) — vendor requests are built
 * separately with provider auth only, so tracking never leaks at egress.
 *
 * Build downstream headers via this allowlist, not by cherry-picking fields at
 * each call site: adding a future tracking header is one line here.
 */
export interface Tracking {
  runId?: string;
  featureSlug?: string;
  brandId?: string;
  audienceId?: string;
}

/** Map the tracking block to its x-* downstream headers, omitting any unset field. */
export const trackingHeaders = (t: Tracking): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (t.runId) headers["x-run-id"] = t.runId;
  if (t.featureSlug) headers["x-feature-slug"] = t.featureSlug;
  if (t.brandId) headers["x-brand-id"] = t.brandId;
  if (t.audienceId) headers["x-audience-id"] = t.audienceId;
  return headers;
};
