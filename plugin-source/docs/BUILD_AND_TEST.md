# Build and Test

This document describes the full development checkout. A standalone plugin
or source-companion archive does not include that checkout's test suites,
development workspace or private QA records. To rebuild the source companion,
use the included [standalone build instructions](PLUGIN_SOURCE_BUILD.md).
The commands below apply only to a full development checkout.

Use a new checkout or materialized candidate, not a live owner installation.
Use a fresh HOME and a short temporary directory. Do not source a production
`.env`, select production storage, or provide owner Wiki paths or credentials.
All commands below are run from the repository root unless stated otherwise.

## Runtime and Dependencies

The synthetic CLI needs Node 24 with built-in SQLite and FTS5. The development
baseline is Node 24.19.0 and pnpm 11.25.0. Put both executables on PATH: package
build commands also call pnpm. This alpha migration tree has a committed root
workspace lock. Use the root installation described in `docs/DEVELOPMENT.md`
in the full development checkout:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PWD/.local-demo/dev-store"
node --test scripts/development-dependencies.test.mjs scripts/development-workspace-entry.test.mjs
```

This installs the ten development workspace projects with exact SDK peers;
automatic peer installation and lifecycle scripts remain disabled. It does not
build the browser client or first-party bundles, or start PostgreSQL, DSH,
source workers or a model. Run builds explicitly in a disposable source copy. The
storage package's unit imports require its dependencies even without a database.
Do not replace a failed frozen install with an unlocked update.
Package-local workspace and lock files are archived under `docs/legacy-workspace`;
all nine package directories now resolve the root workspace. Keep the standalone
`plugin-source-build-deps` build workspace separate. The standalone
`profiles/public-tools` toolchain now pins the same official alpha CLI with a frozen
lock and disables lifecycle scripts. A fresh macOS HOME/store/cache installation,
then offline pnpm/DSH version checks and official web-profile composition, passed.
The source installer now initializes its custom profile from the official web
profile template, reuses Host SDK peers, disables dependency lifecycle scripts,
and explicitly builds first-party UI artifacts. A second fresh macOS Chinese HOME
passed source installation, native notice persistence across restart, the default
published-card surface without model credentials, and unified settings rendering.
This is not a new complete card lifecycle acceptance. The native settings sidebar
still compresses the form at 390px; narrow settings usability remains unqualified.
Existing SDK shadows or retired runtime/patch policies fail without deleting user
state. Optional memory and explicit worker migration retain their entrypoints but
have not been exercised against live integrations in this qualification.

## Synthetic Core

```sh
node scripts/check.mjs
node --test --test-reporter=tap scripts/public-smoke.test.mjs scripts/acceptance.test.mjs
node --test --test-reporter=tap 'src/**/*.test.mjs'
node --test --test-reporter=tap 'src/golden/*.golden.test.mjs'
node scripts/acceptance.mjs
```

`acceptance.mjs` reruns check, core and golden tests and writes
`.local-demo/evidence/acceptance.json` plus the actual command logs. It requires a
complete TAP summary, a successful exit and no failed, cancelled, skipped or todo
tests. Its scope is `synthetic-core`, not all packages or production.
`e2e.status` and `health.status` remain `NOT_RUN`; external data is `NOT_SCANNED`
with a null presence value. Run the browser suite separately.

The private owner tree also contains Grok worker tests. Those files are excluded
from the public candidate, so report each tree's measured counts separately.
Generic timing, process-boundary, dataset and recovery tests still run in the
candidate; missing optional components must not prevent importing the core.

## Shared Packages

No database process is required for this unit and fixture command:

```sh
node --test --test-reporter=tap \
  'packages/storage-contracts/test/*.test.mjs' \
  'packages/storage-postgres/test/unit/*.test.ts' \
  'packages/evidence-provider/test/*.test.mjs' \
  'packages/publication-edge/test/**/*.test.mjs' \
  'packages/publication-worker/test/*.test.mjs' \
  'packages/edge-mcp-bridge/test/*.test.mjs' \
  'packages/dsh-tools/*.test.mjs'
