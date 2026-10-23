import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("stream-json stand-in (vendor/stream-json)", () => {
  it("lets google-ads-api load, so customer.query() keeps working", () => {
    const { GoogleAdsApi } = require("google-ads-api");
    expect(typeof GoogleAdsApi).toBe("function");
  });

  it("is the inert stub, not the vulnerable upstream package", () => {
    expect(require("stream-json/package.json").version).toBe("1.9.1-stub");
  });

  it("fails loudly if a report-streaming path is ever used", () => {
    const sj = require("stream-json");
    const { streamArray } = require("stream-json/streamers/StreamArray");
    expect(() => sj.parser()).toThrow(/report streaming is unsupported/);
    expect(() => new sj.Parser()).toThrow(/report streaming is unsupported/);
    expect(() => streamArray()).toThrow(/report streaming is unsupported/);
  });
});
