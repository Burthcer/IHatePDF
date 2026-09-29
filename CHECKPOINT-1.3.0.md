# 1.3.0 checkpoint (delete before merging to main)

Branch: claude/bold-cori-o7rx16. main untouched. Report NOT published (goes in chat first).

## Done and verified in the desktop app (results in /tmp/ihp-stress/results-v14/v15.jsonl, lost if the container resets)
- Memory fail-safe: over-budget job stopped gracefully (2.9 s), stuck page restarted in 1.3 s with notice,
  4 GB-PC simulation (1 GB budget): watermark 500 MB OK, compress 1 GB stopped cleanly.
- 5000-page tools: 725–903 MB peak, 1.5–9 s. Markdown 5000p 1.3 GB (was 3.9 GB).
- Image PDFs 500 MB–2 GB: watermark ~0.9 GB, rotate ~1.6 GB, compress 2 GB 1.06 GB (was 3.1 GB).
- Repair 500 MB cut-off: 43 s, 3.1 GB (1.2.0: 20 s, 7.3 GB). Was hanging; fixed in 81c53f4.
- Excel 100k rows: 1.9 GB, 94 s (1.2.0: 4.3 GB, 54 s). Node: same speed as 1.2.0 at a quarter of the memory.
- A/B vs 1.2.0 in Electron: Word/Excel 10k/HTML within ~1 s; images→PDF 300 photos 9.8 s vs 2.8 s (but 1.5 GB vs 3.2 GB).

## Still to do
1. Redact 5000p in app times out (>20 min; memory fine at 1.1 GB). Worker side is 89 s in Node, so the
   slowdown is page-side rendering per ask. Profile with /tmp/ihp-stress/redact-profile.mjs (or re-create:
   CDP Profiler on the page while redacting text_1000p.pdf). Suspect pg.cleanup() per page / serial ping-pong.
2. Images→PDF 300 photos slower (9.8 s vs 2.8 s): check imagePrep Blob path / output streaming.
3. Fill README placeholder REDACT_RAM (README "What's new in 1.3.0" table) and RELEASE_NOTES Redact row.
4. Re-run: browser e2e all-tools, compress e2e, electron e2e, share e2e; npm test (17 + 33 pass now).
5. Check installer size (CJK fonts add ~21 MB) with npm run build:exe (wine available).
6. Paste full before/after report in chat. Do not merge to main or publish TEST_REPORT until the user says so.
