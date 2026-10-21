import crypto from "crypto";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Send permission: lets a follow-up reply in the person's own Gmail thread from
// the address they wrote to (RIGHT-MOMENT-OR-LATER-1014). A grant made before it
// was requested lacks it, and the reply route refuses with
// `google_send_permission_missing` until the owner reconnects.
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_CRM_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_SEND_SCOPE,
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Google Calendar connection (GOOGLE-CALENDAR-INTEGRATION-1021): asked on its own
// consent, never bundled into the Gmail one. Events read-only = who booked a
// meeting with the owner, whatever tool created it. Meet read-only = the
// participant list of a Meet call, the only positive proof a prospect joined.
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const MEET_READ_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";

export const GOOGLE_CALENDAR_SCOPES = [
  CALENDAR_EVENTS_SCOPE,
  MEET_READ_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
];

export type GoogleConnection = "mailbox" | "calendar";

export const scopesForConnection = (connection: GoogleConnection): string[] =>
  connection === "calendar" ? GOOGLE_CALENDAR_SCOPES : GOOGLE_CRM_SCOPES;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export const generatePkcePair = (): PkcePair => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
};

export const generateState = (): string => crypto.randomBytes(32).toString("base64url");

export interface BuildAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  pkceChallenge: string;
  // Which consent to ask for. Default = the mailbox (Gmail + contacts) one.
  connection?: GoogleConnection;
}

export const buildAuthorizeUrl = (params: BuildAuthorizeUrlParams): string => {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: scopesForConnection(params.connection ?? "mailbox").join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: params.state,
    code_challenge: params.pkceChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTHORIZE_URL}?${qs.toString()}`;
};

export interface TokenExchangeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  pkceVerifier: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export const exchangeCodeForTokens = async (
  params: TokenExchangeParams
): Promise<GoogleTokenResponse> => {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.pkceVerifier,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as GoogleTokenResponse;
  if (!json.refresh_token) {
    throw new Error("Google token exchange returned no refresh_token (user may have previously consented; revoke and retry)");
  }
  return json;
};

export interface RefreshAccessTokenParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export const refreshAccessToken = async (
  params: RefreshAccessTokenParams
): Promise<RefreshTokenResponse> => {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${text}`);
  }

  return (await res.json()) as RefreshTokenResponse;
};

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type RevokeOutcome = "revoked" | "already_revoked";

// Revokes the grant at Google. Revoking the refresh token kills every access token
// minted from it, so the app disappears from the user's Google "third-party access".
// Google answers 400 invalid_token when the grant is already gone (the user removed
// the app, or the token expired): the end state is the one we asked for, so that is
// reported as already_revoked rather than an error. Anything else fails loud.
// Bounded: a disconnect waits on this call, so Google not answering must fail
// the disconnect (retryable) within seconds rather than hang the request.
export const GOOGLE_REVOKE_TIMEOUT_MS = 8_000;

export const revokeGoogleToken = async (token: string): Promise<RevokeOutcome> => {
  const res = await fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(GOOGLE_REVOKE_TIMEOUT_MS),
  });
  if (res.ok) return "revoked";
  const text = await res.text();
  if (res.status === 400 && text.includes("invalid_token")) return "already_revoked";
  throw new Error(`Google token revoke failed: ${res.status} ${text}`);
};

export const fetchGoogleUserEmail = async (accessToken: string): Promise<string> => {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google userinfo failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { email?: string };
  if (!data.email) {
    throw new Error("Google userinfo missing email");
  }
  return data.email;
};
