# IHatePDF: notes for Claude Code

- **Before testing on Windows, read `docs/testing/WINDOWS_TESTS.md`**: setup, exact commands, expected results, past runs and open issues. **After testing, add your run to it** (newest first, never delete earlier runs).
- Desktop app: Tauri (`src-tauri/`) + Rust core (`crates/ihp-core`); how tools run in Rust with the TypeScript worker as fallback: `HANDOFF.md` → "Rust engines and the native adapter". The 1.4.0 memory watchdog and usage log are not in 2.0.
- Tests: `npm test` (TS suites), `scripts/test-compress-rust.mjs`, `scripts/test-pages-rust.py`, and `scripts/e2e/all-tools.mjs` with `E2E_CDP` against the running app.
- Test inputs and results live in `test-fixtures/` (gitignored). Never commit them; put summaries in `docs/testing/WINDOWS_TESTS.md`.
- Pre-releases: a version with a suffix (e.g. `1.3.1-beta.4`) + running the "Windows installer" workflow by hand publishes a pre-release, never "latest".
