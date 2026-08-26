import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  uploadClickConversions,
  getCampaignSpendByDay,
} from "../services/google-ads";
import type { GoogleAdsCustomer } from "../services/google-ads";

const makeCustomer = (
  uploadImpl: ReturnType<typeof vi.fn>,
  queryImpl = vi.fn()
): GoogleAdsCustomer =>
  ({
    credentials: { customer_id: "1234567890" },
    query: queryImpl,
    conversionUploads: { uploadClickConversions: uploadImpl },
  }) as unknown as GoogleAdsCustomer;

beforeEach(() => vi.clearAllMocks());

describe("uploadClickConversions", () => {
  it("maps the outcome onto the click and the conversion action resource", async () => {
    const upload = vi.fn().mockResolvedValue({ results: [{ gclid: "abc" }] });

    const result = await uploadClickConversions(makeCustomer(upload), [
      {
        gclid: "abc",
        conversionActionId: "555",
        conversionDateTime: "2026-08-25 13:04:00+00:00",
        conversionValue: 199.5,
        currencyCode: "USD",
        orderId: "order-9",
      },
    ]);

    expect(upload).toHaveBeenCalledWith({
      customer_id: "1234567890",
      conversions: [
        {
          conversion_action: "customers/1234567890/conversionActions/555",
          conversion_date_time: "2026-08-25 13:04:00+00:00",
          gclid: "abc",
          conversion_value: 199.5,
          currency_code: "USD",
          order_id: "order-9",
        },
      ],
      partial_failure: true,
      validate_only: false,
    });
    expect(result).toEqual({ requested: 1, uploaded: 1, partialFailureError: null });
  });

  it("counts only the rows Google accepted and surfaces the partial failure", async () => {
    const upload = vi.fn().mockResolvedValue({
      results: [{ gclid: "abc" }, {}],
      partial_failure_error: { message: "conversion 2 rejected" },
    });

    const result = await uploadClickConversions(makeCustomer(upload), [
      { gclid: "abc", conversionActionId: "1", conversionDateTime: "2026-08-25 13:04:00+00:00" },
      { gclid: "def", conversionActionId: "1", conversionDateTime: "2026-08-25 13:05:00+00:00" },
    ]);

    expect(result).toEqual({
      requested: 2,
      uploaded: 1,
      partialFailureError: "conversion 2 rejected",
    });
  });

  it("throws when Google accepted nothing — a rejected batch is not a success", async () => {
    const upload = vi.fn().mockResolvedValue({
      results: [{}],
      partial_failure_error: { message: "invalid gclid" },
    });

    await expect(
      uploadClickConversions(makeCustomer(upload), [
        { gclid: "bad", conversionActionId: "1", conversionDateTime: "2026-08-25 13:04:00+00:00" },
      ])
    ).rejects.toThrow("Google accepted 0 of 1 conversions: invalid gclid");
  });

  it("uses validate_only without partial_failure on a dry run", async () => {
    const upload = vi.fn().mockResolvedValue({ results: [] });

    const result = await uploadClickConversions(
      makeCustomer(upload),
      [{ wbraid: "w1", conversionActionId: "1", conversionDateTime: "2026-08-25 13:04:00+00:00" }],
      { validateOnly: true }
    );

    expect(upload.mock.calls[0][0]).toMatchObject({
      partial_failure: false,
      validate_only: true,
    });
    expect(result.uploaded).toBe(0);
  });
});

describe("getCampaignSpendByDay", () => {
  it("segments cost by Google's own reporting day", async () => {
    const gaqlQuery = vi.fn().mockResolvedValue([
      { campaign: { id: 1 }, segments: { date: "2026-08-24" }, metrics: { cost_micros: 1230000 } },
      { campaign: { id: 2 }, segments: { date: "2026-08-25" }, metrics: {} },
      { campaign: { id: 3 }, metrics: { cost_micros: 500 } },
    ]);

    const rows = await getCampaignSpendByDay(
      makeCustomer(vi.fn(), gaqlQuery),
      "2026-08-20",
      "2026-08-26"
    );

    const gaql = gaqlQuery.mock.calls[0][0] as string;
    expect(gaql).toContain("segments.date");
    expect(gaql).toContain("BETWEEN '2026-08-20' AND '2026-08-26'");
    // The row without a date is skipped — it cannot be attributed to a day.
    expect(rows).toEqual([
      { campaignId: "1", date: "2026-08-24", costMicros: "1230000" },
      { campaignId: "2", date: "2026-08-25", costMicros: "0" },
    ]);
  });
});
