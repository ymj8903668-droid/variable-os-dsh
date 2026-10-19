// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { resolveAShareHorizons } from "../card/horizon.mjs";
import { fail } from "./errors.mjs";
import { computeExposureSet } from "./exposure.mjs";
import {
  ACTOR_ID,
  POLICY_VERSION,
  WATCH_RULE_VERSION,
  clockOf,
  committedEventsOf,
  envelope,
  isTerminalState,
  latestStateEvent,
  loadCalendar,
  watchTaskForLabel,
} from "./helpers.mjs";

const ALLOWED_SESSIONS = new Set([1, 3, 5]);

function shanghaiDate(labeledAt) {
  if (typeof labeledAt !== "string" || labeledAt.length < 10) {
    fail("INVALID_WATCH_HORIZON", "labeledAt is required");
  }
  return labeledAt.slice(0, 10);
}

export function resolveWatchDueAt({ labeledAt, sessions, calendar }) {
  if (!ALLOWED_SESSIONS.has(sessions)) {
    fail("INVALID_WATCH_HORIZON", "WATCH horizon must be 1, 3, or 5 sessions");
  }
  if (!calendar) {
    fail("INVALID_WATCH_HORIZON", "synthetic calendar required");
  }
  const date = shanghaiDate(labeledAt);
  const probe = `${date}T09:25:00+08:00`;
  const resolved = resolveAShareHorizons({
    evaluationAnchorAt: probe,
    calendar,
  });
  const slot = resolved.horizons[`T${sessions}`];
  if (!slot || typeof slot.scheduledAt !== "string") {
    fail("INVALID_WATCH_HORIZON", "WATCH due date is not computable");
  }
  return slot.scheduledAt;
}

export function watchMembers({
  assignId,
  targetCommitGroupId,
  now,
  actorType,
  actorId,
  correlationId,
  card,
  labelId,
  reviewDueAt,
}) {
  const taskId = brandedId("rt_", { watchLabelId: labelId });
  const stateId =
    typeof assignId === "function"
      ? assignId("workflow-state-event-v1", "watch-scheduled")
      : brandedId("state_", { objectId: taskId, toState: "SCHEDULED" });
  const task = envelope({
    schema: "review-task-v1",
    id: taskId,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      objectRef: { type: "CARD_REVISION", id: card.id },
      reason: "WATCH_DUE",
      watchLabelId: labelId,
      reviewDueAt,
      earlyWakeRelations: ["REINFORCES", "UPDATES", "CONTRADICTS"],
      priorityBucket: "WATCH_RETURN",
      ruleVersion: WATCH_RULE_VERSION,
      idempotencyKey: `watch-task:${labelId}`,
      createdAt: now,
    },
  });
  const scheduled = envelope({
    schema: "workflow-state-event-v1",
    id: stateId,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      objectType: "REVIEW_TASK",
      objectId: taskId,
      objectRevisionId: null,
      fromState: null,
      toState: "SCHEDULED",
      previousStateEventId: null,
      stateVersion: 1,
      expectedHeadId: null,
      expectedStateVersion: null,
      occurredAt: now,
      reason: "WATCH_SCHEDULED",
      idempotencyKey: `watch-scheduled:${labelId}`,
    },
  });
  return [task, scheduled];
}

export function cancelWatchMembers({
  assignId,
  targetCommitGroupId,
  now,
  actorType,
  actorId,
  correlationId,
  events,
  watchLabelId,
}) {
  const task = watchTaskForLabel(events, watchLabelId);
  if (!task) {
    return [];
  }
  const current = latestStateEvent(events, task.id);
  if (current && isTerminalState(current.toState)) {
    return [];
  }
  const canceled = envelope({
    schema: "workflow-state-event-v1",
    id: assignId("workflow-state-event-v1", "watch-canceled"),
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      objectType: "REVIEW_TASK",
      objectId: task.id,
      objectRevisionId: null,
      fromState: current ? current.toState : "SCHEDULED",
      toState: "CANCELED",
      previousStateEventId: current ? current.id : null,
      stateVersion: current ? current.stateVersion + 1 : 2,
      expectedHeadId: current ? current.id : null,
      expectedStateVersion: current ? current.stateVersion : 1,
      occurredAt: now,
      reason: "LABEL_SUPERSEDED",
      idempotencyKey: `watch-canceled:${watchLabelId}`,
    },
  });
  return [canceled];
}

