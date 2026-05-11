const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PEOPLE_BASE = "https://people.googleapis.com/v1";

export const PEOPLE_PERSON_FIELDS = [
  "names",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "addresses",
  "biographies",
  "birthdays",
  "memberships",
  "metadata",
  "photos",
  "urls",
  "events",
  "occupations",
].join(",");

const apiFetch = async <T>(url: string, accessToken: string): Promise<T> => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google API ${url} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
};

// ─── Gmail ───

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListMessagesResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: string;
  labelIds?: string[];
  snippet?: string;
  payload?: unknown;
  sizeEstimate?: number;
  raw?: string;
}

export const listGmailMessages = async (
  accessToken: string,
  params: { q?: string; pageToken?: string; maxResults?: number }
): Promise<GmailListMessagesResponse> => {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.pageToken) qs.set("pageToken", params.pageToken);
  qs.set("maxResults", String(params.maxResults ?? 100));
  return apiFetch<GmailListMessagesResponse>(
    `${GMAIL_BASE}/messages?${qs.toString()}`,
    accessToken
  );
};

export const getGmailMessage = async (
  accessToken: string,
  messageId: string
): Promise<GmailMessage> => {
  return apiFetch<GmailMessage>(
    `${GMAIL_BASE}/messages/${messageId}?format=full`,
    accessToken
  );
};

export interface GmailHistoryItem {
  id: string;
  messages?: GmailMessageRef[];
  messagesAdded?: { message: GmailMessageRef }[];
  messagesDeleted?: { message: GmailMessageRef }[];
}

export interface GmailHistoryListResponse {
  history?: GmailHistoryItem[];
  nextPageToken?: string;
  historyId?: string;
}

export const listGmailHistory = async (
  accessToken: string,
  params: { startHistoryId: string; pageToken?: string; maxResults?: number }
): Promise<GmailHistoryListResponse> => {
  const qs = new URLSearchParams({ startHistoryId: params.startHistoryId });
  if (params.pageToken) qs.set("pageToken", params.pageToken);
  qs.set("maxResults", String(params.maxResults ?? 500));
  qs.set("historyTypes", "messageAdded");
  return apiFetch<GmailHistoryListResponse>(
    `${GMAIL_BASE}/history?${qs.toString()}`,
    accessToken
  );
};

export const getGmailProfile = async (
  accessToken: string
): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }> => {
  return apiFetch(`${GMAIL_BASE}/profile`, accessToken);
};

// ─── People ───

export interface PersonResource {
  resourceName: string;
  etag?: string;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface PeopleListConnectionsResponse {
  connections?: PersonResource[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
  totalItems?: number;
}

export const listPeopleConnections = async (
  accessToken: string,
  params: { pageToken?: string; syncToken?: string; pageSize?: number; requestSyncToken?: boolean }
): Promise<PeopleListConnectionsResponse> => {
  const qs = new URLSearchParams({ personFields: PEOPLE_PERSON_FIELDS });
  if (params.pageToken) qs.set("pageToken", params.pageToken);
  if (params.syncToken) qs.set("syncToken", params.syncToken);
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params.requestSyncToken) qs.set("requestSyncToken", "true");
  return apiFetch<PeopleListConnectionsResponse>(
    `${PEOPLE_BASE}/people/me/connections?${qs.toString()}`,
    accessToken
  );
};

// otherContacts.list readMask must be a subset of the syncable fields when
// requestSyncToken=true: emailAddresses, metadata, names, phoneNumbers.
// photos is NOT syncable, so we exclude it.
export const OTHER_CONTACTS_READ_MASK = [
  "emailAddresses",
  "metadata",
  "names",
  "phoneNumbers",
].join(",");

export interface PeopleListOtherContactsResponse {
  otherContacts?: PersonResource[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalSize?: number;
}

export const listOtherContacts = async (
  accessToken: string,
  params: { pageToken?: string; syncToken?: string; pageSize?: number; requestSyncToken?: boolean }
): Promise<PeopleListOtherContactsResponse> => {
  const qs = new URLSearchParams({ readMask: OTHER_CONTACTS_READ_MASK });
  if (params.pageToken) qs.set("pageToken", params.pageToken);
  if (params.syncToken) qs.set("syncToken", params.syncToken);
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params.requestSyncToken) qs.set("requestSyncToken", "true");
  return apiFetch<PeopleListOtherContactsResponse>(
    `${PEOPLE_BASE}/otherContacts?${qs.toString()}`,
    accessToken
  );
};
