// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
// Bounds apply to serialized UTF-8, including JSON escaping, not character count.
export const PUBLISHED_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_ENVELOPE_MAX_BYTES = PUBLISHED_DOCUMENT_MAX_BYTES + 65536;
// MCP includes both the structured object and its JSON text representation.
export const DOCUMENT_RPC_MAX_BYTES = PUBLISHED_DOCUMENT_MAX_BYTES * 3 + 65536;

// Explicit structured research context; complete documents are never truncated.
export const STOCK_CONTEXT_MAX_BYTES = 256 * 1024;
export const STOCK_CONTEXT_RPC_MAX_BYTES = STOCK_CONTEXT_MAX_BYTES * 3 + 65536;
