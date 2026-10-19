# Standalone Plugin Source Companion

This private companion is for rebuilding the original Chinese Variable
Discovery Desk plugin, not installing another DSH runtime. It is not public
release approval or complete third-party/asset/privacy clearance.

## Rebuild The Unmodified Candidate

Use Node24.19.0 and pnpm11.25.0 in a new directory and an empty HOME.
No owner state, production environment, database or service credentials are
needed. Do not source a production .env. From the companion root:

```sh
pnpm --dir scripts/plugin-source-build-deps install --frozen-lockfile --ignore-scripts
mkdir -m 700 /absolute/new/private-plugin-output
node scripts/rebuild-plugin-source.mjs --output /absolute/new/private-plugin-output
```

The rebuild command verifies source hashes, stages only those verified
inputs in a private temporary directory, runs the original client and
remote builders, builds the plugin, and compares every output with
`expected-plugin-manifest.json`. A mismatch fails; it does not update the
expected hashes, download packages or publish anything. Installation of
build dependencies is explicit, uses the independent build-tool lockfile, and
does not execute dependency lifecycle scripts. This toolchain contains only
esbuild 0.28.2, its platform packages, and ipaddr.js 2.5.0. The original SDK
manifest is retained as a checked source input, not installed for rebuilding.
Legacy development lockfiles are not used by this standalone profile. esbuild's pinned platform package
must be available for the selected operating system.
Preexisting generated files or links in the input companion are not used
or overwritten. Temporary build staging is removed after success or failure.

The root `source-manifest.json` binds each source file and the expected
plugin manifest. The distribution's companion digest is a separate outer
binding; a source manifest alone is not an authenticity signature.

The companion includes the candidate's host-peers-only dependency declaration
and readback helper. Rebuilding copies that declaration; it does not resolve,
install or execute Host dependencies. The official Host provides its native
HMR. This zero-added-dependency declaration is not an audit of Host transitives.
Separate compatibility verification is described in `docs/DEPENDENCIES.md`.

## Source Profile

The companion includes the editable TSX/client modules, reachable server
and MCP modules, first-party builders, required policy assets, dependency
manifests and a separate frozen build-tool lock, plus the two historical
development SDK patches for attribution and review. It excludes
generated browser/remote bundles, node_modules, owner data and credentials.
The standalone build does not apply either historical development patch.
The companion also includes the ZIP installer's managed-tool helper and frozen
Host definitions. After explicit installation confirmation, that installer
prepares its own official Host under `~/.variable-os-plugin/tools`; it does not
modify an existing Host. Direct TGZ installation uses an external compatible
Host. Both paths check the Host dependencies. Rebuilding this source does not
install either runtime or qualify installation, Settings migration, or the full
repository test suite; those need their own current receipts.

The legacy reference-catalogue module alone is rendered as readable public
source with empty reference arrays using the same compile-time flag as the
public build. Its transformation is declared in the source manifest. User
cards and research are not reference cases. Other source bytes are copied
unchanged. This source profile must reproduce the bound plugin exactly.

For intentional edits, work on a separate copy and use the original
`packages/dsh-desk-ui/scripts/build-client.mjs` and
`scripts/build-dsh-plugin.mjs` commands. The unmodified-source verifier is
expected to reject edited files; do not replace the reference hashes to
misrepresent a modified build as the original candidate.

The general `docs/BUILD_AND_TEST.md` describes the full repository. Its
whole-repository tests and operational commands are not included in this
minimal plugin-source profile. This companion's supported entrypoint is
the rebuild command above. Plugin installation, live services and platform
acceptance are separately recorded and must not be inferred from rebuilds.
