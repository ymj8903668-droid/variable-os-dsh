# Dependency and Attribution Scope

The root LICENSE applies to first-party Variable OS files. It does not
relicense dependencies installed by pnpm, DSH, a Wiki engine or a model.
Build instructions are in [BUILD_AND_TEST.md](BUILD_AND_TEST.md).

## Source Candidate

The candidate contains source, synthetic fixtures and generated client/remote
JavaScript. The remote UI bundle also contains the reviewed `ipaddr.js` 2.5.0
classifier and its MIT license text. It excludes `node_modules`,
package-manager caches, third-party Wiki engines and vendor voice resources.

The browser build checks its actual esbuild input/output graph before writing.
It rejects package code from `node_modules`, sources outside the repository,
excluded voice/Grok trees and unreviewed external imports. The reviewed
externals are `react`, `react/jsx-runtime` and
`@deepseek-ai/dsh-client-ui-primitives`. Remote bundles accept repository inputs,
the explicit pinned classifier input when reachable, and external `node:`
imports only. The build verifies the classifier's package name, version and
declared license, and embeds its full LICENSE text in each bundle that contains
it. This exception does not allow arbitrary package code into either bundle.

These are path and dependency checks, not proof of source authorship or a legal
compatibility decision. They do not classify copied code hidden in a source file.

The corresponding-source companion also includes two development patches:
`patches/dsh-settings-0.1.1-rc.2.patch` and
`patches/dsh-settings-file-0.1.1-rc.2.patch`. Their context and removed lines
are upstream material from `@deepseek-ai/dsh-settings@0.1.1-rc.2` and
`@deepseek-ai/dsh-settings-file@0.1.1-rc.2`, not purely first-party source.
NOTICE maps each patch to its pinned package and preserves their identical
DeepSeek copyright and complete MIT license text, separate from Variable OS
changes. The public plugin installer does not apply these development patches.

## Alpha standalone source build

The alpha COPY uses an independent frozen build toolchain at
`scripts/plugin-source-build-deps`: esbuild0.28.2 and ipaddr.js2.5.0.
It runs with dependency scripts disabled; no SDK package is needed for this
source rebuild. Original external Host declarations remain hash-bound source
inputs. The two historical development patches above remain attributed but
are not applied by the rebuild. This does not migrate the full development
install or old Settings tests, nor approve an alpha release.

The alpha payload uses schema2 host-peers-only with zero plugin-owned runtime
dependencies and official Host HMR. Its exact Host peers are checked using
the native package resolver. It does not inherit the historical schema1 HMR
graph proof below, and does not audit Host transitives.

## Separately Installed Dependencies (historical rc.2 candidate)

Use the committed package manifests and lockfiles for dependency versions.
The UI, storage and EvidenceProvider packages have separate dependency graphs.
The installed DSH profile resolves additional runtime dependencies separately;
its CLI and bundle versions are fixed by the installer, not a root lockfile.
Recovery UI generation also uses separately installed React and React DOM.

The private plugin candidate also carries `plugin-dependencies.json`, bound
by its runtime manifest. It records the 11-package HMR-owned graph rooted at
`@deepseek-ai/cordis-plugin-hmr@1.0.16`, with resolved versions, registry
tarball integrity, dependency edges and hashes for all 106 package files.
The reference graph was compared with an isolated Mini installation and
its tarballs; no third-party source is copied into the plugin by this file.

The supplied installer checks the installed graph before composition/import.
Its Start entry checks it again before launching any Host command. File,
version, edge, resolution or boundary drift fails closed. Verification reads
metadata and bytes without executing dependency code. Official DSH Host
peers remain a separate compatibility boundary.

This is a recorded graph and installed-file check, not a new frozen runtime
resolver: official DSH still resolves its profile through pnpm. If resolution
differs from this candidate, installation is refused, not automatically
repaired, upgraded or approved. Registry integrity records do not replace
the installed file checks or authenticate the outer distribution. This does
not sandbox arbitrary code or protect against concurrent same-user tampering.

A 2026-09-28 local snapshot read metadata for 165 installed package versions.
All declared a license, but eight had no root-level LICENSE/COPYING file found.
That does not establish that they have no license; nested or upstream notices
were not verified. The snapshot is an installed-store inventory, not proof of
reachability, all-platform coverage or complete distribution attribution.

Complete third-party attribution, asset/source provenance and any binary
distribution remain separate review items. This document is not release
clearance. Clean Host installation, PG recovery and the final candidate's
acceptance gates are also independent; missing results remain missing.


## Current standalone Host security follow-up (2026-10-12)

The private installed evidence recorded on 2026-10-12
confirms adopted alpha Host serves KaTeX0.18.7 bytes; legacy0.16.47 remains historical.
Office libreoffice-kit0.1.5 resolved fflate0.8.2 with GHSA-px8p-9vwx-vf98. Its exact
parent-scoped override now resolves0.8.3; independent frozen tools install and actual
reader normal/malformed ZIP probes passed. Runtime registry audit621 entries reports
0 registered advisories, not complete Host security or Office conversion acceptance.
Only profiles/public-tools is changed; old installations are not patched in place.
New current-source original-plugin25-step synthetic business passed with this graph.
The underlying QA receipt is retained in the private development checkout and
is not included in this distribution. This dated summary is not independent
release clearance or a new installed run of the archive being read.

## Historical installed Host follow-up (2026-10-11)

The private installed audit recorded on 2026-10-11
adds evidence for the actual1f40d86d/LfpBKb installation: plugin/official Host lock
graphs report12/509 entries and zero registered advisories, but the Host frontend
embeds KaTeX0.16.47 outside that graph. The low conditional advisory remains open;
application exploitability is UNKNOWN. Verified upstream0.2.0-rc.2 still embeds
0.16.47;0.2.1-alpha.2 embeds patched0.18.7 but is not an adopted compatible Host.
No current dependency, global tool or public candidate was changed by this audit.

The same tool directory has446 installed package name/version pairs, all declaring
a license. Seven lack a notice-like file even after a full-depth directory check;
the exact list and metadata hashes are in the audit receipt. This is a current
inventory, not a replacement for source/asset attribution or a legal release gate.
