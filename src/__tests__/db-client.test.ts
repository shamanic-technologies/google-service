import { describe, it, expect } from "vitest";
import { withLibpqCompat } from "../db/ssl";

describe("withLibpqCompat", () => {
  it("adds uselibpqcompat=true and keeps existing sslmode", () => {
    const out = new URL(
      withLibpqCompat("postgres://u:p@host/db?sslmode=require"),
    );
    expect(out.searchParams.get("uselibpqcompat")).toBe("true");
    expect(out.searchParams.get("sslmode")).toBe("require");
  });

  it("adds sslmode=require when missing", () => {
    const out = new URL(withLibpqCompat("postgres://u:p@host/db"));
    expect(out.searchParams.get("uselibpqcompat")).toBe("true");
    expect(out.searchParams.get("sslmode")).toBe("require");
  });

  it("does not override an explicit sslmode", () => {
    const out = new URL(
      withLibpqCompat("postgres://u:p@host/db?sslmode=verify-full"),
    );
    expect(out.searchParams.get("sslmode")).toBe("verify-full");
    expect(out.searchParams.get("uselibpqcompat")).toBe("true");
  });

  it("leaves a non-URL DSN untouched", () => {
    const dsn = "host=localhost dbname=test sslmode=require";
    expect(withLibpqCompat(dsn)).toBe(dsn);
  });
});
