// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class SchemaError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
    this.details = details;
  }
}
