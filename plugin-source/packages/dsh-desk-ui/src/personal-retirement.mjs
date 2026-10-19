// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export function assertPersonalRetirement(events, sessionId) {
  const event = events?.[0];
  if (!Array.isArray(events) || events.length !== 1 || event?.type !== "cancellation"
    || event.sessionId !== sessionId || event.retired !== true
    || !["cancelled", "not-active"].includes(event.receipt?.status)) {
    throw Object.assign(Error("RETIREMENT_UNCONFIRMED"), { code: "RETIREMENT_UNCONFIRMED" });
  }
}

// A new selection does not replace the cleanup barrier for any older session.
export function createPersonalRetirements({ cancel, onChange = () => {} }) {
  const pending = new Map(), unconfirmed = new Set();
  const state = () => ({ pending: pending.size, unconfirmed: unconfirmed.size });
  const retire = id => {
    if (pending.has(id)) return pending.get(id);
    const completion = Promise.resolve().then(() => cancel(id)).then(
      receipt => { unconfirmed.delete(id); return receipt; },
      () => { unconfirmed.add(id); return null; },
    ).finally(() => { pending.delete(id); onChange(state()); });
    pending.set(id, completion);
    onChange(state());
    return completion;
  };
  return Object.freeze({ state, retire, retry: () => Promise.all([...unconfirmed].map(retire)) });
}
