// Related Test Accounts — pure logic (no I/O), shared by routes/testData.js and
// covered by tests. One stored record links TWO independent Test Data
// records; the accounts themselves are never touched.
//
// Record shape (the same for the JSON file store and Postgres):
//   {
//     id,
//     accountAId, accountBId,   // stable internal Test Data ids (never National IDs)
//     relationshipType,         // what account B is to account A   ("Wife")  — always set
//     inverseRelationshipType,  // what account A is to account B   ("Husband") — null when unknown
//     isReciprocal,             // true exactly when an inverse label exists
//     createdBy, createdByMemberId, createdAt, updatedAt, updatedBy
//   }
//
// "A lists B as Wife" is shown on A's panel as `Wife — B`. On B's panel the
// same record is shown as `Husband — A` when an inverse label exists. When it
// does not (custom labels, "Guardian"), B still shows the connection but with
// a neutral "Linked" label, never an invented reverse: a relationship is only
// reciprocal when the label's known mapping or the user says so.

const MAX_LABEL = 60;

// Labels whose reverse is known from the label alone. Gendered family labels
// reverse to the neutral label (we do not store gender), "Guardian" and
// anything custom have NO entry on purpose — they are never reversed blindly.
const KNOWN_INVERSES = {
  husband: "Wife",
  wife: "Husband",
  father: "Child",
  mother: "Child",
  parent: "Child",
  son: "Parent",
  daughter: "Parent",
  child: "Parent",
  brother: "Sibling",
  sister: "Sibling",
  sibling: "Sibling",
};

// Common suggestions offered by the UI (free text is always allowed too).
const SUGGESTED_LABELS = [
  "Husband", "Wife", "Father", "Mother", "Son", "Daughter",
  "Brother", "Sister", "Parent", "Child", "Guardian", "Other",
];

function cleanLabel(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}
function labelKey(raw) {
  return cleanLabel(raw).toLowerCase();
}
function knownInverse(label) {
  const hit = KNOWN_INVERSES[labelKey(label)];
  return hit || null;
}

// What `other` is to `viewerId` according to record `rel` — i.e. the label
// shown next to the other account on the viewer's panel. null = no label on
// this side (the link is one-way).
function labelSeenBy(rel, viewerId) {
  if (rel.accountAId === viewerId) return rel.relationshipType || null;
  if (rel.accountBId === viewerId) return rel.inverseRelationshipType || null;
  return null;
}
function otherAccountId(rel, viewerId) {
  if (rel.accountAId === viewerId) return rel.accountBId;
  if (rel.accountBId === viewerId) return rel.accountAId;
  return null;
}
function involves(rel, accountId) {
  return rel.accountAId === accountId || rel.accountBId === accountId;
}

// Normalises the two labels a user supplied (always the full pair, from one
// account's point of view) into the stored shape: `relationshipType` is
// always non-empty (swapping A/B if the only label given is the inverse one).
//   labelOfOther : what the other account is to the acting account
//   labelOfSelf  : what the acting account is to the other (optional)
function canonicalize(selfId, otherId, labelOfOther, labelOfSelf) {
  const other = cleanLabel(labelOfOther);
  const self = cleanLabel(labelOfSelf);
  if (!other && !self) return { error: "Enter the relationship — for example Wife, Son, or any label of your own." };
  if (other) {
    return { accountAId: selfId, accountBId: otherId, relationshipType: other, inverseRelationshipType: self || null };
  }
  // Only the "self is X to other" label exists: store it as the primary label
  // of the reverse orientation so relationshipType is never empty.
  return { accountAId: otherId, accountBId: selfId, relationshipType: self, inverseRelationshipType: null };
}

// A candidate duplicates an existing record when, on the same pair of
// accounts, either account would see the other under the same label (case-
// insensitive). Covers "A→B Wife" vs the same link entered from B's side as
// "Husband"/"Wife"; different labels on the same pair may coexist.
function isDuplicate(existingRels, cand, excludeId) {
  for (const r of existingRels) {
    if (!r || r.id === excludeId) continue;
    const samePair =
      (r.accountAId === cand.accountAId && r.accountBId === cand.accountBId) ||
      (r.accountAId === cand.accountBId && r.accountBId === cand.accountAId);
    if (!samePair) continue;
    for (const viewer of [cand.accountAId, cand.accountBId]) {
      const a = labelSeenBy(r, viewer);
      const b = labelSeenBy(cand, viewer);
      if (a && b && labelKey(a) === labelKey(b)) return r;
    }
  }
  return null;
}

