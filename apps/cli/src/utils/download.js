import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ImageStepError } from "imagestep";
import { NetworkError, cliFetch, client } from "./service.js";

/**
 * Download an asset's private bytes: `GET /api/v1/assets/{id}/content` answers 302 to a signed
 * storage URL, and that URL is fetched WITHOUT the API key (#233) — which is why the redirect is read
 * here instead of being followed by fetch, which would forward the Authorization header to storage.
 * One home for that rule: `asset download` and `jobs outputs --download` both come through here. The SDK's own
 * `assets.download` reads the bytes into memory; this streams them to a file, which is why the CLI keeps its own.
 *
 * @param {string} assetId
 * @param {{ variant?: string, file?: string, dir?: string }} [opts] `file` wins; else `<dir>/<id><ext>`
 * @returns {Promise<{ target: string, bytes: number }>}
 */
async function downloadAsset(assetId, opts = {}) {
  try {
    return await downloadOnce(assetId, opts);
  } catch (error) {
    if (!error.timedOut) throw error;
    return downloadOnce(assetId, opts); // a stall is worth one more try: the URL is signed afresh, the bytes are unchanged
  }
}

/**
 * How long a download may wait (#527): for the answer's headers, and between two chunks of its body. There was no limit
 * at all, and a storage connection that stopped sending hung `jobs outputs --download` for good.
 */
const TIMEOUTS = { headersMs: 30_000, idleMs: 60_000 };

/** `fetch` that gives up when the headers take longer than `headersMs`; the caller's `signal` then guards the body. */
async function fetchWithin(url, init, controller) {
  const timer = setTimeout(
    () =>
      controller.abort(
        Object.assign(new NetworkError(`no answer from ${new URL(url).host} in ${TIMEOUTS.headersMs / 1000} s`), { timedOut: true })
      ),
    TIMEOUTS.headersMs
  );
  try {
    return await cliFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadOnce(assetId, { variant = "readable", file, dir = "." } = {}) {
  const api = client();
  const url = `${api.baseUrl}/api/v1/assets/${encodeURIComponent(assetId)}/content?variant=${encodeURIComponent(variant)}`;
  const headers = { Authorization: `ApiKey ${api.apiKey}`, Accept: "application/json", "User-Agent": api.userAgent };
  const res = await fetchWithin(url, { headers, redirect: "manual" }, new AbortController());
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) {
    const e = (await res.json().catch(() => null))?.error || {};
    throw new ImageStepError({
      status: res.status,
      code: e.code,
      message: e.message || `content answered ${res.status} without a redirect`,
      retryable: e.retryable,
      param: e.param,
      details: e.details,
      requestUrl: url,
      requestId: e.requestId ?? res.headers.get("x-request-id")
    });
  }
  const controller = new AbortController();
  const stored = await fetchWithin(location, {}, controller);
  if (!stored.ok) throw new Error(`Download from storage failed (${stored.status})`);
  const subtype = (stored.headers.get("content-type") || "").split(";")[0].split("/")[1];
  const extension = subtype ? `.${subtype === "jpeg" ? "jpg" : subtype}` : "";
  const target = file || path.join(dir, `${assetId}${extension}`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  // Streamed to a temporary name, renamed when complete (#527): the bytes are never whole in memory, and a download
  // that fails leaves no half-written file under the name a script would read.
  const partial = `${target}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let bytes = 0;
  let idle;
  const stalled = () =>
    controller.abort(Object.assign(new NetworkError(`download of ${assetId} stalled for ${TIMEOUTS.idleMs / 1000} s`), { timedOut: true }));
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      clearTimeout(idle);
      idle = setTimeout(stalled, TIMEOUTS.idleMs);
      done(null, chunk);
    }
  });
  idle = setTimeout(stalled, TIMEOUTS.idleMs);
  try {
    await pipeline(Readable.fromWeb(stored.body), counter, fs.createWriteStream(partial));
    await fs.promises.rename(partial, target);
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(idle);
  }
  return { target, bytes };
}

export { downloadAsset, TIMEOUTS };
