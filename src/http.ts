/** fetch + JSON with retry on 429/5xx. Throws on any other non-2xx, with the body. */
export async function requestJson(
  url: string,
  init: RequestInit,
  label: string,
  tries = 4,
): Promise<any> {
  let lastErr = "";
  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await fetch(url, init);
    const body = await res.text();
    if (res.ok) {
      if (!body) return {};
      try {
        return JSON.parse(body);
      } catch {
        return { raw: body };
      }
    }
    lastErr = `${label} ${res.status}: ${body.slice(0, 300)}`;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 3000 * attempt);
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
