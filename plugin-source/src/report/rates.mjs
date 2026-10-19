// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { fail } from "./errors.mjs";

function incomputable(reasonCodes) {
  return {
    status: "NOT_COMPUTABLE",
    reasonCodes,
    numerator: null,
    denominator: null,
    rate: null,
  };
}

function ratio(numerator, denominator) {
  if (denominator === 0) {
    return incomputable(["NO_QUALIFIED_DENOMINATOR"]);
  }
  return {
    status: "COMPUTABLE",
    reasonCodes: [],
    numerator,
    denominator,
    rate: numerator / denominator,
  };
}

export function assertSameSnapshot(left, right) {
  if (!left || !right || left.id !== right.id || left.membersHash !== right.membersHash) {
    fail("SAME_SNAPSHOT_REQUIRED", "A/B must use the same cohort snapshot");
  }
}

export function northStarRates(snapshot) {
  if (!snapshot || snapshot.schema !== "metric-cohort-snapshot-v1") {
    fail("NOT_FOUND", "cohort snapshot is required");
  }
  if (snapshot.computationStatus !== "COMPUTABLE") {
    const blocked = incomputable(
      snapshot.notComputableReasonCodes && snapshot.notComputableReasonCodes.length
        ? snapshot.notComputableReasonCodes
        : ["SNAPSHOT_NOT_COMPUTABLE"],
    );
    return {
      snapshotId: snapshot.id,
      membersHash: snapshot.membersHash,
      A: { ...blocked, snapshotId: snapshot.id, membersHash: snapshot.membersHash },
      B: { ...blocked, snapshotId: snapshot.id, membersHash: snapshot.membersHash },
    };
  }
  const members = snapshot.members || [];
  const fakeAi = members.filter(
    (row) =>
      row.cohortRole === "AI_TIMELY" &&
      (row.reasonCodes || []).includes("MISS_ORIGIN_NOT_AI"),
  );
  if (fakeAi.length) {
    const blocked = incomputable(["HUMAN_MISS_AS_AI"]);
    return {
      snapshotId: snapshot.id,
      membersHash: snapshot.membersHash,
      A: { ...blocked, snapshotId: snapshot.id, membersHash: snapshot.membersHash },
      B: { ...blocked, snapshotId: snapshot.id, membersHash: snapshot.membersHash },
    };
  }
  const ai = members.filter((row) => row.cohortRole === "AI_TIMELY");
  const liveMiss = members.filter(
    (row) => row.cohortRole === "HUMAN_ONLY_LIVE_MISS",
  );
  const denominator = ai.length + liveMiss.length;
  const a = ratio(ai.length, denominator);
  const bNum = ai.filter(
    (row) =>
      row.firstHumanPresentedAt &&
      row.firstReactionAt &&
      row.firstHumanPresentedAt < row.firstReactionAt,
  ).length;
  const b = ratio(bNum, denominator);
  return {
    snapshotId: snapshot.id,
    membersHash: snapshot.membersHash,
    A: {
      ...a,
      snapshotId: snapshot.id,
      membersHash: snapshot.membersHash,
      name: "OBSERVED_TIMELY_ACTIONABLE_DECISION_RECALL",
    },
    B: {
      ...b,
      snapshotId: snapshot.id,
      membersHash: snapshot.membersHash,
      name: "OBSERVED_TIMELY_DELIVERED_RECALL",
    },
  };
}
