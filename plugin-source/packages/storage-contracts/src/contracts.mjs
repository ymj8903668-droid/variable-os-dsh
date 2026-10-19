// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const STORAGE_CONTRACT_VERSION = "research-storage-contract-v1";

export class StorageContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "StorageContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new StorageContractError(code, message, details);
}

export function assertBrandedId(prefix, value) {
  if (
    typeof prefix !== "string" ||
    !/^[a-z][a-z0-9]*_$/.test(prefix) ||
    typeof value !== "string" ||
    !new RegExp(`^${prefix}[a-f0-9]{64}$`).test(value)
  ) {
    fail("STORAGE_ID_INVALID", "stable id does not match its branded prefix", {
      prefix,
    });
  }
  return value;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function assertDecimalString(value) {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    fail(
      "STORAGE_DECIMAL_INVALID",
      "decimal values must cross the storage boundary as canonical strings",
    );
  }
  return value;
}

export function assertRepositoryPort(repository, methods) {
  if (
    repository === null ||
    typeof repository !== "object" ||
    !Array.isArray(methods) ||
    methods.length === 0 ||
    methods.some(
      (method) => typeof method !== "string" || typeof repository[method] !== "function",
    )
  ) {
    fail("STORAGE_PORT_INVALID", "repository does not implement the required port");
  }
  return repository;
}
