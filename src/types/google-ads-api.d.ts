// Stub declaration to prevent tsc from loading the massive protobuf types
// from the google-ads-api package. We use our own lightweight interfaces instead.
declare module "google-ads-api" {
  export class GoogleAdsApi {
    constructor(opts: {
      client_id: string;
      client_secret: string;
      developer_token: string;
    });
    Customer(opts: {
      customer_id: string;
      login_customer_id: string;
      refresh_token: string;
    }): Customer;
  }

  export interface Customer {
    credentials: { customer_id: string };
    query(gaql: string): Promise<Array<Record<string, unknown>>>;
    campaigns: {
      create(data: unknown[]): Promise<{ results: Array<{ resource_name: string }> }>;
      update(data: unknown[]): Promise<unknown>;
    };
    campaignBudgets: {
      create(data: unknown[]): Promise<{ results: Array<{ resource_name: string }> }>;
      update(data: unknown[]): Promise<unknown>;
    };
    conversionUploads: {
      uploadClickConversions(request: Record<string, unknown>): Promise<{
        results?: Array<Record<string, unknown>>;
        partial_failure_error?: { message?: string; code?: number } | null;
      }>;
    };
  }
}

