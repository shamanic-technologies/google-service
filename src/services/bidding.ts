/**
 * Bidding strategy — settable at campaign creation AND changeable later on a
 * live campaign, without recreating it.
 *
 * This is load-bearing for the managed lifecycle: a brand-new campaign has no
 * conversion history, so it launches on a click-based or manual strategy and
 * graduates to a conversion-based one once enough conversions have accrued.
 * Both the initial pick and the later switch go through here.
 *
 * Only the campaign-level ("standard") strategies are modelled — a portfolio
 * strategy is a shared resource with its own lifecycle and nothing in the
 * managed workflow needs one.
 */

export const BIDDING_STRATEGY_TYPES = [
  "MANUAL_CPC",
  "MAXIMIZE_CLICKS",
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_CPA",
  "TARGET_ROAS",
] as const;

export type BiddingStrategyType = (typeof BIDDING_STRATEGY_TYPES)[number];

export interface BiddingStrategyInput {
  type: BiddingStrategyType;
  /** MANUAL_CPC only. */
  enhancedCpcEnabled?: boolean;
  /** MAXIMIZE_CLICKS / MAXIMIZE_CONVERSIONS ceiling. */
  cpcBidCeilingMicros?: string;
  /** Required for TARGET_CPA; optional hint for MAXIMIZE_CONVERSIONS. */
  targetCpaMicros?: string;
  /** Required for TARGET_ROAS; optional hint for MAXIMIZE_CONVERSION_VALUE. */
  targetRoas?: number;
}

/**
 * Maps our strategy input onto the campaign mutate fields Google expects.
 * Setting one bidding scheme field on an existing campaign is how a live
 * campaign switches strategy — Google clears the previous scheme itself.
 *
 * Fails loud on a strategy whose required companion value is missing; a
 * silently-dropped target would leave the campaign bidding on something the
 * caller never asked for.
 */
export const buildBiddingStrategyFields = (
  bidding: BiddingStrategyInput
): Record<string, unknown> => {
  switch (bidding.type) {
    case "MANUAL_CPC":
      return {
        manual_cpc: { enhanced_cpc_enabled: bidding.enhancedCpcEnabled === true },
      };

    case "MAXIMIZE_CLICKS": {
      // Google's own name for maximize-clicks on a campaign is TARGET_SPEND.
      const targetSpend: Record<string, unknown> = {};
      if (bidding.cpcBidCeilingMicros) {
        targetSpend.cpc_bid_ceiling_micros = Number(bidding.cpcBidCeilingMicros);
      }
      return { target_spend: targetSpend };
    }

    case "MAXIMIZE_CONVERSIONS": {
      const maximizeConversions: Record<string, unknown> = {};
      if (bidding.targetCpaMicros) {
        maximizeConversions.target_cpa_micros = Number(bidding.targetCpaMicros);
      }
      return { maximize_conversions: maximizeConversions };
    }

    case "MAXIMIZE_CONVERSION_VALUE": {
      const maximizeConversionValue: Record<string, unknown> = {};
      if (bidding.targetRoas !== undefined) {
        maximizeConversionValue.target_roas = bidding.targetRoas;
      }
      return { maximize_conversion_value: maximizeConversionValue };
    }

    case "TARGET_CPA": {
      if (!bidding.targetCpaMicros) {
        throw new Error("TARGET_CPA requires targetCpaMicros");
      }
      const targetCpa: Record<string, unknown> = {
        target_cpa_micros: Number(bidding.targetCpaMicros),
      };
      if (bidding.cpcBidCeilingMicros) {
        targetCpa.cpc_bid_ceiling_micros = Number(bidding.cpcBidCeilingMicros);
      }
      return { target_cpa: targetCpa };
    }

    case "TARGET_ROAS": {
      if (bidding.targetRoas === undefined) {
        throw new Error("TARGET_ROAS requires targetRoas");
      }
      const targetRoas: Record<string, unknown> = { target_roas: bidding.targetRoas };
      if (bidding.cpcBidCeilingMicros) {
        targetRoas.cpc_bid_ceiling_micros = Number(bidding.cpcBidCeilingMicros);
      }
      return { target_roas: targetRoas };
    }

    default: {
      const exhaustive: never = bidding.type;
      throw new Error(`Unsupported bidding strategy: ${String(exhaustive)}`);
    }
  }
};
