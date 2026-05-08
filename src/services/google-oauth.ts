import crypto from "crypto";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GOOGLE_CRM_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

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
}

export const buildAuthorizeUrl = (params: BuildAuthorizeUrlParams): string => {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: GOOGLE_CRM_SCOPES.join(" "),
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
