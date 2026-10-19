// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class MissError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "MissError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new MissError(code, message, details);
}
