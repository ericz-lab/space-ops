# Space Ops — agent guide

Read README.md before changing behavior. Motivation and scope: GitHub issue #1.

## Rules

- Bun 1.3+, strict TypeScript, ESM with `.ts` imports. No runtime dependencies.
- English code and documentation; all UI strings have English and Chinese translations.
- General-purpose probes only. Never hardcode an application's business policy or machine name in detection code.
- Unknown, stale, disabled and absent data must never be reported as healthy. Execution success does not establish business success.
- Preserve incident history. Acknowledgement, mute and pause never resolve a fault. Recovery requires new passing evidence.
- Observations and incidents are local to their collector. Peer snapshots are read-only, nonrecursive and marked stale on loss.
- HTTP probes are GET-only, bounded, do not follow redirects, and never forward Space credentials to their targets.
- Bind loopback. Browser writes require same-origin JSON. Public deployment requires an access policy before registration.
- Follow ai-space docs/time.md: UTC instants in API, explicit units, browser timezone for display.
- The diagnosis agent gets evidence in its prompt, never a shell: the model runtime may be on another host. A source it did not read is listed as not checked. It never repairs. Each collector gathers only its own machine's evidence (`/api/evidence`, nonrecursive like snapshots); the diagnosing machine reads its peers' through the Space peer proxy (60 s limit, so evidence collection stays bounded).
- Run `bun run check` before every push. Commit messages follow Conventional Commits.

## Repository map

- `src/`: schema, reusable rules/probes, collector, API and colocated tests. `diagnose.ts` is the one-click AI diagnosis: evidence collection, the model call (tag `diagnose`), report parsing.
- `web/`: responsive UI on the Space Tiles kit (ai-space docs/ui-kit.md): `kit.css` is the app's copy of the kit (refresh it from `/_space/ui.css`, never edit it), imported into layer `kit`; the page adds the space's `/_space/ui.css` in layer `space`; `style.css` holds only this app's rules in layer `app`, written with the kit's tokens and `sp-` classes. English/Chinese dictionaries, HTML bundled by Bun. Page rules (ai-space docs/app-spec.md#app-pages): the head script applies `?theme=` and `?lang=` over the stored `ops-theme` and `ops-language` before first paint; the manifest's `url: /?lang={lang}&accent={accent}` brings the panel's accent, which the next head script keeps under `space.accent` and sets as an unlayered `--accent` (ai-space docs/ui-kit.md#accent). `room.ts` draws the Machine room (CSS 3D cabinets); `rack.ts` holds its tested state rules.
- `agents/`: system prompts of the panel's agents: `operator.md` (read-only operations assistant) and `engineer.md` (Platform Engineer, who holds the `space` and `bun` write tools the operator lacks).
- `skills/space-ops/`: portable read-only system status and troubleshooting workflow; `src/inspect.ts` queries local evidence and authenticated peer proxies.
- `deploy/`: repeatable Git deployment bootstrap and post-receive hook.
- `.githooks/`: pre-push validation hook (`git config core.hooksPath .githooks`).
- `data/`: ignored local development database.
- `artifacts/`: ignored screenshots and validation output.

## Deployment

Source: `~/.ai-space/app-src/space-ops`. Each machine that runs it is a git remote of this checkout, named after the machine. The service listens on port 8998. The deployed checkout is `${SPACE_HOME:-$HOME/.ai-space}/apps/space-ops`; a bare repository at `~/space-ops.git` receives pushes. Space manages `space-space-ops.service`. Use `git push <machine> main` for every machine after validation; never edit the deployed source. Machine identities and peer URLs are environment configuration, never embedded in probes.

Only the hub has a public route, and it must sit behind operator-only access (unauthenticated requests redirect to login). A peer has no route of its own: the hub reads its snapshot through the authenticated Space peer proxy. Every peer must set `SPACE_APP_URL_SPACE_OPS` to the hub's Space Ops url in its workspace `.env` (and restart Space so it is read); with the same url the hub panel shows one tile and one widget card (Space's same-url rule), otherwise a second Space Ops tile appears. No hostname, ssh alias, bucket or machine-specific url belongs in this repository: keep them in the workspace environment.

## Usage measurement

App pages load `/_space/usage.js` at runtime through the Space router. It records visible, recently active time without page content or credentials. Refresh existing tabs after deployment; earlier unmeasured time cannot be recovered. Direct-port access has no Space heartbeat endpoint. `usage.test.ts` checks every application page loader; run it with `bun test usage.test.ts`.

## Installation package

`bun run pack [-- --out DIR]` builds `<name>-<version>.spaceapp` (ai-space docs/app-packages.md) from this tree without changing it; `scripts/pack.ts` explains how. `space.yaml` stays spec 1 for the git deployment; the package's spec-2 manifest is made from it, with `version` from `package.json` and the files, launch mode and offline notes from `spacePackage` there. A package runs on a port ai-space assigns: nothing may assume the manifest's port (the package's entry writes the assigned one to `<data dir>/service.port`). Machine settings of a package install go in `<workspace>/data/<app>/.env`. Bump `version` for each package released; install with `space app install`, upgrade with `space app upgrade`. A machine is served by the git deployment or by a package, never both.
