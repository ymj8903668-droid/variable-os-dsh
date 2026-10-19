// SPDX-License-Identifier: GPL-3.0-only
/** Larger replies are allowed only for explicit, bounded card snapshot reads. */
export function cardSnapshotPageLimit(params = {}) {
  return (params.readSnapshot === 'start' || /^[a-f0-9]{32}$/.test(params.readSnapshot ?? ''))
    && Number.isInteger(params.limit) && params.limit > 100 && params.limit <= 500 ? params.limit : 100;
}

export function cardSnapshotResponseBytes(method, route) {
  const url = new URL(route, 'https://edge.invalid');
  const params = Object.fromEntries(url.searchParams);
  return method === 'GET' && url.pathname === '/v1/cards'
    && [...url.searchParams.keys()].length === Object.keys(params).length
    && /^[1-9]\d{0,2}$/.test(params.limit ?? '')
    && cardSnapshotPageLimit({...params, limit: Number(params.limit)}) > 100 ? 5 * 1024 * 1024 : 1024 * 1024;
}
