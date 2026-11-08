import { env } from "../env";

export interface OrgBrand {
  id: string;
  domain: string | null;
  brandUrl: string | null;
}

/** The org's brands with their domains (brand-service `GET /orgs/brands`). Fails loud. */
export const listOrgBrands = async (orgId: string): Promise<OrgBrand[]> => {
  const res = await fetch(`${env.BRAND_SERVICE_URL}/orgs/brands`, {
    headers: { "x-api-key": env.BRAND_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`brand-service GET /orgs/brands failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { brands: OrgBrand[] };
  return data.brands;
};
