import { getApiUrl } from "./apiUrl.ts";
import { log } from "./cli.ts";

type ApiFetchOptions = {
  path: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * fetch wrapper for the ReviewX API.
 */
export async function apiFetch(options: ApiFetchOptions): Promise<Response> {
  const apiUrl = getApiUrl();
  const url = new URL(options.path, apiUrl);

  const headers: Record<string, string> = {
    ...options.headers,
  };

  // never send Content-Type on body-less requests. empirically, Vercel's
  // Next.js lambda adapter (Next 16.1.x) throws `SyntaxError: Unexpected
  // end of data` before delegating to the route handler — returning a 500 —
  // when Content-Type is set but no body is present. exact mechanism is
  // unverified (minified runtime frame), but Content-Type on a body-less
  // request has no defined semantics per RFC 9110 §8.3 anyway. see #692.
  if (!options.body) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  log.debug(`api fetch: ${options.method ?? "GET"} ${url.pathname}`);

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body) init.body = options.body;
  if (options.signal) init.signal = options.signal;

  return fetch(url.toString(), init);
}
