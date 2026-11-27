// Every test process gets a fixed test key for Google tokens at rest
// (GOOGLE-TOKENS-AT-REST-1127). A test proving the missing-key failure deletes it locally.
process.env.GOOGLE_SERVICE_ENCRYPTION_KEY ??= "0123456789abcdef".repeat(4);
