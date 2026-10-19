// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const DENIED_ERROR_NAMES = new Set([
  "NotAllowedError",
  "PermissionDeniedError",
  "SecurityError",
]);

const UNAVAILABLE_ERROR_NAMES = new Set([
  "DevicesNotFoundError",
  "NotFoundError",
]);

export async function inspectResearchHostMicrophonePermission({ permissions } = {}) {
  if (!permissions?.query) return { status: "unsupported" };
  try {
    const permission = await permissions.query({ name: "microphone" });
    const status = String(permission?.state || "");
    return ["granted", "prompt", "denied"].includes(status)
      ? { status }
      : { status: "unsupported" };
  } catch {
    return { status: "unsupported" };
  }
}

export async function requestResearchHostMicrophoneAccess({ mediaDevices } = {}) {
  if (!mediaDevices?.getUserMedia) return { status: "unsupported" };

  let stream = null;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
    return { status: "granted" };
  } catch (error) {
    const name = String(error?.name || "");
    if (DENIED_ERROR_NAMES.has(name)) return { status: "denied" };
    if (UNAVAILABLE_ERROR_NAMES.has(name)) return { status: "unavailable" };
    return { status: "failed" };
  } finally {
    for (const track of stream?.getTracks?.() || []) {
      try { track?.stop?.(); } catch { /* best-effort probe cleanup */ }
    }
  }
}
