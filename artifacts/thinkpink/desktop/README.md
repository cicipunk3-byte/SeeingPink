# ThinkPink desktop build

ThinkPink is a separate Electron desktop app. The Vite browser preview is for
reviewing the interface only; without the packaged app's isolated preload bridge,
local Ollama operations remain disabled.

## Build and test

From the workspace root:

```sh
pnpm --filter @workspace/thinkpink run typecheck
pnpm --filter @workspace/thinkpink run test:desktop
pnpm --filter @workspace/thinkpink run desktop:package:win
```

The Windows target is an x64 ZIP. On macOS, run
`pnpm --filter @workspace/thinkpink run desktop:package:mac` to produce x64 and
Apple Silicon ZIPs. Linux is not a supported release target. Archives are
unsigned and not notarized by these scripts; verify each app on a clean target
machine and configure signing/notarization before public distribution. Confirm
the minimum supported macOS and Windows versions during that release check.
The desktop tests simulate Hindsight's Windows and macOS setup paths, including
Python discovery, interrupted-install retry, and selected-source recovery after
restart. They do not run the packaged apps or test real Python, Ollama, or
support-model downloads; those checks still require clean target machines.

## Packaged recovery panel check

For the current Apple Silicon HQ handoff, use
[`docs/thinkpink/HQ-DEVICE-HANDOFF.md`](../../../docs/thinkpink/HQ-DEVICE-HANDOFF.md).
This does not certify the Mac build before it is launched on the target Mac;
the Windows and Intel archives remain unchecked rather than implicitly passed.

On Linux, build an **unpacked smoke-test copy** (Linux is not a release target)
and run the native recovery check with Ollama stopped:

```sh
pnpm --filter @workspace/thinkpink run desktop:prepare
cd artifacts/thinkpink
pnpm exec electron-builder --linux dir --x64
pnpm run desktop:recovery:smoke
```

The check requires a graphical X11 display, `xdotool`, and Node.js 24. It starts
the packaged executable with a temporary app profile, waits for the real
desktop bridge to report Ollama unavailable, resizes the Electron window to
its minimum 920 × 660 and normal 1200 × 820 sizes, and saves screenshots under
the printed temporary directory. At the minimum size, scrolling to reach the
buttons is expected; the check fails if text is clipped or controls remain
obscured after scrolling. It clicks **Check local connection** and confirms the
panel returns, then clicks **Get Ollama from its official site** and checks that
the operating system receives `https://ollama.com/download` (a temporary
`xdg-open` recorder prevents opening a browser). It does not simulate Ollama or
change connection behavior. The runner requires a Linux graphical display.

Before distributing macOS/Windows ZIPs, repeat the visual and interaction check
on each target OS: stop Ollama, unzip and launch the app, inspect the panel at
the smallest allowed window size and at a desktop size, retry the connection,
and confirm the official link opens the Ollama download page in the system
browser. The Linux smoke check cannot establish target-OS presentation. On
NixOS hosts, a freshly unpacked Electron binary may need system shared
libraries and an ELF interpreter before it can start; use a compatible
desktop Linux host if those are unavailable.

The desktop build uses a bundled icon and system font stacks so the interface
does not need to fetch assets from the internet. User-started network actions
include opening Ollama's official download/model pages, downloading an Ollama
model, and optionally setting up Hindsight as described below.

## Optional local Hindsight memory

Hindsight is off until the user chooses **Review setup** and confirms the
download. Setup requires an already installed Python 3.11 or newer. ThinkPink
creates a private Python environment in its app-data folder and does not install
Python system-wide. Hindsight Embed and its local support models may be
downloaded during setup or first use.

The current setup pins `hindsight-embed==0.10.1`, but that is not the entire
downloaded runtime. Hindsight Embed declares `aiohttp>=3.14.3` and `rich>=13`;
its first daemon start can also install the Hindsight CLI and run
`uvx hindsight-api@0.10.1`. That API package brings its own transitive
dependencies, including the local ML and embedded-database extras. Hindsight
may download embedding and reranking model files on first use. Dependency
versions are not all locked to exact releases, and model files have their own
license terms. These components are not included in ThinkPink's desktop
archives.

