/**
 * Every failure the SDK raises for an API response. Mirrors the contract in docs/api-contract.md §2:
 * `code` is from the closed set, `retryable` is the field an automation branches on, `param` names
 * the offending parameter when there is one.
 *
 * An answer with no error envelope — a proxy's HTML 502, a bare 429 — names no code, and `code` says so with `null`
 * rather than a code the service never sent. `status` and `retryable` still say what happened: without a `retryable`
 * of its own, a 429 or a 5xx is one, anything else is not.
 */
export class ImageStepError extends Error {
  constructor({ status, code, message, retryable, param, details, retryAfter, requestUrl, requestId }) {
    super(message || `ImageStep request failed (${status})`);
    this.name = "ImageStepError";
    this.status = status;
    this.code = code || null;
    this.retryable = retryable ?? (status === 429 || status >= 500);
    this.param = param ?? null;
    this.details = details ?? null;
    /** Seconds to wait before retrying, when the service said so (429). */
    this.retryAfter = retryAfter ?? null;
    this.requestUrl = requestUrl;
    /**
     * The id the service gave this request (`error.requestId`, else the `X-Request-Id` header) — the
     * handle to quote when reporting a failure (contract §11). Null for errors raised before a response.
     */
    this.requestId = requestId ?? null;
  }
}

/** A job that finished in a state other than COMPLETED, or did not finish in time. */
export class JobFailedError extends Error {
  constructor(job, reason) {
    super(reason || `Job ${job?.id} ended as ${job?.status}`);
    this.name = "JobFailedError";
    this.job = job;
    this.retryable = false;
  }
}
