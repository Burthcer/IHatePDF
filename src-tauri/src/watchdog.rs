//! Memory fail-safe. IHatePDF gets a RAM budget sized to this PC and a watchdog keeps jobs inside
//! it, so no file can make the computer run out of memory. Same rules as the 1.4.0 watchdog:
//!
//! Budget: half of the installed RAM, but always leaving at least 3 GB for Windows, never less than
//! 1 GB, never more than 16 GB. It is for the work a job does, not for the app itself (idle use
//! doesn't count). Twice a second the watchdog adds up the physical memory of the app and its
//! WebView2 processes and measures how much it has grown since the job started (or, with no job
//! running, since the lowest point of the last minute):
//!   normal    under 70% of the job's limit
//!   high      70% or more, or Windows is getting low: tools work in smaller pieces
//!   over      over the limit: jobs pause at their next piece, drop what they can
//!   critical  the last resort: Windows nearly out of memory, still over after 8 s, or a runaway
//! The page answers each report. A page that stops answering while over the budget is reloaded.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;
const CHECK: Duration = Duration::from_millis(500);
const HIGH: f64 = 0.7;
const OVER_LIMIT_MS: u128 = 8000;
const RUNAWAY: f64 = 2.0;
const WARMUP: Duration = Duration::from_millis(5000);
const IDLE_WINDOW: Duration = Duration::from_millis(60_000);
const ANSWER_MS: u128 = 1500;
const LIMIT_STUCK: u32 = 2;
const LIMIT_ANSWERING: u32 = 6;

pub fn budget_for(total: u64) -> u64 {
    let b = (total as f64 * 0.5).min(total.saturating_sub(3 * GB) as f64).min((16 * GB) as f64);
    b.max(GB as f64) as u64
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Level {
    Normal,
    High,
    Over,
    Critical,
}
impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Normal => "normal",
            Level::High => "high",
            Level::Over => "over",
            Level::Critical => "critical",
        }
    }
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub total: u64,
    pub budget: u64,
    pub reserve: u64,
    pub min_limit: u64,
    pub low_share: u64,
}
impl Limits {
    pub fn for_total(total: u64) -> Self {
        let budget = std::env::var("IHP_MEMORY_BUDGET_MB").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).map(|v| v * MB).unwrap_or_else(|| budget_for(total));
        Limits { total, budget, reserve: GB.max((total as f64 * 0.1) as u64), min_limit: budget.min(256 * MB), low_share: 128 * MB }
    }
    /// How much a job may use right now: the budget, or less while Windows is short.
    pub fn limit_for(&self, growth: u64, free: u64) -> u64 {
        let want = (growth + free).saturating_sub(self.reserve).max(self.min_limit.min(self.budget));
        self.budget.min(want)
    }
    pub fn system_low(&self, free: u64) -> bool {
        free < (400 * MB).max((self.total as f64 * 0.05) as u64)
    }
    /// (level, reason) for `growth` bytes of job memory.
    pub fn level_for(&self, growth: u64, limit: u64, low: bool, over_for_ms: u128) -> (Level, Option<&'static str>) {
        let reason = if limit < self.budget { "system" } else { "too-big" };
        if low && growth > self.low_share {
            return (Level::Critical, Some("system"));
        }
        if growth as f64 > self.budget as f64 * RUNAWAY {
            return (Level::Critical, Some("too-big"));
        }
        if growth > limit {
            return if over_for_ms >= OVER_LIMIT_MS { (Level::Critical, Some(reason)) } else { (Level::Over, None) };
        }
        if growth as f64 > limit as f64 * HIGH || low {
            return (Level::High, None);
        }
        (Level::Normal, None)
    }
}

struct State {
    jobs: u32,
    job_base: Option<u64>,
    loaded_at: Instant,
    load_base: Option<u64>,
    idle: Vec<(Instant, u64)>,
    over_since: Option<Instant>,
    critical_for: u32,
    answered_at: Option<Instant>,
    sent_limit: u64,
    level: Level,
    last: Value,
}

#[derive(Clone)]
pub struct Watchdog(Arc<Mutex<State>>, Limits);

