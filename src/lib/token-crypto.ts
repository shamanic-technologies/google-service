/**
 * Google OAuth tokens at rest (GOOGLE-TOKENS-AT-REST-1127).
 *
 * Every refresh/access token this service stores (google_oauth_tokens,
 * google_calendar_accounts, google_search_console_accounts) is AES-256-GCM
 * encrypted with a key that lives ONLY in the container env
 * (`GOOGLE_SERVICE_ENCRYPTION_KEY`, 64 hex chars, `openssl rand -hex 32`), never
 * in the database: a full read of the DB (dump, table browser, backup) yields no
 * usable Google credential. Same cipher as meta-service / social-service; the
 * stored value is `enc:v1:<iv>:<tag>:<ciphertext>` (hex), the prefix making a
 * prod check (`NOT LIKE 'enc:v1:%'`) and the boot migration unambiguous.
 *
 * The key is checked at BOOT (`assertEncryptionKey` in index.ts): a missing or
 * malformed key fails the deploy loudly instead of serving 500s on every sync.
 */
import crypto from "crypto";

export const ENCRYPTION_KEY_ENV = "GOOGLE_SERVICE_ENCRYPTION_KEY";
export const ENCRYPTED_PREFIX = "enc:v1:";

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super(`${ENCRYPTION_KEY_ENV} is required (64 hex chars) to read or store Google OAuth tokens`);
  }
}

const key = (): Buffer => {
  const raw = process.env[ENCRYPTION_KEY_ENV]?.trim();
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) throw new EncryptionKeyMissingError();
  return Buffer.from(raw, "hex");
};

/** Throws EncryptionKeyMissingError when the key is absent or malformed. */
export const assertEncryptionKey = (): void => {
  key();
};

export const isEncryptedToken = (value: string): boolean => value.startsWith(ENCRYPTED_PREFIX);

export const encryptToken = (plaintext: string): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
};

/** Decrypts a stored token. A value that is not ciphertext is refused, never returned as-is. */
export const decryptToken = (stored: string): string => {
  if (!isEncryptedToken(stored)) {
    throw new Error("stored Google token is not encrypted (expected enc:v1:...)");
  }
  const [ivHex, tagHex, ctHex] = stored.slice(ENCRYPTED_PREFIX.length).split(":");
  if (!ivHex || !tagHex || ctHex === undefined) throw new Error("invalid encrypted Google token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
};

export const encryptNullableToken = (plaintext: string | null): string | null =>
  plaintext == null ? null : encryptToken(plaintext);

export const decryptNullableToken = (stored: string | null): string | null =>
  stored == null ? null : decryptToken(stored);
