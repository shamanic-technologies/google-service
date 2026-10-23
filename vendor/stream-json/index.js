"use strict";
// Inert stand-in: see package.json. Any call means a streaming code path was
// introduced; fail loudly instead of silently parsing nothing.
const unsupported = () => {
  throw new Error("stream-json is not installed in google-service: report streaming is unsupported, use customer.query()");
};
class Parser {
  constructor() {
    unsupported();
  }
}
module.exports = { Parser, parser: unsupported, make: unsupported };
