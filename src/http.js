export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchRetry(url, opts = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  const retryOn = [429, 500, 502, 503, 504];
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (retryOn.includes(res.status) && i < retries) {
        await sleep(400 * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(400 * 2 ** i);
    }
  }
  throw lastErr;
}

export async function pMap(items, fn, concurrency = 5) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
