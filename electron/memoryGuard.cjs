/**
 * Memory fail-safe. IHatePDF gets a RAM budget sized to this PC and a
 * watchdog makes sure it stays inside it, so no file — however big, and
 * whoever picked it — can make the computer run out of memory.
 *
 * Budget: half of the installed RAM, but always leaving at least 3 GB for
 * Windows and other programs, never less than 1 GB, never more than 16 GB.
 *   4 GB PC → 1 GB   ·   8 GB → 4 GB   ·   16 GB → 8 GB   ·   32 GB+ → 16 GB
 *
 * Watchdog (every second) adds up the physical memory (working set) of every
 * IHatePDF process — window, workers, GPU, helpers — and reports a level:
 *   normal   below 80% of the budget
 * (checked twice a second)
 *   high     80-100%: tools work in lower-memory, slower ways
 *   critical over the budget, or Windows itself is nearly out of memory
 *            (less than 5% / 400 MB available) while IHatePDF uses over half
 *            its budget: the running job is stopped and its memory freed,
 *            with a message saying why.
 * The page answers each critical report once it has stopped its jobs. If
 * memory still doesn't come down, the page process is ended and reloaded:
 *   page not answering (stuck)   after 1 s if memory is running away (1.5×
 *                                the budget, or Windows nearly out), else 3 s
 *   page answering               after 3 s running away, else 6 s
 * The PC stays usable either way.
 */

const os = require('os');

const MB = 1024 * 1024;
const GB = 1024 * MB;

function budgetFor(total) {
  return Math.round(Math.max(1 * GB, Math.min(total * 0.5, total - 3 * GB, 16 * GB)));
}

const TOTAL = os.totalmem();
const BUDGET = Number(process.env.IHP_MEMORY_BUDGET_MB) > 0 ? Number(process.env.IHP_MEMORY_BUDGET_MB) * MB : budgetFor(TOTAL);
const HIGH = 0.8;
const CHECK_MS = 500;
/** Checks over budget before the page is reloaded (see above). */
const LIMITS = { stuck: { runaway: 2, over: 6 }, answering: { runaway: 6, over: 12 } };
/** "Running away": this far over the budget (or Windows nearly out). */
const RUNAWAY = 1.5;
/** The page counts as answering if it did so this recently. */
const ANSWER_MS = 1500;

/** Physical memory currently used by all of the app's processes, in bytes. */
function appMemory(app) {
  // workingSetSize is in KB: RAM actually in use (untouched reservations don't count).
  return app.getAppMetrics().reduce((n, m) => n + (m.memory?.workingSetSize ?? 0) * 1024, 0);
}

function systemLow() {
  return os.freemem() < Math.max(400 * MB, TOTAL * 0.05);
}

function info(used = 0, level = 'normal') {
  return { level, usedMB: Math.round(used / MB), budgetMB: Math.round(BUDGET / MB), totalMB: Math.round(TOTAL / MB), availableMB: Math.round(os.freemem() / MB) };
}

/**
 * Starts watching. `getContents()` returns the window's webContents (or null);
 * `onEscalate(state)` runs when the page has to be ended.
 */
function startWatchdog(app, getContents, onEscalate) {
  let level = 'normal';
  let criticalFor = 0;
  let answeredAt = 0;
  let last = info();
  const timer = setInterval(() => {
    const contents = getContents();
    if (!contents || contents.isDestroyed()) return;
    const used = appMemory(app);
    // Windows running low only counts against us when we're a real part of the load
    // (otherwise a busy PC would stop even tiny jobs).
    const low = systemLow();
    const next = used > BUDGET || (low && used > BUDGET * 0.5) ? 'critical' : used > BUDGET * HIGH || low ? 'high' : 'normal';
    last = info(used, next);
    if (next === 'critical') criticalFor++;
    else criticalFor = 0;
    // Tell the page on every change, and keep reminding it while critical.
    if (next !== level || next === 'critical') contents.send('ihp:mem', last);
    level = next;
    const limits = Date.now() - answeredAt < ANSWER_MS ? LIMITS.answering : LIMITS.stuck;
    if (criticalFor >= (used > BUDGET * RUNAWAY || low ? limits.runaway : limits.over)) {
      criticalFor = 0;
      onEscalate(last);
    }
  }, CHECK_MS);
  timer.unref();
  return {
    state: () => last,
    ack: () => (answeredAt = Date.now()),
    stop: () => clearInterval(timer),
  };
}

module.exports = { budgetFor, startWatchdog, info, BUDGET, TOTAL };