```

This is not PostgreSQL integration, RLS, recovery, a live IMA/Tavily account,
or a real installed DSH Host. Do not infer those results from fixture tests.

## DSH UI Package

```sh
pnpm --dir packages/dsh-desk-ui build
pnpm --dir packages/dsh-desk-ui test
```

The command runs the current full package test glob. Three model contracts now
use real private profiles and native credential records. Two deleted-SDK
Settings test modules (25 historical internal cases) and one manual gate (2)
are archived byte-for-byte under docs/legacy-settings; they are retired, not
passing or skipped tests. Their earlier load failures remain in task receipts.
The five manual browser drivers now use real private/native credentials and
passed 13 synthetic Chromium viewport scenarios; this is not an official Host
installation. The unused legacy fixture is archived too. The full checkout's
`docs/SETTINGS_MIGRATION.md` records that development migration; it is not
included in the standalone distribution.
The candidate retains generic Host, narration-controller, remote
packaging and all eleven duplex protocol tests. Five tests stay private with
their excluded implementations: one Grok analyzer test, one Python voice-worker
test and three voice CLI tests. They remain in the private package's unchanged
test glob; none is skipped. Shared-core relocation does not require the optional
Python voice worker.

These are unit and synthetic loopback tests, not proof that a real installed
DSH Host starts or that a physical microphone, speaker or model works.

## Synthetic Browser Suite

Provide an installed Playwright package and its matching Chromium. The variable
points to the directory containing the `playwright` package, not to its binary.
The loader does not download a browser or install anything automatically.

```sh
export VARIABLE_OS_BUNDLED_NODE_MODULES="/absolute/path/to/test-tools/node_modules"
node tests/e2e/run.mjs
node tests/e2e/run.mjs tests/e2e/report.spec.mjs
```

The default command executes eighteen viewport scenarios across nine specs. It seeds
synthetic data, starts only loopback HTTP on an ephemeral port and closes the
browser and server. This tests the standalone synthetic UI, not an installed
DSH Host. A missing browser is a failure, not a skip.

## Synthetic Demo

```sh
node src/cli.mjs reset
node src/cli.mjs scan
node src/cli.mjs evaluate
node src/cli.mjs report
node src/server.mjs
```

The demo freezes its dates in August 2026; it is not current market data. The
server listens on `127.0.0.1:8787`. Stop it after use. Do not use the demo reset
against live data or a configured external ledger.

## Release Boundaries

The distributed first-party grant is GPL-3.0-only; see the root LICENSE and
NOTICE. Separately installed Wiki engines and vendor voice resources are not
included. Explicitly selecting a missing owner Grok analyzer must fail without
retrieval or fallback model calls.

Clean DSH installation, Host startup, PostgreSQL recovery, load acceptance,
real-data review and publication are separate gates. Clean installation uses a
fresh candidate and HOME, the pinned toolchain, standard Host startup, RPC,
installed tools/MCP, desktop browser interaction and verified cleanup. Its
receipt must match the candidate's file digest; an older tree's receipt is not
evidence for changed files. Narrow-viewport checks also use desktop Chromium,
not a physical phone or a mobile application.
The Mini's isolated PostgreSQL integration suite at `0125396` passed 500/500 on
2026-09-28, including both independent recovery browser scenarios, with zero
failures, cancellations, skips or todos. Its task containers and VM were cleaned.
Earlier clock-fixture and disk-space failures remain recorded, not skipped.
That isolated PG result does not close clean DSH installation or production
database acceptance.
The synthetic suite includes
an early-timer regression: at 299ms it must not record PRESENTED, but must
recheck the remaining dwell time without losing or duplicating the event.
This guards a confirmed race consistent with an earlier mobile failure; that
earlier run had no timing trace, so it does not establish a unique cause.
Passing the core commands above
does not authorize public publication or establish production G2/G3/G4.
Historical design and handoff documents describe additional private workflows;
they are not public installation instructions.
