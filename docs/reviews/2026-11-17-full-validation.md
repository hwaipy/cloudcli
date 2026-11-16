# Full validation before commit — 2026-11-17

The current frontend, backend, Electron shell and deployment scripts were tested locally. Backend tests used an isolated SQLite database and the Node 24 runtime matching the installed native modules. No conversation backend was restarted and no real chat messages were submitted.

## Results

| Suite | Result |
| --- | --- |
| Frontend Vitest | 155 files, 1,066 tests passed |
| Backend Node test runner | 911 passed, 3 conditional skips, 0 failed |
| Electron unit tests | 21 passed |
| Deployment Python tests | 14 passed |
| Browser, service worker, entrypoint and CSS script tests | 10 passed |
| TypeScript frontend/backend checks | Passed |
| Frontend/backend production build | Passed |
| Lint | No errors; existing warnings remain |
| Real Electron network integration | HTTPS login, JSON, multipart and untrusted referrer cases passed |
| Real Electron web update integration | Download without reload, native restart and application of new resources passed |
| Signed Electron shell integration | Disposable copies of the existing signed 0.1.6 package successfully downloaded, installed and restarted from fixture version 0.1.5 to 0.1.6 |
| Mobile WebKit scroll regression | No unexpected visible-anchor jumps |

The signed-shell fixture checks the existing packaged updater. The separate web-update and HTTPS tests run current repository Electron sources; this run does not create or publish a new desktop release.

## Problems found and corrected

- The Claude held-process test waited a fixed 25 ms before asserting completion. Under concurrent suite load this could assert before the scripted stream was consumed. It now waits for observed completion and release, with the existing bounded condition helper; assertions and runtime behavior are unchanged.
- The real Electron relaunch test could attach CDP before the new document had a body. It now waits for document readiness before asserting the expected resource version.
- Python test modules executed `unittest.main()` when imported by discovery. Both now guard their entrypoints. Frontend deployment fixtures now include the required desktop resource hashes and assert the current missing-resource rejection.
- Tailwind generated invalid CSS when cloning global device media rules inside `@layer utilities` for important class variants. Global device rules now sit outside the class utility layer. A production PostCSS/Tailwind/esbuild regression fails on the previous stylesheet and passes on the corrected output.
- Removed trailing whitespace in the sidebar header; `git diff --check` passes.

## Coverage boundaries

Three backend cases are conditional: Linux process-session inspection, Docker cold SSH initialization requiring explicit image/egress fixtures, and a real Codex fork test requiring a committed rollout fixture. They were skipped by their existing conditions on this Mac, not counted as passes. This run does not prove those integrations.

Existing lint warnings and React server-rendering warnings remain. Local untracked logs, test databases, signing configuration and runtime downloads stay under ignored paths; they are not release artifacts or source files to commit.
