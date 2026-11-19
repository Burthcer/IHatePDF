# Prompt for a new chat (paste into Claude Code opened in this folder)

```
Continue the IHatePDF 2.0 Rust/Tauri port on branch claude/rust-port. Read, in order: CLAUDE.md, docs/CHECKPOINT.md (the "LATEST" section first), docs/testing/TEST_LOG.md, then HANDOFF.md "Rust engines and the native adapter" if you need to port or test something.

State: v2.0.0-beta.3 is published as a pre-release and was tested as the installed CI build (27/29 app checks, the 2 failures are harness limits; Unicode 6/6; PDF to PowerPoint native 3/3). About 22 of 28 tools run on Rust with TypeScript fallback.

Rules: keep Protect, Unlock, Forms, PDF/A and the Compare word diff on TypeScript; skip Share to phone and the usage log; keep the README as the stable 1.4.0 text plus the short beta section; never push to main or touch branch protection; commit and push only when I ask; run a Rust-vs-TypeScript comparison before any further port and keep TS as fallback; record every test run in docs/testing/WINDOWS_TESTS.md (newest first) and TEST_LOG.md. Check get_usage and stop at a checkpoint at 95% of the 5-hour limit.

Today's task: <write it here, e.g. "check the .pptx in real PowerPoint", "prepare 2.0.0 stable", or "draft the LinkedIn post from TEST_LOG.md">.
```
