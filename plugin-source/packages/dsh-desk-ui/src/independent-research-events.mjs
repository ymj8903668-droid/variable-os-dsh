// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const listeners = new Set();
export function subscribeIndependentResearch(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function invalidateIndependentResearch() {
  for (const listener of listeners) listener();
}