fn free_memory(sys: &System) -> u64 {
    if let Ok(file) = std::env::var("IHP_SIMULATE_FREE_FILE") {
        if let Ok(s) = std::fs::read_to_string(file) {
            if let Ok(mb) = s.trim().parse::<u64>() {
                if mb > 0 {
                    return mb * MB;
                }
            }
        }
    }
    sys.available_memory()
}

/// Physical memory of this process and every process below it (the WebView2 ones).
fn app_memory(sys: &System) -> u64 {
    let root = Pid::from_u32(std::process::id());
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        for (pid, p) in sys.processes() {
            if p.parent() == Some(parent) && !tree.contains(pid) {
                tree.push(*pid);
            }
        }
        i += 1;
    }
    tree.iter().filter_map(|p| sys.process(*p)).map(|p| p.memory()).sum()
}

fn info(l: &Limits, extra: Value, free: u64) -> Value {
    let mut v = json!({
        "level": "normal", "usedMB": 0, "jobMB": 0, "budgetMB": l.budget / MB, "limitMB": l.budget / MB,
        "totalMB": l.total / MB, "availableMB": free / MB,
    });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, val) in e {
            o.insert(k.clone(), val.clone());
        }
    }
    v
}

impl Watchdog {
    pub fn start(app: AppHandle) -> Watchdog {
        let mut sys = System::new();
        sys.refresh_memory();
        let limits = Limits::for_total(sys.total_memory());
        let state = State {
            jobs: 0,
            job_base: None,
            loaded_at: Instant::now(),
            load_base: None,
            idle: Vec::new(),
            over_since: None,
            critical_for: 0,
            answered_at: None,
            sent_limit: limits.budget,
            level: Level::Normal,
            last: info(&limits, json!({}), sys.available_memory()),
        };
        let wd = Watchdog(Arc::new(Mutex::new(state)), limits);
        let me = wd.clone();
        std::thread::spawn(move || {
            let mut sys = System::new();
            loop {
                std::thread::sleep(CHECK);
                sys.refresh_memory();
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
                me.tick(&app, &sys);
            }
        });
        wd
    }

    fn tick(&self, app: &AppHandle, sys: &System) {
        let l = self.1;
        let mut s = self.0.lock().unwrap();
        let now = Instant::now();
        let used = app_memory(sys);
        let free = free_memory(sys);
        let low = l.system_low(free);
        s.load_base.get_or_insert(used);
        let mut base = s.job_base;
        if s.jobs == 0 {
            if now.duration_since(s.loaded_at) >= WARMUP {
                s.idle.push((now, used));
            }
            s.idle.retain(|(t, _)| now.duration_since(*t) <= IDLE_WINDOW);
            let mut lows: Vec<u64> = s.idle.iter().map(|(_, b)| *b).collect();
            if now.duration_since(s.loaded_at) < IDLE_WINDOW {
                lows.push(s.load_base.unwrap());
            }
            base = lows.into_iter().min();
        }
        let Some(base) = base else {
            s.last = info(&l, json!({ "usedMB": used / MB }), free);
            return;
        };
        let growth = used.saturating_sub(base);
        let limit = l.limit_for(growth, free);
        if growth > limit {
            s.over_since.get_or_insert(now);
        } else {
            s.over_since = None;
        }
        let over_for = match s.over_since {
            Some(t) if s.jobs > 0 => now.duration_since(t).as_millis(),
            _ => 0,
        };
        let (level, reason) = l.level_for(growth, limit, low, over_for);
        let mut extra = json!({ "level": level.name(), "usedMB": used / MB, "jobMB": growth / MB, "limitMB": limit / MB });
        if let Some(r) = reason {
            extra["reason"] = json!(r);
        }
        s.last = info(&l, extra, free);
        let limit_moved = (limit as i64 - s.sent_limit as i64).unsigned_abs() as f64 > l.budget as f64 * 0.1;
        if level != s.level || limit_moved || matches!(level, Level::Over | Level::Critical) {
            let _ = app.emit("ihp:mem", s.last.clone());
            s.sent_limit = limit;
        }
        s.level = level;

        // Last resort: a page that doesn't free memory (stuck, or unable to) is reloaded.
        let answered_recently = s.answered_at.map_or(false, |t| now.duration_since(t).as_millis() < ANSWER_MS);
        let pressing = level == Level::Critical || (level == Level::Over && !answered_recently);
        s.critical_for = if pressing { s.critical_for + 1 } else { 0 };
        let checks = if answered_recently { LIMIT_ANSWERING } else { LIMIT_STUCK };
        if s.critical_for >= checks {
            s.critical_for = 0;
            s.over_since = None;
            drop(s);
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(url) = "http://tauri.localhost/index.html?recovered=memory".parse() {
                    let _ = w.navigate(url);
                }
            }
        }
    }

    pub fn state(&self) -> Value {
        self.0.lock().unwrap().last.clone()
    }
    pub fn ack(&self) {
        self.0.lock().unwrap().answered_at = Some(Instant::now());
    }
    pub fn set_jobs(&self, n: u32, current_memory: u64) {
        let mut s = self.0.lock().unwrap();
        if n > 0 && s.jobs == 0 {
            s.job_base = Some(current_memory);
        }
        if n == 0 {
            s.job_base = None;
            s.over_since = None;
        }
        s.jobs = n;
    }
    /// The page (re)loaded: start measuring afresh.
    pub fn page_loaded(&self) {
        let mut s = self.0.lock().unwrap();
        s.loaded_at = Instant::now();
        s.load_base = None;
        s.idle.clear();
        s.jobs = 0;
        s.job_base = None;
        s.over_since = None;
        s.critical_for = 0;
        s.level = Level::Normal;
    }
}

