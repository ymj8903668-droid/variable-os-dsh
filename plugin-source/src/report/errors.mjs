// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class ReportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ReportError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new ReportError(code, message, details);
}
