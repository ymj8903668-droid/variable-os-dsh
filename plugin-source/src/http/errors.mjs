// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export class QueryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    this.details = details;
  }
}