export async function openWatchTaskForNewEvidence({
  store,
  now = () => new Date().toISOString(),
  watchLabelId,
  relation = "UPDATES",
}) {
  if (typeof watchLabelId !== "string" || watchLabelId.length === 0) {
    fail("INVALID_COMMAND", "watchLabelId required");
  }
  const allowed = new Set(["REINFORCES", "UPDATES", "CONTRADICTS"]);
  if (!allowed.has(relation)) {
    fail("INVALID_COMMAND", "unsupported early-wake relation");
  }
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const task = watchTaskForLabel(projected.events, watchLabelId);
  if (!task) {
    fail("INPUT_REF_MISMATCH", "watch task is not committed");
  }
  const current = latestStateEvent(projected.events, task.id);
  if (current && current.toState !== "SCHEDULED") {
    return {
      commitGroupId: current.commitGroupId,
      reused: true,
      memberRecordIds: [current.id],
    };
  }
  const label = projected.events.find((row) => row.id === watchLabelId);
  const card = projected.events.find(
    (row) =>
      row.schema === "variable-card-revision-v1" &&
      row.id === (task.objectRef && task.objectRef.id),
  );
  if (card) {
    computeExposureSet({
      events: projected.events,
      actorId: ACTOR_ID,
      card,
    });
  }
  const semanticKey = `watch-open-v1:${watchLabelId}`;
  return runtime.execute({
    commandType: "openWatchTaskForNewEvidence",
    idempotencyKey: semanticKey,
    actorType: "SYSTEM",
    actorId: "system:demo-runner",
    correlationId: `watch-open:${watchLabelId}`,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      watchLabelId,
      toState: "OPEN",
    },
    immutableInputRefs: [
      { type: "REVIEW_TASK", id: task.id },
      label ? { type: "HUMAN_LABEL", id: label.id } : null,
    ].filter(Boolean),
    builderVersion: "watch-open-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({ assignId, targetCommitGroupId, now: stamped, committedProjection }) => {
      const events = committedEventsOf(committedProjection);
      const liveTask = watchTaskForLabel(events, watchLabelId);
      if (!liveTask || liveTask.id !== task.id) {
        fail("HEAD_CONFLICT", "watch task changed");
      }
      const liveState = latestStateEvent(events, liveTask.id);
      if (liveState && liveState.toState !== "SCHEDULED") {
        fail("HEAD_CONFLICT", "watch task is not SCHEDULED");
      }
      const opened = envelope({
        schema: "workflow-state-event-v1",
        id: assignId("workflow-state-event-v1", "watch-open"),
        now: stamped,
        actorType: "SYSTEM",
        actorId: "system:demo-runner",
        correlationId: `watch-open:${watchLabelId}`,
        targetCommitGroupId,
        extra: {
          objectType: "REVIEW_TASK",
          objectId: liveTask.id,
          objectRevisionId: null,
          fromState: liveState ? liveState.toState : "SCHEDULED",
          toState: "OPEN",
          previousStateEventId: liveState ? liveState.id : null,
          stateVersion: liveState ? liveState.stateVersion + 1 : 2,
          expectedHeadId: liveState ? liveState.id : null,
          expectedStateVersion: liveState ? liveState.stateVersion : 1,
          occurredAt: stamped,
          reason: "NEW_EVIDENCE",
          idempotencyKey: semanticKey,
        },
      });
      return [{ file: "events", record: opened }];
    },
  });
}

export { loadCalendar };
