interface SerperWebResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperNewsResult {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  date?: string;
}

interface SerperSearchParams {
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
}

interface SerperNewsParams extends SerperSearchParams {
  tbs?: string;
}

const SERPER_BASE_URL = "https://google.serper.dev";

const serperHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  "X-API-KEY": apiKey,
});

const extractDomain = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export const searchWeb = async (params: SerperSearchParams, apiKey: string) => {
  const res = await fetch(`${SERPER_BASE_URL}/search`, {
    method: "POST",
    headers: serperHeaders(apiKey),
    body: JSON.stringify({
      q: params.query,
      num: params.num ?? 10,
      gl: params.gl,
      hl: params.hl,
    }),
  });

  if (!res.ok) {
    throw new Error(`Serper web search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { organic?: SerperWebResult[] };
  return (data.organic ?? []).map((r, i) => ({
    title: r.title ?? "",
    link: r.link ?? "",
    snippet: r.snippet ?? "",
    domain: extractDomain(r.link ?? ""),
    position: r.position ?? i + 1,
  }));
};

export const searchNews = async (params: SerperNewsParams, apiKey: string) => {
  const res = await fetch(`${SERPER_BASE_URL}/news`, {
    method: "POST",
    headers: serperHeaders(apiKey),
    body: JSON.stringify({
      q: params.query,
      num: params.num ?? 10,
      gl: params.gl,
      hl: params.hl,
      tbs: params.tbs,
    }),
  });

  if (!res.ok) {
    throw new Error(`Serper news search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { news?: SerperNewsResult[] };
  return (data.news ?? []).map((r) => ({
    title: r.title ?? "",
    link: r.link ?? "",
    snippet: r.snippet ?? "",
    source: r.source ?? "",
    date: r.date ?? "",
    domain: extractDomain(r.link ?? ""),
  }));
};