pub fn current_app_memory() -> u64 {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    app_memory(&sys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(total_gb: u64) -> Limits {
        Limits::for_total(total_gb * GB)
    }

    #[test]
    fn budgets_by_pc_size() {
        assert_eq!(budget_for(4 * GB), GB);
        assert_eq!(budget_for(8 * GB), 4 * GB);
        assert_eq!(budget_for(16 * GB), 8 * GB);
        assert_eq!(budget_for(32 * GB), 16 * GB);
        assert_eq!(budget_for(128 * GB), 16 * GB);
    }

    #[test]
    fn levels_follow_growth() {
        let x = l(16);
        let b = x.budget;
        assert_eq!(x.level_for(b / 2, b, false, 0).0, Level::Normal);
        assert_eq!(x.level_for((b as f64 * 0.8) as u64, b, false, 0).0, Level::High);
        assert_eq!(x.level_for(b + 1, b, false, 0).0, Level::Over);
        assert_eq!(x.level_for(b + 1, b, false, 9000), (Level::Critical, Some("too-big")));
        assert_eq!(x.level_for(b * 2 + 1, b, false, 0), (Level::Critical, Some("too-big")));
    }

    #[test]
    fn windows_running_low_is_critical_only_for_a_real_job() {
        let x = l(16);
        assert_eq!(x.level_for(10 * MB, x.budget, true, 0).0, Level::High);
        assert_eq!(x.level_for(500 * MB, x.budget, true, 0), (Level::Critical, Some("system")));
    }

    #[test]
    fn busy_windows_shrinks_the_limit_and_blames_windows() {
        let x = l(16); // budget 8 GB
        assert_eq!(x.limit_for(0, 16 * GB), x.budget, "plenty free: the full budget");
        assert_eq!(x.limit_for(200 * MB, x.reserve + 300 * MB), 500 * MB, "what the job holds + free - reserve");
        assert_eq!(x.limit_for(0, 100 * MB), 256 * MB, "never below the floor");
        assert_eq!(x.level_for(600 * MB, 500 * MB, false, 0).0, Level::Over, "over a shrunk limit pauses first");
        assert_eq!(x.level_for(600 * MB, 500 * MB, false, 9000), (Level::Critical, Some("system")));
        assert_eq!(x.level_for(1100 * MB, GB, false, 5000).0, Level::Over, "still pausing after 5 s");
    }

    #[test]
    fn the_limit_shrinks_when_windows_is_short() {
        let x = l(16);
        assert_eq!(x.limit_for(0, 16 * GB), x.budget);
        assert!(x.limit_for(GB, 2 * GB) < x.budget);
        assert!(x.limit_for(0, 0) >= x.min_limit);
    }
}
