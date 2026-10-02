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
- **Task policies:** configured runtime plus 60 seconds grace; next scheduled or pending-event execution more than three minutes overdue; configurable consecutive failures; three consecutive skipped runs. Historical failures retain their original source timestamp. A failure below the threshold is a one-off error (see below).
- **Per-task policy:** a task's detail sheet sets a success deadline ("must succeed within N minutes of its start") and its own failed-run threshold (`PUT /api/task-policies/:taskId`). A missed deadline, or a reached threshold of this policy, opens an incident on the first observation. Policies are local to the collector.
- **HTTP:** explicit expected status, GET-only, configurable timeout and interval, no redirects, at most 2 MB for JSON assertions. Targets may be loopback/private addresses, so protect the UI with operator-only access. Do not put credentials in URLs.
- **Assertions:** paths such as `$.output.verified` or `$.items[0].count`; operators `exists`, `eq`, `lt`, `gt`, `ageLessThan`, `dailyBy`. Age thresholds are milliseconds; timestamps require an explicit zone. `dailyBy` takes a local time (`"15:00"`) and needs the rule's IANA `timezone`: once that time has passed, the timestamp must fall on today's local date; before it, on yesterday's.
- **Result timestamp:** `evidenceTimestampPath` (for example `$.latest.finishedAt`) marks each distinct value as one execution. Re-reading the same failed result does not count as another failure, so one failed run stays a one-off error until another run fails. Missing data and invalid types produce unknown, except an explicit existence assertion fails.
- **Coverage:** service reachability and task execution do not verify business output. Add data assertions against the app's existing JSON API to verify freshness, counts or completion. This release does not infer business calendars, content correctness or causal dependencies.

### One-off errors

A failure below its incident threshold is a **one-off error** (`transient`): a single failed or skipped task run, or a probe failing fewer than `failAfter` times. It is never healthy, never an incident and never notified; the overview lists it apart from what needs attention, together with checks that failed in the last 24 hours and pass again ("cleared"). A repeat failure that reaches the threshold opens an incident. A running task within its deadline shows as running, not as missing evidence.

### Incidents

Each rule has opening/recovery thresholds. Incidents are persisted separately from observations. Unknown does not resolve an incident; acknowledgement, notification mute and pause also leave it open. Consecutive passing observations close it with evidence. Paused custom probes do not run. Automatic checks can be paused without changing the underlying service or task.

The collector runs independently of Space tasks. It scans every 5 minutes by default; Settings changes the interval (1–60 minutes) without a restart. It never overlaps its own scans, caps probe concurrency and preserves its state across restarts. Expired observations become unknown on read, including when the collector itself stops. Custom intervals are minimum intervals; actual start includes collector cadence and scan duration.

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
| POST | `/api/incidents/:id` | Acknowledge an incident |
| PUT | `/api/settings` | Local scan interval, detection and notification settings |
| PUT | `/api/task-policies/:taskId` | `{deadlineMinutes, errorThreshold}`; empty clears |
| GET | `/api/widget` | Space panel summary |

Mutation endpoints require JSON and an HTTP(S) Origin matching the request host and port (TLS terminates at Space ingress); cross-site browser requests are rejected. This is CSRF protection, not identity authentication. Loopback and the configured private access layer establish identity. Peer snapshot reads must travel through the authenticated Space peer connection or a private tunnel.

## Deployment

Set up the public Access policy before registering the app (the wildcard router exposes new apps automatically). Run `bash deploy/bootstrap.sh <ssh-host>` from this checkout after `bun run check`; it installs a bare Git receiver and the repeatable hook, pushes main, and lets Space provision and supervise the service. Subsequent deployments are `git push <remote> main`. The hook installs locked dependencies before restarting and validates `/healthz` afterwards. See AGENTS.md for host-specific operator notes.

### Recovery after completion outside the scheduler

An HTTP rule can explicitly map to a local task using `recoveryTaskId` and `evidenceTimestampPath` (for example `$.latest.finishedAt`). It must contain success assertions. A fresh, enabled, passing rule with a valid completion timestamp **newer than** the task's failed/skipped execution supplies recovery evidence. Normal consecutive-pass thresholds then close the incident and keep the evidence in its history. A newer task failure invalidates older completion evidence. Unreachable, paused, failed, expired or invalid evidence cannot recover a task; overdue and stalled checks cannot be overridden. Running alone is unknown, not recovery. This mapping is configuration, with no app-specific logic in the collector.
