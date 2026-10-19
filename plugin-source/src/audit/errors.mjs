// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class AuditError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new AuditError(code, message, details);
}
