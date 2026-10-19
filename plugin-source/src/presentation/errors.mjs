// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class PresentationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PresentationError";
    this.code = code;
    this.details = details;
  }
}
