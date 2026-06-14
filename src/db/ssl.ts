// pg-connection-string v3 / pg v9 will reinterpret sslmode=require (and prefer/
// verify-ca) as verify-full, emitting a deprecation + security warning on every
// boot. Opt into stable libpq semantics with uselibpqcompat=true to keep the
// current behavior and silence the warnings. No security posture change.
export function withLibpqCompat(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (!url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
    }
    if (!url.searchParams.has("sslmode")) {
      url.searchParams.set("sslmode", "require");
    }
    return url.toString();
  } catch {
    // Non-URL connection string (e.g. key=value DSN) — leave untouched.
    return connectionString;
  }
}