Hindsight uses the selected local Ollama model and an embedded `pg0` database.
Its service is bound to loopback, and its profile, configuration, and database
are isolated under ThinkPink app data. No hosted model or database fallback is
configured. Downloading the Hindsight package and support models requires an
internet connection, but selected source text and prompts stay on this device.

### Hindsight license review

The applicable license for `hindsight-embed` 0.10.1 is **not unambiguously
confirmed by upstream records**. PyPI's release metadata gives the SPDX
expression MIT and lists a `LICENSE` file; the tagged `pyproject.toml` and
repository `LICENSE` also say MIT. However, the README in that same tag says
Apache 2.0, and PyPI's project page displays that README declaration alongside
the MIT expression. The PyPI page links the published package to an upstream
source commit, but the available release records do not reconcile the
conflict. I found no published maintainer clarification in the release
materials checked.

**Release gate:** do not describe Hindsight Embed as definitely MIT or Apache,
and do not publicly ship the ThinkPink desktop release with this Hindsight
setup flow until Vectorize confirms the applicable license or publishes
corrected, consistent package records. ThinkPink does not bundle Hindsight in
its desktop archives, and setup downloads it only after the user consents.
That does not resolve the upstream conflict. If any of these runtime
components are later bundled or redistributed, record the exact resolved
package versions and model files and include their required third-party
notices.

Sources checked: [PyPI 0.10.1 release and metadata](https://pypi.org/project/hindsight-embed/0.10.1/)
([JSON metadata](https://pypi.org/pypi/hindsight-embed/0.10.1/json)),
[tagged package metadata](https://github.com/vectorize-io/hindsight/blob/v0.10.1/hindsight-embed/pyproject.toml),
[tagged package README](https://github.com/vectorize-io/hindsight/blob/v0.10.1/hindsight-embed/README.md),
[tagged repository license](https://github.com/vectorize-io/hindsight/blob/v0.10.1/LICENSE),
[Hindsight Embed daemon installer](https://github.com/vectorize-io/hindsight/blob/v0.10.1/hindsight-embed/hindsight_embed/daemon_client.py),
[daemon runtime resolver](https://github.com/vectorize-io/hindsight/blob/v0.10.1/hindsight-embed/hindsight_embed/daemon_embed_manager.py),
[API package metadata](https://github.com/vectorize-io/hindsight/blob/v0.10.1/hindsight-api/pyproject.toml),
and [API runtime dependencies](https://github.com/vectorize-io/hindsight/blob/v0.10.1/hindsight-api-slim/pyproject.toml).

Setup does not index existing content. The user must explicitly select each
thread or wiki page in Settings. Selected content is copied as derived memory;
the original transcript and wiki remain canonical. Editing an indexed source
updates its memory when enabled. If memory is paused during an edit, that
source is removed from the index and must be selected again after resuming.
Deleting a source removes it from the active index and queues local record
cleanup if needed. **Forget all Hindsight memory** clears the derived records
and source selection without deleting transcripts or wiki pages.

Wiki suggestions use only the selected Hindsight sources. A generated wiki
draft remains editable and is not added to the canonical wiki until the user
reviews and approves it.

## Learn to Code checks

The Java and Python lessons work without Ollama. Compile and syntax checks use
an already installed Java JDK or Python 3 runtime, write temporary files, and
delete them after each check. ThinkPink does not install language runtimes or
execute learner programs in this release. There is no Run action or execution
bridge. See `../../../docs/thinkpink/SAFE-CODE-EXECUTION.md` for the proposed
disposable VM design and the packaged-build verification gate required before
execution can be considered.

The desktop unit tests verify the checker’s compiler-only commands, missing
runtime guidance, and temporary-file cleanup after success, compiler errors,
cancellation, and timeout. These tests do not substitute for launching each
packaged build on its target operating system. Before release, verify the
Windows x64, macOS Intel, and macOS Apple Silicon ZIPs on matching systems with
and without the corresponding runtimes installed.

## Local Ollama compatibility

ThinkPink connects only to `127.0.0.1:11434`. The current `0.5.0` minimum is a
ThinkPink compatibility policy, not an Ollama compatibility guarantee. The
request tests use a local mock server; confirm supported Ollama versions and
pull/chat behavior on real macOS and Windows installations before release.