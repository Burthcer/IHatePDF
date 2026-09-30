# IHatePDF: notes for Claude Code

- **Before testing on Windows, read `docs/testing/WINDOWS_TESTS.md`**: setup, exact commands, expected results, past runs and open issues. **After testing, add your run to it** (newest first, never delete earlier runs).
- Memory fail-safe: `electron/memoryGuard.cjs` (watchdog, budget, levels), `src/services/memoryGuard.ts` (page side, stops jobs), `src/services/workerMemory.ts` (checkpoints in workers). Design notes: `HANDOFF.md` → "Memory".
- Memory tests: `scripts/e2e/memory/` (see its README). Browser tests: `scripts/e2e/all-tools.mjs` (inputs: `node scripts/e2e/make-e2e-fixtures.mjs`). Unit suites: `npm test`.
- Test inputs and results live in `test-fixtures/` (gitignored). Never commit them; put summaries in `docs/testing/WINDOWS_TESTS.md`.
- Pre-releases: a version with a suffix (e.g. `1.3.1-beta.4`) + running the "Windows installer" workflow by hand publishes a pre-release, never "latest".
