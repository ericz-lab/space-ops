# Space Ops

A general-purpose operations center for ai-space. Independent collectors discover services and scheduled tasks, run reusable HTTP/JSON checks, record evidence, and track incidents through recovery. One Apple-inspired interface shows the local machine and its peers.

## Run

```sh
bun install
bun run dev
# http://127.0.0.1:8998
bun run check
```

Space provisions the SQLite database, service environment and panel widget through `space.yaml`. No runtime dependencies or third-party fonts, analytics, or UI assets are required. `.env.example` lists configuration. `SPACE_NAME` identifies the collector; the hostname is its fallback. `SPACE_API_URL` selects the local Space API. The page follows browser language and appearance, with persistent overrides in Settings.

## Checks

- **Automatic discovery:** local active services, enabled tasks, source reachability, peer collectors, memory/load and disk at the data directory.
- **Task policies:** configured runtime plus 60 seconds grace; next scheduled or pending-event execution more than three minutes overdue; configurable consecutive failures; three consecutive skipped runs with no successful run in the last 24 hours (a no-op run after a success means "up to date"). A skip that answers a `reason` and no `error` (for example `{ "status": "skipped", "reason": "market_closed" }` on a holiday) is a planned no-op: healthy, even under an error threshold of one, and never counted as a repeated skip. Historical failures retain their original source timestamp. A failure below the threshold is a one-off error (see below).
- **Per-task policy:** a task's detail sheet sets a success deadline ("must succeed within N minutes of its start") and its own failed-run threshold (`PUT /api/task-policies/:taskId`). A missed deadline, or a reached threshold of this policy, opens an incident on the first observation. Policies are local to the collector.
- **HTTP:** explicit expected status, GET-only, configurable timeout and interval, no redirects, at most 2 MB for JSON assertions. Targets may be loopback/private addresses, so protect the UI with operator-only access. Do not put credentials in URLs.
- **Assertions:** paths such as `$.output.verified` or `$.items[0].count`; operators `exists`, `eq`, `lt`, `gt`, `ageLessThan`, `dailyBy`. Age thresholds are milliseconds; timestamps require an explicit zone. `dailyBy` takes a local time (`"15:00"`) and needs the rule's IANA `timezone`: once that time has passed, the timestamp must fall on today's local date; before it, on yesterday's.
- **Active weekdays:** optional `weekdays` (0 = Sunday through 6 = Saturday, nonempty and unique) requires an explicit `timezone`. Omitted means every day. Off days skip the HTTP request and show **not scheduled**, without passing or resolving an existing incident. Before a `dailyBy` deadline, the previous active date is required. For example, `[2,3,4,5,6]` in `Asia/Shanghai` skips Sunday and Monday and requires Saturday’s result before Tuesday’s deadline. Rule edits preserve this calendar in the UI.
- **Result timestamp:** `evidenceTimestampPath` (for example `$.latest.finishedAt`) marks each distinct value as one execution. Re-reading the same failed result does not count as another failure, so one failed run stays a one-off error until another run fails. Missing data and invalid types produce unknown, except an explicit existence assertion fails.
- **Coverage:** service reachability and task execution do not verify business output. Add data assertions against the app's existing JSON API to verify freshness, counts or completion. This release does not infer business calendars, content correctness or causal dependencies.

### Inspection (点检)

Apps declare the day's work in their `space.yaml` under `checks:` (ai-space docs/app-spec.md#checks); Space lists them at `GET /api/checks` with the loopback URL to read. Each scan reads every declared check (GET, 8 s, no redirects, 2 MB, this machine's loopback only) and shows it on the Inspection page as **done**, **pending** (not done before its `due` time), **late** (not done after `due`, or with no `due`), **off** (its `when` assertions fail: nothing is due today) or **unknown** (unreachable, missing field, or a reading older than the scan lease). The page also shows when each item was last done.

An inspection item is not a check of the fault model: it never opens an incident, never notifies and is not counted in the overview. Being not done yet is usually only "not time yet"; business calendars belong to the app, which answers `open`/`done` for the session it expects. Snapshots carry `inspections`, so the hub shows its peers' items read-only. A failing `GET /api/checks` is the `Space checks` source check, like the other discovery sources.

