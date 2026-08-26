import { describe, it, expect } from "vitest";
import { buildBiddingStrategyFields } from "../services/bidding";

describe("buildBiddingStrategyFields", () => {
  it("maps MANUAL_CPC, including the enhanced-CPC flag", () => {
    expect(buildBiddingStrategyFields({ type: "MANUAL_CPC" })).toEqual({
      manual_cpc: { enhanced_cpc_enabled: false },
    });
    expect(
      buildBiddingStrategyFields({ type: "MANUAL_CPC", enhancedCpcEnabled: true })
    ).toEqual({ manual_cpc: { enhanced_cpc_enabled: true } });
  });

  it("maps MAXIMIZE_CLICKS onto Google's target_spend, with an optional ceiling", () => {
    expect(buildBiddingStrategyFields({ type: "MAXIMIZE_CLICKS" })).toEqual({
      target_spend: {},
    });
    expect(
      buildBiddingStrategyFields({
        type: "MAXIMIZE_CLICKS",
        cpcBidCeilingMicros: "2500000",
      })
    ).toEqual({ target_spend: { cpc_bid_ceiling_micros: 2500000 } });
  });

  it("maps the conversion-based strategies a graduated campaign moves onto", () => {
    expect(buildBiddingStrategyFields({ type: "MAXIMIZE_CONVERSIONS" })).toEqual({
      maximize_conversions: {},
    });
    expect(
      buildBiddingStrategyFields({ type: "TARGET_CPA", targetCpaMicros: "40000000" })
    ).toEqual({ target_cpa: { target_cpa_micros: 40000000 } });
    expect(buildBiddingStrategyFields({ type: "TARGET_ROAS", targetRoas: 3.5 })).toEqual({
      target_roas: { target_roas: 3.5 },
    });
    expect(
      buildBiddingStrategyFields({ type: "MAXIMIZE_CONVERSION_VALUE", targetRoas: 2 })
    ).toEqual({ maximize_conversion_value: { target_roas: 2 } });
  });

  it("fails loud when a strategy's required target is missing", () => {
    expect(() => buildBiddingStrategyFields({ type: "TARGET_CPA" })).toThrow(
      "TARGET_CPA requires targetCpaMicros"
    );
    expect(() => buildBiddingStrategyFields({ type: "TARGET_ROAS" })).toThrow(
      "TARGET_ROAS requires targetRoas"
    );
  });
});
