# The usage log

IHatePDF keeps a small **local usage log**: a file on the PC that records what the app did, so a lab can measure reliability, performance and how the app is used. **It is never uploaded or sent anywhere**, it holds **no file names and nothing from your documents**, and it can be switched off.

## What it records

One line per event, as JSON:

| Event | What's in it |
|---|---|
| `app_start` | Version, Windows version, RAM, CPU cores, memory budget, size of the app's data folder and of the log, temp files left over from the last run |
| `tool_open` | Which tool was opened (e.g. `compress`) |
| `job` | One per job: tool, **outcome** (`ok`, `error`, `stopped` by the memory fail-safe, `cancelled`), time, size of the input and output, how many files, the app's **peak RAM**, **CPU** (the app's and the whole PC's, average and peak), the lowest free RAM during the job, temp files at the end. For failures: an error class (`damaged-file`, `password`, `memory`, `unsupported`, …) and a short message with anything that looks like a file name removed |
| `file_saved` | File type (`pdf`, `docx`…) and size. Never the name or the folder |
| `app_quit` | Time the app was open, jobs run, jobs that failed, temp files created and deleted, **temp files left before and after the final clean-up (must be 0)**, size of the app's data folder and the log |
| `crash`, `window_restarted` | The window crashed, or was restarted by the memory fail-safe |

Every line also carries a timestamp, an **anonymous PC id** (a hash of the computer's name), an **anonymous user id** (a hash of the Windows user name and a secret salt) and a session id.

**Never recorded:** file names or paths, anything inside a document, text, passwords, IP addresses.

## Where it is, and how big it gets

- Default: `%APPDATA%\ihatepdf\logs\usage-<pc id>.log`.
- **Capped at 15 MB per PC:** the file rotates at 5 MB and keeps 3 files. A line is about 400 bytes, so 15 days of normal use is a few hundred KB.
- Problems writing the log (disk full, share offline) never affect the app.

## Settings for a lab

Switch off or redirect with any of these (first match wins):

1. **In the app:** the footer says "A usage log stays on this PC…" with a *Turn off* link.
2. **Environment variables:** `IHP_LOG=off`; `IHP_LOG_DIR=<folder>`.
3. **A machine-wide file** `%ProgramData%\IHatePDF\config.json`:

```json
{
  "logging": true,
  "logDir": "\\\\server\\share\\ihatepdf-logs",
  "salt": "any text the lab chooses"
}
```

- **Deep Freeze:** a frozen PC wipes everything on restart, including its log. Point `logDir` at a shared drive (or a thawed partition). Each PC writes its own `usage-<pc id>.log`, so many PCs can share one folder.
- **`salt`** keeps the anonymous user ids the same on every PC and after a restart. Without it, each PC makes its own random salt (lost on a frozen PC), so the same person would count as a new user after each restart.

## Reading it

```bash
node scripts/log-summary.mjs <log folder>          # prints the tables
node scripts/log-summary.mjs <log folder> --md summary.md
```

The summary gives: PCs, anonymous users, launches per day, **success rate** overall and per tool, error classes, median and 95th-percentile times, RAM and CPU while jobs ran (how often the PC hit 90% CPU), **temp-file clean-up checks**, and the log's own size and growth per day.

## Checking the PC over time

To show that installing and using the app doesn't slow a PC down, measure the same things on Day 1, Day 10 and Day 15:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scriptsaseline.ps1 -Label "Day 1"
```

Run it the same way each time: right after a restart, with nothing else open. It records the date and app version, how long the PC has been on, RAM in use and CPU busy while idle, free disk space, **how long the app takes to start**, **its memory when idle**, and its size on disk and in its data folder, as one row of `baseline.csv` next to the script. (It closes any open IHatePDF window first.) To run it on a schedule: `Register-ScheduledTask` with the same command (`-ExecutionPolicy Bypass` lets the script run on PCs that block scripts).

## For developers

`electron/usageLog.cjs` (the log, sampling, rotation, name stripping), IPC in `electron/main.cjs` (`ihp:log-tool`, `ihp:job-start`, `ihp:job-end`), bridge in `electron/preload.cjs`, page side in `src/services/usageLog.ts` (jobs are logged in `src/hooks/useWorkerBridge.ts`, tool openings in `src/App.tsx`). The page can only send fixed fields. Test: `node scripts/e2e/memory/usagelog.mjs` (21 checks, including "no file names in the log").
