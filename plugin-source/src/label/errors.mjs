// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class LabelError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "LabelError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new LabelError(code, message, details);
}
