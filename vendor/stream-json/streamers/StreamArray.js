"use strict";
// Inert stand-in: see ../package.json.
const unsupported = () => {
  throw new Error("stream-json is not installed in google-service: report streaming is unsupported, use customer.query()");
};
class StreamArray {
  constructor() {
    unsupported();
  }
}
module.exports = { StreamArray, streamArray: unsupported, make: unsupported, withParser: unsupported };
