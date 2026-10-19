// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { recordDeliveryInteraction } from "../delivery/delivery.mjs";
import { submitHumanLabel } from "../label/human-label.mjs";
import { submitMappingReview } from "../label/mapping-review.mjs";
import { submitHumanMiss } from "../miss/intake.mjs";
import { revealOutcome } from "../feedback/reveal.mjs";
import { submitBlindReplay } from "../audit/blind-reply.mjs";
import { materializeAuditMiss } from "../audit/materialize.mjs";
import { QueryError } from "./errors.mjs";

export async function handleCommand({ store, now, body, watchCalendar }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new QueryError("INVALID_COMMAND", "command body required");
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0) {
    throw new QueryError("INVALID_COMMAND", "idempotencyKey required");
  }
  if (!Array.isArray(body.expectedHeads)) {
    throw new QueryError("INVALID_COMMAND", "expectedHeads array required");
  }
  if (body.commandType === "recordDeliveryInteraction") {
    if (body.expectedHeads.length !== 0) {
      throw new QueryError("INVALID_COMMAND", "delivery requires empty expectedHeads");
    }
    return recordDeliveryInteraction({ store, now, command: body });
  }
  if (body.commandType === "submitHumanLabel") {
    return submitHumanLabel({ store, now, command: body, watchCalendar });
  }
  if (body.commandType === "submitMappingReview") {
    return submitMappingReview({ store, now, command: body, watchCalendar });
  }
  if (body.commandType === "submitHumanMiss") {
    return submitHumanMiss({ store, now, command: body });
  }
  if (body.commandType === "revealOutcome") {
    return revealOutcome({ store, now, command: body });
  }
  if (body.commandType === "submitBlindReplay") {
    return submitBlindReplay({ store, now, command: body });
  }
  if (body.commandType === "materializeAuditMiss") {
    return materializeAuditMiss({ store, now, command: body });
  }
  throw new QueryError("UNKNOWN_COMMAND", "unsupported commandType");
}
