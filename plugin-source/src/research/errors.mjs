// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class ResearchError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new ResearchError(code, message, details);
}
