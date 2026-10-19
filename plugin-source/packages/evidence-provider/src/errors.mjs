// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const ERROR_CODES = Object.freeze([
  "AUTH_REQUIRED", "FORBIDDEN_SCOPE", "SOURCE_UNAVAILABLE",
  "NO_RESULT", "TIME_BOUNDARY", "CANCELLED",
]);

const MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Authentication is required",
  FORBIDDEN_SCOPE: "The requested dataset scope is not allowed",
  SOURCE_UNAVAILABLE: "The evidence source or operation is unavailable",
  NO_RESULT: "No evidence matched the request",
  TIME_BOUNDARY: "The requested time boundary cannot be guaranteed",
  CANCELLED: "The request was cancelled",
});

export class EvidenceProviderError extends Error {
  constructor(code, details = null) {
    if (!ERROR_CODES.includes(code)) throw new TypeError("Unknown evidence error code");
    super(MESSAGES[code]);
    this.name = "EvidenceProviderError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function providerError(code, reason) {
  return new EvidenceProviderError(code, reason ? { reason } : null);
}

export function unsupported(operation) {
  return new EvidenceProviderError("SOURCE_UNAVAILABLE", {
    reason: "UNSUPPORTED_CAPABILITY", operation,
  });
}

export function sourceError(error) {
  return error instanceof EvidenceProviderError
    ? error
    : providerError("SOURCE_UNAVAILABLE", "SOURCE_FAILURE");
}

/** Cancel delivery even when a legacy reader cannot interrupt its underlying I/O. */
export async function runCancellable(signal, operation) {
  if (signal?.aborted) throw providerError("CANCELLED");
  return new Promise((resolve, reject) => {
    const cancel = () => reject(providerError("CANCELLED"));
    signal?.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw providerError("CANCELLED");
      return operation();
    }).then(
      (value) => signal?.aborted ? cancel() : resolve(value),
      (error) => signal?.aborted ? cancel() : reject(sourceError(error)),
    ).finally(() => signal?.removeEventListener("abort", cancel));
  });
}
