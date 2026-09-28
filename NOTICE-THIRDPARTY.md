# Third-party notices (staging copy for the fresh public repo)

ThinkPink packages software built by others. Their work is credited
here and remains under its own licenses.

## Hindsight (optional local memory layer)

- Project: Hindsight: Agent Memory That Learns
- Upstream: https://github.com/vectorize-io/hindsight
- Publisher: Vectorize AI, Inc.
- License: MIT License, Copyright (c) 2025 Vectorize AI, Inc.
- Pinned version: hindsight-embed==0.10.1 (license verified against
  the published wheel: License-Expression: MIT)
- Hindsight is OPTIONAL in ThinkPink. It is off until the user chooses
  Review setup and gives explicit consent.

## Direct Python dependencies of hindsight-embed 0.10.1

- aiohttp (>= 3.14.3) - Apache-2.0 AND MIT (dual license), verified
  against PyPI metadata
- rich (>= 13) - MIT, verified against PyPI metadata

## Runtime dependencies

Hindsight's first daemon start installs additional components (the
Hindsight CLI, the hindsight-api service, and local ML and
embedded-database extras). Each carries its own license in its own
distribution. A complete generated notice set for all transitive
dependencies is produced at build time and ships in the packaged
copies of this repository.

## The vellum-assistant shell

- License: MIT (stated in the shell's own repository)
