// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** Reuse the existing health contract; never cache a query result or old score. */
export function projectionVersion(response) {
  const health = response?.result;
  if (!response?.ok || response.projectionStatus !== "COMPLETE" ||
      health?.projectionStatus !== "COMPLETE" || health.projectionStale !== false ||
      health.watermarksConsistent !== true || !health.ledgerWatermark ||
      health.ledgerWatermark !== health.projectionLedgerWatermark || !health.projectionDigest) return null;
  return JSON.stringify([health.ledgerWatermark, health.projectionDigest, health.snapshotId || null]);
}

/** A Host proof of unchanged originals, bound to the same authorized source. */
export function publicationSnapshotReadable(response, version, sourceRevision) {
  const proofs = response?.result?.readablePublicationSnapshots;
  if (!version || !projectionVersion(response) || !/^[a-f0-9]{64}$/.test(sourceRevision ?? "")
    || response.sourceRevision !== sourceRevision || response.result.stateAuthority !== "PUBLISHED_READ_MODEL"
    || !Array.isArray(proofs) || proofs.length > 2) return false;
  if (!proofs.every(proof => proof && Object.keys(proof).length === 2
    && /^[a-f0-9]{64}$/.test(proof.ledgerWatermark ?? "")
    && /^[a-f0-9]{64}$/.test(proof.projectionDigest ?? ""))) return false;
  return proofs.some(proof => JSON.stringify([proof.ledgerWatermark, proof.projectionDigest, null]) === version);
}

/** Health remains independent of a slow full refresh, so fail-closed is immediate. */
export function createDeskRefreshController({ readHealth: requestHealth, refresh, getVersion,
  onHealth = () => {}, isVisible = () => true, subscribeVisibility = () => () => {},
  subscribeReadPolicy = () => () => {}, intervalMs = 30_000,
}) {
  let disposed = false, epoch = 0, pending = null, refreshing = null, desiredVersion = null, timer = null;
  let readEligible = Boolean(isVisible());
  const readHealth = ({ fresh = false } = {}) => {
    if (disposed || !isVisible()) return Promise.resolve(null);
    if (pending?.epoch === epoch) return fresh
      ? pending.promise.then(() => readHealth())
      : pending.promise;
    const generation = epoch;
    const promise = Promise.resolve().then(() => {
      if (disposed || generation !== epoch || !isVisible()) return null;
      return requestHealth();
    })
      .catch(() => ({ ok: false, error: { code: "HEALTH_UNAVAILABLE" } }))
      .then((response) => {
        if (disposed || generation !== epoch || !isVisible()) return null;
        // The full reader also uses this path to recheck after downloading.
        desiredVersion = projectionVersion(response);
        onHealth(response);
        return response;
      }).finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { epoch: generation, promise };
    return promise;
  };
  const reload = (allowFollowUp = true) => {
    if (disposed || !isVisible() || refreshing || !desiredVersion || desiredVersion === getVersion()) return;
    const version = desiredVersion;
    refreshing = Promise.resolve().then(refresh).catch(() => {})
      .finally(() => {
        refreshing = null;
        // Coalesce one newer observation without waiting 30 seconds. Continuous
        // writes must not turn catch-up into an unbounded full-download loop.
        if (allowFollowUp && desiredVersion !== version) reload(false);
      });
  };
  const check = async () => {
    const response = await readHealth();
    if (!response) return;
    reload();
  };
  const visibilityChanged = () => {
    epoch++;
    clearInterval(timer); timer = null;
    readEligible = Boolean(isVisible());
    if (!disposed && readEligible) {
      timer = setInterval(() => void check(), intervalMs);
      void check();
    }
  };
  const unsubscribe = subscribeVisibility(visibilityChanged);
  const unsubscribePolicy = subscribeReadPolicy(() => {
    // A source-mode change is not a document visibility event. Only a changed
    // read policy rearms polling; ordinary invalidation must not start a loop.
    if (!disposed && Boolean(isVisible()) !== readEligible) visibilityChanged();
  });
  if (readEligible && timer === null) timer = setInterval(() => void check(), intervalMs);
  return { check, readHealth, dispose() {
    if (disposed) return;
    disposed = true; epoch++; clearInterval(timer); unsubscribe(); unsubscribePolicy();
  } };
}
