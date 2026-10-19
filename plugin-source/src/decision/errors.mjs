// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class DecisionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
    this.details = details;
  }
}
