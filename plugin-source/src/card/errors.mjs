// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class CardError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CardError";
    this.code = code;
    this.details = details;
  }
}