### One-off errors

A failure below its incident threshold is a **one-off error** (`transient`): a single failed or skipped task run, or a probe failing fewer than `failAfter` times. It is never healthy, never an incident and never notified; the overview lists it apart from what needs attention, together with checks that failed in the last 24 hours and pass again ("cleared"). A repeat failure that reaches the threshold opens an incident. A running task within its deadline shows as running, not as missing evidence.

### Incidents

Each rule has opening/recovery thresholds. Incidents are persisted separately from observations. Unknown does not resolve an incident; acknowledgement, notification mute and pause also leave it open. Consecutive passing observations close it with evidence. Paused custom probes do not run. Automatic checks can be paused without changing the underlying service or task.

Incidents are also the operator's fault record (故障事件):

- **Open one by hand** from any check (one open incident per check) or for something no check covers. An operator's incident stays open until someone marks it resolved; the check recovering is recorded on it, not acted on.
- **Repair records** (notes) can be added to any incident, open or resolved. The opening event, notes, acknowledgement and resolution are never trimmed from the timeline.
- **Mark resolved** closes any incident with an optional resolution note. A check still failing then counts from zero: it opens a new incident only after failing `failAfter` times again (a re-read of the same failed result does not count).
- Records name the operator from the Space ingress identity (`cf-access-authenticated-user-email`) when present.
- **Scan records:** each bar of the overview's scan history opens what was wrong at that time: the incidents open then and, for the local machine, every check that was failing, one-off or recovering in that scan.

The collector runs independently of Space tasks. It scans every 5 minutes by default; Settings changes the interval (1–60 minutes) without a restart. It never overlaps its own scans, caps probe concurrency and preserves its state across restarts. Expired observations become unknown on read, including when the collector itself stops. Custom intervals are minimum intervals; actual start includes collector cadence and scan duration.

## Diagnosis (一键排查)

**Diagnose** in the toolbar (or on the Reports page) starts one AI diagnosis of the machine selected in the sidebar, or of every machine (this one and its peers) when none is. For each machine Space Ops gathers the evidence it can read there, bounded: the latest scan (every check that is not healthy, with code, value and timestamps), open incidents and those resolved in the last day, the last runs of failing tasks with their errors, failed model calls in the last day from the Space ledger, and the recent log of each application with a problem. A peer's evidence is collected by the peer's own Space Ops (`GET /api/evidence`, this machine only, reused for a minute) and read through the authenticated Space peer proxy, like its snapshot. When that fails (an older release, the peer unreachable), the report uses the peer's last snapshot and marks its task runs, model calls and logs as not read. An agent on the Space model service (tag `diagnose`, default `codex/advanced` from `space.yaml`, resolved to the model of that tier; Settings → App models can override it) writes a report: conclusion, scope, findings with evidence, likely cause and suggested action, and the checks it could not complete. It analyses the evidence it is given and has no shell: the runtime may run on another host. Nothing is repaired.

- One run at a time: the button is disabled while a run is in flight and a second request answers `409` with the running report. The run continues if the page is closed; the page follows it every few seconds.
- Every run is a report on the **Reports** page, kept on the machine that ran it, kept in SQLite (the latest 200), with status (running, completed, failed), time, the machines and applications covered, the evidence sources and whether each was read, the model that answered, and the report. A run that fails or times out (15 minutes) keeps its reason and offers **Retry**; one cut by a restart is marked failed on boot.
- Service logs are read through `OPS_LOGS_COMMAND` (`{app}`, `{lines}`), set per machine in the workspace `.env` and passed in by `space.yaml`. Without it the report lists the logs as not checked.

## Peers

Deploy the same app on each Space. A collector discovers configured Space peers and reads `/api/peers/:peer/apps/space-ops/proxy/api/snapshot`. Snapshots contain local observations only, preventing recursive fan-out. Failed refreshes retain the last snapshot as unknown. Peer data and controls are read-only in the hub UI.

