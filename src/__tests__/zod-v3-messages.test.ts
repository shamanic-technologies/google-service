import { describe, it, expect } from "vitest";
import { z } from "zod";
import "../lib/zod-v3-messages";
import { CreateCampaignBodySchema } from "../schemas";

// The 400 body is the issue messages joined (middleware/validate.ts). These are
// the exact Zod 3 strings the API served before the Zod 4 upgrade.
const msg = (schema: z.ZodType, input: unknown): string => {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected a failure");
  return r.error.issues.map((i) => i.message).join(", ");
};

describe("Zod 3 issue messages under Zod 4", () => {
  it("missing field is Required", () => {
    expect(msg(z.object({ name: z.string() }), {})).toBe("Required");
  });
  it("wrong type", () => {
    expect(msg(z.string(), 5)).toBe("Expected string, received number");
    expect(msg(z.coerce.number(), "abc")).toBe("Expected number, received nan");
    expect(msg(z.number().int(), 1.5)).toBe("Expected integer, received float");
    expect(msg(z.object({}), [])).toBe("Expected object, received array");
  });
  it("sizes", () => {
    expect(msg(z.string().min(1), "")).toBe("String must contain at least 1 character(s)");
    expect(msg(z.string().max(2), "abc")).toBe("String must contain at most 2 character(s)");
    expect(msg(z.string().length(2), "abc")).toBe("String must contain exactly 2 character(s)");
    expect(msg(z.array(z.string()).min(1), [])).toBe("Array must contain at least 1 element(s)");
    expect(msg(z.array(z.string()).max(1), ["a", "b"])).toBe("Array must contain at most 1 element(s)");
    expect(msg(z.coerce.number().int().min(1).max(200), "500")).toBe("Number must be less than or equal to 200");
    expect(msg(z.coerce.number().int().min(1), "0")).toBe("Number must be greater than or equal to 1");
    expect(msg(z.number().positive(), 0)).toBe("Number must be greater than 0");
  });
  it("formats", () => {
    expect(msg(z.string().email(), "nope")).toBe("Invalid email");
    expect(msg(z.string().url(), "nope")).toBe("Invalid url");
    expect(msg(z.string().guid(), "nope")).toBe("Invalid uuid");
    expect(msg(z.string().datetime(), "nope")).toBe("Invalid datetime");
    expect(msg(z.string().regex(/^\d+$/), "a")).toBe("Invalid");
  });
  it("enums and literals", () => {
    expect(msg(z.enum(["A", "B"]), "C")).toBe("Invalid enum value. Expected 'A' | 'B', received 'C'");
    expect(msg(z.literal("ok"), "ko")).toBe('Invalid literal value, expected "ok"');
  });
  it("a schema's own message still wins", () => {
    expect(msg(z.string().min(1, { message: "custom" }), "")).toBe("custom");
  });
  it("ids keep the Zod 3 lax uuid check", () => {
    expect(z.string().guid().safeParse("11111111-1111-1111-1111-111111111111").success).toBe(true);
  });
  it("defaults still apply", () => {
    const r = CreateCampaignBodySchema.safeParse({ name: "n", advertisingChannelType: "SEARCH", budgetAmountMicros: "1" });
    expect(r.success && r.data.status).toBe("PAUSED");
  });
});
