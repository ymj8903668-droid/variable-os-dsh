// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export function shouldRefreshCsrfPayload(payload) {
  return payload?.error?.code === "CSRF_INVALID";
}

export function shouldRecoverXiaomeiSessionOwnership(errorCode, attempt = 0) {
  return errorCode === "XIAOMEI_SESSION_OWNERSHIP_CONFLICT" && attempt === 0;
}

export function createPersistentRequestSlot() {
  let controller = null;
  return Object.freeze({
    attach(next) {
      if (!next || typeof next.abort !== "function") {
        throw new TypeError("persistent request slot requires an AbortController");
      }
      if (controller && controller !== next) {
        throw new Error("persistent request slot is already occupied");
      }
      controller = next;
      return next;
    },
    current() {
      return controller;
    },
    isCurrent(expected) {
      return Boolean(expected && controller === expected);
    },
    clear(expected) {
      if (expected && controller !== expected) return false;
      const existed = Boolean(controller);
      controller = null;
      return existed;
    },
    abort() {
      if (!controller) return false;
      const active = controller;
      controller = null;
      active.abort();
      return true;
    },
  });
}

async function responseHasInvalidCsrf(response) {
  if (!response || response.status !== 403 || typeof response.clone !== "function") {
    return false;
  }
  const payload = await response.clone().json().catch(() => null);
  return shouldRefreshCsrfPayload(payload);
}

export async function fetchWithCsrfRecovery({
  request,
  refresh,
  signal,
}) {
  if (typeof request !== "function" || typeof refresh !== "function") {
    throw new TypeError("CSRF recovery requires request and refresh functions");
  }
  const response = await request();
  if (signal?.aborted || !(await responseHasInvalidCsrf(response))) {
    return response;
  }
  const refreshed = await refresh();
  if (!refreshed || signal?.aborted) return response;
  return request();
}
