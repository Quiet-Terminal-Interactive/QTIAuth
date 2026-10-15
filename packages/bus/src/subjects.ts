export const STREAMS = {
  events: {
    name: "QTIAUTH_EVENTS",
    subjects: [
      "qtiauth.identity.>",
      "qtiauth.oidc.>",
      "qtiauth.safety.>",
      "qtiauth.support.>",
      "qtiauth.games.>",
      "qtiauth.notifier.>",
      "qtiauth.audit.>",
      "qtiauth.backup.>",
      "qtiauth.gateway.>",
    ],
    retention: "limits" as const,
    maxAgeMs: 7 * 86_400_000,
  },
  cron: { name: "QTIAUTH_CRON", subjects: ["qtiauth.sys.cron.>"], retention: "limits" as const, maxAgeMs: 3_600_000 },
  queue: { name: "QTIAUTH_QUEUE", subjects: ["qtiauth.queue.>"], retention: "workqueue" as const, maxAgeMs: 3 * 86_400_000 },
};

export const SYS_ANNOUNCE = "qtiauth.sys.announce";
export const SYS_DISCOVER = "qtiauth.sys.discover";
export const SYS_CONFIG_RELOAD = "qtiauth.sys.reload";

export function rpcSubject(method: string): string {
  return `qtiauth.rpc.${method}`;
}

export function cronSubject(job: string): string {
  return `qtiauth.sys.cron.${job}`;
}

export function queueSubject(queue: string): string {
  return `qtiauth.queue.${queue}`;
}

export function eventSubject(service: string, entity: string, verb: string, version = 1): string {
  return `qtiauth.${service}.${entity}.${verb}.v${version}`;
}

export const EVENTS = {
  userCreated: "qtiauth.identity.user.created.v1",
  userUpdated: "qtiauth.identity.user.updated.v1",
  userDeleted: "qtiauth.identity.user.deleted.v1",
  userDeletionRequested: "qtiauth.identity.user.deletion_requested.v1",
  userDeletionCancelled: "qtiauth.identity.user.deletion_cancelled.v1",
  userBanned: "qtiauth.identity.user.banned.v1",
  userUnbanned: "qtiauth.identity.user.unbanned.v1",
  userLocked: "qtiauth.identity.user.locked.v1",
  userUnlocked: "qtiauth.identity.user.unlocked.v1",
  userRestricted: "qtiauth.identity.user.restricted.v1",
  userAgeBandChanged: "qtiauth.identity.user.age_band_changed.v1",
  userUsernameChanged: "qtiauth.identity.user.username_changed.v1",
  userSecurityAlert: "qtiauth.identity.user.security_alert.v1",
  userErased: (service: string) => `qtiauth.${service}.user.erased.v1`,
  sessionCreated: "qtiauth.identity.session.created.v1",
  sessionRevoked: "qtiauth.identity.session.revoked.v1",
  sessionFlagged: "qtiauth.identity.session.flagged.v1",
  legalVersionPublished: "qtiauth.identity.legal.version_published.v1",
  legalVersionEffective: "qtiauth.identity.legal.version_effective.v1",
  parentalConsentRequested: "qtiauth.identity.parental.consent_requested.v1",
  parentalConsentGranted: "qtiauth.identity.parental.consent_granted.v1",
  parentalConsentRevoked: "qtiauth.identity.parental.consent_revoked.v1",
  parentalRemovalRequested: "qtiauth.identity.parental.removal_requested.v1",
  parentalControlsChanged: "qtiauth.identity.parental.controls_changed.v1",
  parentalRequestCreated: "qtiauth.identity.parental.request_created.v1",
  parentalRequestDecided: "qtiauth.identity.parental.request_decided.v1",
  parentalGraduated: "qtiauth.identity.parental.graduated.v1",
  exportRequested: "qtiauth.identity.export.requested.v1",
  rolesChanged: "qtiauth.identity.roles.changed.v1",
  safetyReportCreated: "qtiauth.safety.report.created.v1",
  safetyReportActioned: "qtiauth.safety.report.actioned.v1",
  safetyReportDismissed: "qtiauth.safety.report.dismissed.v1",
  safetyReportSlaBreached: "qtiauth.safety.report.sla_breached.v1",
  safetyAppealCreated: "qtiauth.safety.appeal.created.v1",
  safetyAppealResolved: "qtiauth.safety.appeal.resolved.v1",
  safetyActionApplied: "qtiauth.safety.action.applied.v1",
  safetyActionLifted: "qtiauth.safety.action.lifted.v1",
  safetyContentRemovalRequested: "qtiauth.safety.content.removal_requested.v1",
  safetyCseaCaseOpened: "qtiauth.safety.csea.case_opened.v1",
  safetyLegalHoldPlaced: "qtiauth.safety.legal_hold.placed.v1",
  safetyLegalHoldReleased: "qtiauth.safety.legal_hold.released.v1",
  supportTicketCreated: "qtiauth.support.ticket.created.v1",
  supportTicketReplied: "qtiauth.support.ticket.replied.v1",
  supportTicketStatusChanged: "qtiauth.support.ticket.status_changed.v1",
  gamesEntitlementGranted: "qtiauth.games.entitlement.granted.v1",
  gamesEntitlementRevoked: "qtiauth.games.entitlement.revoked.v1",
  gamesAchievementUnlocked: "qtiauth.games.achievement.unlocked.v1",
  gamesStatUpdated: "qtiauth.games.stat.updated.v1",
  gamesLeaderboardEntry: "qtiauth.games.leaderboard.entry_submitted.v1",
  gamesPlaytimeRecorded: "qtiauth.games.playtime.recorded.v1",
  gamesGameCreated: "qtiauth.games.game.created.v1",
  oidcClientCreated: "qtiauth.oidc.client.created.v1",
  oidcClientSuspended: "qtiauth.oidc.client.suspended.v1",
  oidcConsentGranted: "qtiauth.oidc.consent.granted.v1",
  oidcTokenRevoked: "qtiauth.oidc.token.revoked.v1",
  oidcGuardianApprovalRequested: "qtiauth.oidc.guardian_approval.requested.v1",
  auditRecorded: "qtiauth.audit.recorded.v1",
  notifierEndpointDisabled: "qtiauth.notifier.webhook.endpoint_disabled.v1",
  backupCompleted: "qtiauth.backup.run.completed.v1",
  backupFailed: "qtiauth.backup.run.failed.v1",
} as const;
