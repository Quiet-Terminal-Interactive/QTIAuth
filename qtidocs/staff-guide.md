---
title: Staff guide
description: Admin, moderation and CSEA cases, appeals, support tickets, the knowledge base and games admin.
order: 6
---

# Staff guide

Staff work from the account site: Admin (`/admin`) for users, safety, games and platform settings, and Staff (`/staff`) for support. You only see the sections your role's permissions allow. A disabled module's sections and permissions don't exist.

## Getting access

There are no default credentials. The first admin is created from the command line:

```sh
docker compose run --rm identity qtiauth admin create --email you@example.com
```

That prints a one-time signup link (valid for 24 hours by default). Admins then grant roles to other accounts on each user's page under Admin -> Users.

Two-step verification is mandatory for staff. Any account holding a permission that matches `security.require_2fa_for_permissions` (by default `*`, so every staff permission) is sent to set up an authenticator app or passkey before it can do anything else. Sensitive actions (bans, role changes, CSEA cases, secret rotation) also ask for a recent second factor (step-up).

## Roles and permissions

Built-in roles, editable under Admin -> Roles (needs `roles.manage`) or in `roles` in `qtiauth.yaml`:

| Role            | For                              | Key permissions                                                                                                                                               |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`         | Everything except CSEA cases     | `*`                                                                                                                                                           |
| `moderator`     | Reports, actions, appeals, flags | `users.read`, `safety.reports.read`, `safety.actions.apply`, `safety.appeals.resolve`, `safety.flags.read`                                                    |
| `support_agent` | Tickets                          | `users.read`, `support.tickets.staff`, `support.macros.manage`                                                                                                |
| `kb_editor`     | Knowledge base                   | `support.kb.edit`                                                                                                                                             |
| `game_manager`  | Catalogue, keys, entitlements    | `games.catalog.edit`, `games.entitlements.grant`, `games.keys.manage`, `games.achievements.moderate`, `games.leaderboards.moderate`, `games.licensing.manage` |

`safety.csea.access` is never matched by a wildcard, so not even `admin` has it. Grant it explicitly, and only to the people trained to handle CSEA material.

Every staff action is recorded in the audit log (Admin -> Audit, needs `audit.read`) with the actor, target and reason. The log is append-only and hash-chained. Run `qtiauth audit verify` to check it hasn't been tampered with.

## Users

Admin -> Users: search by username or email, then filter by state, age band, role or creation date. A user's page collects their profile, sign-in methods, sessions, security events, username history, guardians and, where those modules are enabled, moderation history, entitlements and tickets.

Available actions: ban, unban, lock (with an expiry), unlock, force re-authentication, revoke sessions, force a username reset, and edit the date of birth. Each one needs a reason, which is audited. Use the moderation flow below for anything prompted by a report, so the user gets a proper statement of reasons and can appeal.

## Moderation

Admin -> Safety shows the report queue, sorted by priority and SLA deadline. Each report has its type, the reported user, the content snapshot taken at report time, and the user's history.

- Apply an action: pick the action and the rule that was broken (both are required). The user automatically receives a statement of reasons naming the rule, the action, its duration and how to appeal.

  | Action                          | Effect                                                                                                      |
  | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | Warn                            | Notification only                                                                                           |
  | Restrict                        | Named restrictions (e.g. `chat`, `ugc`), optionally expiring. Games read them from the `restrictions` claim |
  | Force username reset            | The user must choose a new username                                                                         |
  | Lock                            | Temporary. The user can only reach appeals, support and their data rights                                   |
  | Ban                             | Permanent until lifted. Same access as a lock                                                               |
  | Remove content                  | Asks the originating game or service to remove the content                                                  |
  | Proscribed organisation removal | A ban with the terrorism reason code                                                                        |

- Dismiss when no rule was broken. The reporter is told the outcome either way, and is never identified to the reported user.
- Two-person bans: with `safety.bans.require_second_approval: true`, a permanent ban stays pending until a *second* moderator approves it from Admin -> Safety -> Actions.
- Flags (Admin -> Safety -> Flags) are machine-generated by games' classifiers. Flags at or above `safety.flag_auto_report_threshold` become reports automatically.
- Reports past their SLA are highlighted. SLA breaches also fire a webhook event and a Prometheus alert.

Rules, actions and the report taxonomy (types, subtypes, priorities and SLAs) are configured in `safety.rules`, `safety.actions` and `safety.taxonomy`. The accountable person for online safety (`safety.accountable_person`) is shown in the admin UI and the terms.

## Appeals

Restricted, locked and banned users can appeal each action once. With Support enabled, an appeal arrives as a support ticket linked to the action. Otherwise it appears under Admin -> Safety -> Appeals. Either way, resolve it by lifting the action or upholding it. The user is notified. Where possible, a different moderator from the one who took the action should review the appeal.

## CSEA cases

Reporting child sexual exploitation and abuse to the NCA has been a legal duty for every regulated user-to-user service since 7 April 2026, under The Online Safety (CSEA Content Reporting by Regulated User-to-User Service Providers) Regulations 2026 ([SI 2026/268](https://www.legislation.gov.uk/uksi/2026/268/made)).

Before the first case: register with the NCA through their portal. Name a senior manager as organisation administrator, plus an emergency contact and each person allowed to report (reg. 4–5). If you'll report to a body outside the UK (such as NCMEC) instead, tell the NCA (reg. 3(4)).

A report with a CSEA-flagged type, or one a moderator reclassifies, opens a CSEA case under Admin -> Safety -> CSEA. Only holders of `safety.csea.access` can see cases, and every view is audited. Opening a case automatically:

- copies the snapshot, the reported user's identifiers, registration IP, and every sign-in IP and port from the previous three months into the encrypted evidence store,
- places a legal hold, so the account's data survives deletion and its sign-in history isn't pruned,
- if the content came from a game, asks that game for the user's related data from the two weeks before (messages, comments, files, connections). The game's response is added as evidence.

Then:

1. Assess the priority level. The report must include it, and it sets how quickly you must report (reg. 6):

   | Level | When                                                             | Deadline in law                   | Internal target (`safety.nca_deadlines`) |
   | ----- | ---------------------------------------------------------------- | --------------------------------- | ---------------------------------------- |
   | 1     | Immediate threat to a child's life, or of serious harm           | Immediately                       | 1 hour                                   |
   | 2     | Possible serious harm soon, or urgent safeguarding may be needed | As soon as reasonably practicable | 24 hours                                 |
   | 3     | Neither                                                          | Without undue delay               | 72 hours                                 |

   Until you assess it, a case uses the `unassessed` target (1 hour).
2. Protect. One click locks the account and requests removal of the content.
3. Report. The case page lays out every field the regulations list (Schedule 1), already filled where QTIAuth or the game holds the information. Dates are DD/MM/YYYY, times are UTC and IPv6 addresses are written out in full, as the portal requires (Schedule 2). Each field shows where its value came from:
   - From QTIAuth: copy it across.
   - From the game: check the game's preservation response in the evidence, or ask the game's team.
   - You provide: your own details and the declaration.
   - Not held: QTIAuth has no billing details, phone numbers or recovery emails. Say so in the report.

   Submit through the portal, then record the NCA reference on the case. If information turns up later, send a supplementary report and record its reference too (reg. 6(5)). If the content was already reported to a body outside the UK, record that instead. It isn't reported again to the NCA.
4. Answer the NCA. Log any request the NCA sends you on the case. It must be answered within seven days (reg. 7). The case can't be closed while a request is open, and an overdue request raises an alert.
5. Close the case once it's reported. If review shows the content isn't CSEA, close it as not CSEA instead.

Retention (reg. 8). Evidence is kept for `safety.csea_evidence_retention` (at least one year) from the date the report was sent, not from when the case opened. A later supplementary report restarts that period. NCA references are kept for `safety.csea_reference_retention` (at least five years). Shorter settings are raised to these minimums. Evidence is then destroyed, and the case removed, with an audit record.

The only notification of a case is an email to `safety.csea_alert_emails` saying that a case exists, with a link. Case details never go to webhooks, email bodies, logs or analytics. Don't copy them into tickets, chat or anywhere else.

## Support

Staff -> Tickets (needs `support.tickets.staff`): filter by status, priority, category or assignee (Assigned to me and Unassigned are the usual views).

- Replies are emailed to the user. Internal notes never are.
- Change the status, priority and assignee from the ticket's sidebar.
- Canned replies (Staff -> Macros, needs `support.macros.manage`) insert prepared text. Seed shared ones in `support.macros`.
- Attachments are downloaded through short-lived links. Treat non-image files with care, as the warning says.
- Tickets waiting on the user close automatically after `support.auto_close_after` (7 days), with a reminder at the halfway point.
- Guest tickets come from people who can't sign in. They verified their email, but don't assume they own any particular account. Verify ownership before discussing account details.
- Staff -> Metrics shows first response time, resolution time and satisfaction, per agent and per category.

Choose which staff alerts you get (new tickets, high-priority reports) on your own account's notification settings.

## Knowledge base

Staff -> Knowledge base (needs `support.kb.edit`): write articles in Markdown, keep them as drafts until ready, then publish. Raw HTML is stripped. Every save is a revision, and you can diff and restore old ones. Tags and the title weigh most in search. Published articles are suggested to users while they type a ticket subject.

## Games

Admin -> Games (`games.catalog.edit`): create games (this generates the player and server clients. The server secret is shown once), products, achievements, stats and leaderboards. From there you can also:

- generate key batches (`games.keys.manage`) and export them as CSV, or revoke a batch,
- grant or revoke entitlements manually (`games.entitlements.grant`), always with a reason,
- revoke cheated achievement unlocks and remove leaderboard entries (`games.achievements.moderate`, `games.leaderboards.moderate`),
- revoke licence leases (`games.licensing.manage`).

See [integrating games](/integrating/games) for what developers do with these.

## OAuth clients

Admin -> OAuth clients: verify a client (`oidc.clients.verify`) once you've checked who runs it. This removes the "Unverified app" notice. Suspend a client (`oidc.clients.suspend`) to stop it signing anyone in immediately. Grant service scopes such as `games.entitlements.write` or `safety.intake` from the same page.

## Webhooks and email

- Admin -> Webhooks (`webhooks.manage`): add endpoints (`standard`, `discord` or `slack` format), choose events (wildcards such as `safety.report.*` work), send a test event, replay deliveries and rotate secrets. Endpoints are auto-disabled after `webhooks.disable_after_failures` consecutive failures and admins are emailed. Re-enable them once fixed. Payloads carry IDs and links only, never content.
- Admin -> Email: the delivery log and the suppression list. Remove an address from suppression only when its owner has confirmed it works again.

## Text filter

Admin -> Text filter: test how a username or text would be judged, and see which list entry matched. The base word lists are in `config/lists/`. Entries added here apply on top of them.