// One link request from the API: { otherId, relationshipType, inverseRelationshipType? }.
// `inverseRelationshipType` undefined -> fill from the known mapping (if any);
// "" / null -> explicitly none.
function validateLinkRequest(selfId, link, accountsById, existingRels) {
  const otherId = link && typeof link.otherId === "string" ? link.otherId : "";
  if (!otherId) return { error: "Choose the account to link." };
  if (otherId === selfId) return { error: "An account cannot be linked to itself." };
  if (!accountsById.has(selfId)) return { error: "Test data record not found." };
  if (!accountsById.has(otherId)) return { error: "The account you chose no longer exists." };
  const labelOfOther = cleanLabel(link.relationshipType);
  let labelOfSelf;
  if (link.inverseRelationshipType === undefined) labelOfSelf = knownInverse(labelOfOther) || "";
  else labelOfSelf = cleanLabel(link.inverseRelationshipType);
  const c = canonicalize(selfId, otherId, labelOfOther, labelOfSelf);
  if (c.error) return { error: c.error };
  const dup = isDuplicate(existingRels, c, null);
  if (dup) return { error: "These accounts are already linked with this relationship.", duplicateId: dup.id, status: 409 };
  return { clean: c };
}

function buildRecord(clean, id, actor, now) {
  return {
    id,
    accountAId: clean.accountAId,
    accountBId: clean.accountBId,
    relationshipType: clean.relationshipType,
    inverseRelationshipType: clean.inverseRelationshipType,
    isReciprocal: !!clean.inverseRelationshipType,
    createdBy: (actor && actor.name) || "Unknown",
    createdByMemberId: (actor && actor.id) || null,
    createdAt: now,
    updatedAt: now,
  };
}

// Edit from `perspectiveId`'s point of view. Returns { clean } (fields to
// merge into the record) or { error }.
function validateUpdateRequest(rel, perspectiveId, body, existingRels) {
  if (!involves(rel, perspectiveId)) return { error: "That account is not part of this relationship." };
  const otherId = otherAccountId(rel, perspectiveId);
  const c = canonicalize(perspectiveId, otherId, body && body.relationshipType, body && body.inverseRelationshipType);
  if (c.error) return { error: c.error };
  const dup = isDuplicate(existingRels, c, rel.id);
  if (dup) return { error: "These accounts are already linked with this relationship.", duplicateId: dup.id, status: 409 };
  return { clean: c };
}

// True when `clean` says exactly what `rel` already says (each account sees the
// other under the same label), whichever way round A/B were written.
function sameLabels(rel, clean) {
  for (const viewer of [rel.accountAId, rel.accountBId]) {
    if (labelSeenBy(rel, viewer) !== labelSeenBy(clean, viewer)) return false;
  }
  return involves(clean, rel.accountAId) && involves(clean, rel.accountBId);
}

// Relationships whose accounts no longer exist (should not happen — account
// deletion removes them — but a hand-edited file or an interrupted delete
// must never surface a broken reference).
function splitOrphans(rels, accountIds) {
  const ok = [];
  const orphans = [];
  for (const r of rels) {
    if (r && accountIds.has(r.accountAId) && accountIds.has(r.accountBId) && r.accountAId !== r.accountBId) ok.push(r);
    else if (r) orphans.push(r);
  }
  return { ok, orphans };
}

module.exports = {
  MAX_LABEL, KNOWN_INVERSES, SUGGESTED_LABELS,
  cleanLabel, labelKey, knownInverse, labelSeenBy, otherAccountId, involves,
  canonicalize, isDuplicate, validateLinkRequest, buildRecord, validateUpdateRequest, sameLabels, splitOrphans,
};
