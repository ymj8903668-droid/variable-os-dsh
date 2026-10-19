// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class FeedbackError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "FeedbackError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new FeedbackError(code, message, details);
}
