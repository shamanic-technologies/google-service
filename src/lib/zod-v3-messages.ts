import { z } from "zod";

// Zod 4 rewrote every default issue message ("Required" became "Invalid input:
// expected string, received undefined"). Our 400s return those messages to the
// caller (`validate.ts` joins them), so this global error map keeps the exact
// Zod 3 wording the API has always served. A per-schema `{ message }` still wins.
// Imported for its side effect by every module that builds a schema.

type Issue = Parameters<z.core.$ZodErrorMap>[0];

const parsedType = (input: unknown): string => {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (typeof input === "number") {
    if (Number.isNaN(input)) return "nan";
    return "number";
  }
  if (input instanceof Date) return "date";
  if (input instanceof Map) return "map";
  if (input instanceof Set) return "set";
  if (typeof input === "object" && typeof (input as { then?: unknown }).then === "function") return "promise";
  return typeof input;
};

const joinValues = (values: readonly unknown[]): string =>
  values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");

const schemaType = (issue: Issue): string | undefined =>
  (issue.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;

export const zodV3Message = (issue: Issue): string | undefined => {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined) return "Required";
      if (issue.expected === "int") {
        return `Expected integer, received ${Number.isInteger(issue.input) ? "number" : "float"}`;
      }
      return `Expected ${issue.expected}, received ${parsedType(issue.input)}`;
    }
    case "invalid_value": {
      if (schemaType(issue) === "literal") {
        return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      }
      if (typeof issue.input !== "string") {
        return `Expected ${joinValues(issue.values)}, received ${parsedType(issue.input)}`;
      }
      return `Invalid enum value. Expected ${joinValues(issue.values)}, received '${issue.input}'`;
    }
    case "too_small": {
      const min = issue.minimum.toString();
      if (issue.origin === "array") {
        return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "more than"} ${min} element(s)`;
      }
      if (issue.origin === "string") {
        return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "over"} ${min} character(s)`;
      }
      if (issue.origin === "number" || issue.origin === "int") {
        return `Number must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${min}`;
      }
      return "Invalid input";
    }
    case "too_big": {
      const max = issue.maximum.toString();
      if (issue.origin === "array") {
        return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "less than"} ${max} element(s)`;
      }
      if (issue.origin === "string") {
        return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "under"} ${max} character(s)`;
      }
      if (issue.origin === "number" || issue.origin === "int") {
        return `Number must be ${issue.exact ? "exactly" : issue.inclusive ? "less than or equal to" : "less than"} ${max}`;
      }
      return "Invalid input";
    }
    case "invalid_format": {
      if (issue.format === "regex") return "Invalid";
      if (issue.format === "guid") return "Invalid uuid";
      return `Invalid ${issue.format}`;
    }
    default:
      return "Invalid input";
  }
};

z.config({ customError: zodV3Message });
