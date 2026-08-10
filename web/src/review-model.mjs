const cleanReason = (value) => String(value || '').trim();

const unverifiedClaims = (generation) => (generation?.claims || [])
  .filter((claim) => claim.status === 'unverified');

export function approvalReadiness(generation, overrideReasons = {}) {
  const missingClaimIds = unverifiedClaims(generation)
    .filter((claim) => !cleanReason(overrideReasons[claim.id]))
    .map((claim) => claim.id);
  return {ready: missingClaimIds.length === 0, missingClaimIds};
}

export function buildApprovalPayload({revisionId, approvedBy, generation, overrideReasons = {}}) {
  const readiness = approvalReadiness(generation, overrideReasons);
  if (!readiness.ready) {
    throw new Error(`Override reason required for: ${readiness.missingClaimIds.join(', ')}`);
  }
  const operator = String(approvedBy || '').trim();
  if (!operator) throw new Error('Approver is required');
  return {
    revisionId,
    approvedBy: operator,
    claimOverrides: unverifiedClaims(generation).map((claim) => ({
      claimId: claim.id,
      reason: cleanReason(overrideReasons[claim.id]),
    })),
  };
}

export function projectWorkflowActions({project, latestRevision = null, videoState = 'unknown'}) {
  const draft = latestRevision?.status === 'draft';
  const approved = latestRevision?.status === 'approved';
  return {
    canEdit: (project.status === 'review_required' && draft) || (project.status === 'approved' && approved),
    canApprove: project.status === 'review_required' && draft,
    canRender: project.status === 'approved' && approved,
    canDownload: project.status === 'completed' && approved && videoState === 'ready',
  };
}