`OPS_PEERS` optionally supplies a JSON array of `{name,url}` for additional independently reachable snapshot endpoints (for example, a loopback SSH tunnel). It does not invent reverse peers or transport credentials. A third-party monitor is required to detect simultaneous loss of all collectors.

## Notifications

Off by default. Enable in Settings to send future opening/recovery transitions through the Space default channel. The host must have a working notification channel and `SPACE_APP_TOKEN`. Events enqueue transactionally and retry with backoff up to ten attempts; exhausted entries are visible in Settings. Mute suppresses newly enqueued transitions. Disabling notifications clears queued messages. Space delivery acceptance is not confirmation of arrival in the chat app.

## Storage and time

SQLite in `DATABASE_URL`, otherwise `${SPACE_APP_DATA_DIR}/main.db`, otherwise local `data/main.db`. Observation timestamps are integer Unix milliseconds; new JSON APIs use UTC ISO instants. Structured documents persist their explicitly zoned API timestamps. Display uses the browser's IANA timezone, independently of language. Observation retention defaults to 30 days (`OPS_RETENTION_DAYS`); incident history is retained.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Collector progress health; 503 before first scan or after expiry |
| GET | `/api/snapshot` | Versioned local-only observations, incidents and scan history |
| GET | `/api/dashboard` | Local snapshot, peers, custom rules, settings and notification state |
| GET | `/api/checks/:id` | Check evidence and recent probe history |
| POST | `/api/scan` | Start a coalesced scan; 202 |
| POST / PUT | `/api/rules` / `/api/rules/:id` | Create / update a validated custom rule |
| PATCH | `/api/checks/:id` | `{enabled}` or `{muteMinutes}` |
| POST | `/api/incidents` | Open an incident: `{checkId}` or `{name, app?}`, plus `{detail, severity?}`; 201 |
| POST | `/api/incidents/:id/ack` | Acknowledge (also `POST /api/incidents/:id`) |
| POST | `/api/incidents/:id/notes` | Add a repair record `{text}` |
| POST | `/api/incidents/:id/resolve` | Mark resolved, optional `{text}` |
| GET | `/api/scans/:at` | Non-passing checks of the scan finished at that instant |
| PUT | `/api/settings` | Local scan interval, detection and notification settings |
| PUT | `/api/task-policies/:taskId` | `{deadlineMinutes, errorThreshold}`; empty clears |
| GET | `/api/reports` | Diagnosis reports, newest first, without their body |
| GET | `/api/reports/:id` | One report with its body |
| POST | `/api/reports` | Start a diagnosis `{lang, machine?}` (`machine` omitted or `all` = every machine); 202, or 409 with the running report |
| GET | `/api/evidence` | This machine's diagnosis evidence, for a peer that diagnoses it; never fans out |
| GET | `/api/widget` | Space panel summary |

Mutation endpoints require JSON and an HTTP(S) Origin matching the request host and port (TLS terminates at Space ingress); cross-site browser requests are rejected. This is CSRF protection, not identity authentication. Loopback and the configured private access layer establish identity. Peer snapshot reads must travel through the authenticated Space peer connection or a private tunnel.

## Deployment

Set up the public Access policy before registering the app (the wildcard router exposes new apps automatically). Run `bash deploy/bootstrap.sh <ssh-host>` from this checkout after `bun run check`; it installs a bare Git receiver and the repeatable hook, pushes main, and lets Space provision and supervise the service. Subsequent deployments are `git push <remote> main`. The hook installs locked dependencies before restarting and validates `/healthz` afterwards. See AGENTS.md for host-specific operator notes.

### Recovery after completion outside the scheduler

An HTTP rule can explicitly map to a local task using `recoveryTaskId` and `evidenceTimestampPath` (for example `$.latest.finishedAt`). It must contain success assertions. A fresh, enabled, passing rule with a valid completion timestamp **newer than** the task's failed/skipped execution supplies recovery evidence. Normal consecutive-pass thresholds then close the incident and keep the evidence in its history. A newer task failure invalidates older completion evidence. Unreachable, paused, failed, expired or invalid evidence cannot recover a task; overdue and stalled checks cannot be overridden. Running alone is unknown, not recovery. This mapping is configuration, with no app-specific logic in the collector.
