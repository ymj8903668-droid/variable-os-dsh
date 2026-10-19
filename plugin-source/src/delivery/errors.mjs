// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class DeliveryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
    this.details = details;
  }
}
