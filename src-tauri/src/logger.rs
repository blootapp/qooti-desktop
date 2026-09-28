// Structured logger for the Rust backend.
// Format: [ISO_TIMESTAMP] [LEVEL] [target] message
//
// Every line goes to stderr (dev), an in-memory ring (the "this session" part of a
// feedback report) and — once `attach_file` has run in setup — a log file in the OS
// log folder, so a report sent after a crash still shows what happened last time:
//   Windows  %LOCALAPPDATA%\<identifier>\logs\qooti.log   (+ qooti.prev.log)
//   macOS    ~/Library/Logs/<identifier>/qooti.log
// Release builds have no console, so before this the backend log was simply lost.
//
// Level defaults to INFO for our own targets ("Boot", "Download", … and qooti::*),
// WARN for third-party crates; set RUST_LOG=debug for verbose output.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use log::{Level, LevelFilter, Log, Metadata, Record};

const RING_LINES: usize = 4000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;   // then rotate to .prev and start over
const LOG_FILE: &str = "qooti.log";
const PREV_FILE: &str = "qooti.prev.log";
const LOCK_FILE: &str = "session.lock";         // present while running → unclean exit if found at boot

struct Sink {
    ring:    VecDeque<String>,
    file:    Option<File>,
    dir:     Option<PathBuf>,
    written: u64,
}

fn sink() -> &'static Mutex<Sink> {
    static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();
    SINK.get_or_init(|| Mutex::new(Sink { ring: VecDeque::with_capacity(RING_LINES), file: None, dir: None, written: 0 }))
}

/// What the previous run left behind (read once at boot, before rotation).
#[derive(Clone, Default, serde::Serialize)]
pub struct PreviousSession {
    /// `session.lock` was still there: the last run didn't reach a normal exit
    /// (crash, force-quit, power loss or OS shutdown).
    pub unclean_exit: bool,
    /// Contents of that lock ("version=… started=…").
    pub lock_info:    String,
    /// The previous run's log (last ~256 KB).
    pub lines:        Vec<String>,
}
static PREVIOUS: OnceLock<PreviousSession> = OnceLock::new();
static SESSION_STARTED: OnceLock<String> = OnceLock::new();

struct QootiLogger { level: LevelFilter }

/// Our own log targets are capitalised feature names ("Download") or module paths
/// under `qooti::`; everything else is a dependency and only matters when it warns.
fn is_ours(target: &str) -> bool {
    target.starts_with("qooti") || target.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

impl Log for QootiLogger {
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= self.level && (is_ours(m.target()) || m.level() <= Level::Warn)
    }
    fn log(&self, r: &Record) {
        if !self.enabled(r.metadata()) { return; }
        write_line(format!("[{}] [{}] [{}] {}", now_iso(), r.level(), r.target(), r.args()));
    }
    fn flush(&self) {
        if let Ok(mut s) = sink().lock() { if let Some(f) = s.file.as_mut() { let _ = f.flush(); } }
    }
}

fn write_line(line: String) {
    let _ = writeln!(std::io::stderr(), "{line}");
    let mut s = sink().lock().unwrap_or_else(|e| e.into_inner());
    append(&mut s, line);
}

fn append(s: &mut Sink, line: String) {
    if let Some(f) = s.file.as_mut() {
        if writeln!(f, "{line}").is_ok() { s.written += line.len() as u64 + 1; }
        if s.written > MAX_FILE_BYTES { rotate_live(s); }
    }
    if s.ring.len() >= RING_LINES { s.ring.pop_front(); }
    s.ring.push_back(line);
}

/// The live file got too big mid-session: move it to .prev and continue in a new one.
fn rotate_live(s: &mut Sink) {
    let Some(dir) = s.dir.clone() else { return };
    s.file = None;
    let _ = std::fs::rename(dir.join(LOG_FILE), dir.join(PREV_FILE));
    s.file = OpenOptions::new().create(true).write(true).truncate(true).open(dir.join(LOG_FILE)).ok();
    s.written = 0;
}

pub fn init() {
    let level = match std::env::var("RUST_LOG").unwrap_or_default().to_ascii_lowercase().as_str() {
        s if s.contains("trace") => LevelFilter::Trace,
        s if s.contains("debug") => LevelFilter::Debug,
        s if s.contains("warn")  => LevelFilter::Warn,
        s if s.contains("error") => LevelFilter::Error,
        _                        => LevelFilter::Info,
    };
    if log::set_boxed_logger(Box::new(QootiLogger { level })).is_ok() {
        log::set_max_level(level);
    }
    let _ = SESSION_STARTED.set(now_iso());
    install_panic_hook();
}

/// Record panics (message, place, thread, backtrace) in the log before the default
/// hook runs — a panicking background thread used to vanish without a trace.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(non-string panic payload)".into());
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let bt: Vec<&str> = bt.lines().take(40).collect();
        let line = format!("[{}] [ERROR] [Panic] thread '{thread}' panicked at {at}: {msg}\n    {}",
                           now_iso(), bt.join("\n    "));
        let _ = writeln!(std::io::stderr(), "{line}");
        // try_lock: if the panic happened while this thread held the sink, don't deadlock.
        if let Ok(mut s) = sink().try_lock() {
            append(&mut s, line);
            if let Some(f) = s.file.as_mut() { let _ = f.flush(); }
        }
        default(info);
    }));
}

/// Open the log file (called from setup, once the app's log dir is known). Keeps the
/// previous run's log as .prev, notes whether it ended cleanly, writes a fresh
/// session.lock and flushes everything logged before this point into the new file.
pub fn attach_file(dir: &Path, version: &str) {
    if std::fs::create_dir_all(dir).is_err() { return; }
    let lock = dir.join(LOCK_FILE);
    let prev = PreviousSession {
        unclean_exit: lock.exists(),
        lock_info:    std::fs::read_to_string(&lock).unwrap_or_default().trim().to_string(),
        lines:        tail_lines(&dir.join(LOG_FILE), 256 * 1024),
    };
    let _ = PREVIOUS.set(prev);
    let _ = std::fs::rename(dir.join(LOG_FILE), dir.join(PREV_FILE));
    let _ = std::fs::write(&lock, format!("version={version} started={} pid={}",
        SESSION_STARTED.get().cloned().unwrap_or_default(), std::process::id()));

    let mut s = sink().lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut f) = OpenOptions::new().create(true).write(true).truncate(true).open(dir.join(LOG_FILE)) else { return };
    let mut written = 0u64;
    for line in &s.ring {
        if writeln!(f, "{line}").is_ok() { written += line.len() as u64 + 1; }
    }
    s.file = Some(f);
    s.dir = Some(dir.to_path_buf());
    s.written = written;
}

/// Normal exit (window closed / quit / restart for an update): remove session.lock so
/// the next launch doesn't report an unexpected exit.
pub fn mark_clean_exit(reason: &str) {
    log::info!(target: "Boot", "session end: {reason}");
    let s = sink().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = s.dir.as_ref() { let _ = std::fs::remove_file(dir.join(LOCK_FILE)); }
}

/// This session's lines, oldest first (the in-memory ring; complete unless huge).
pub fn session_lines() -> Vec<String> {
    let s = sink().lock().unwrap_or_else(|e| e.into_inner());
    s.ring.iter().cloned().collect()
}

pub fn previous_session() -> PreviousSession { PREVIOUS.get().cloned().unwrap_or_default() }
pub fn session_started() -> String { SESSION_STARTED.get().cloned().unwrap_or_default() }
pub fn log_dir() -> Option<PathBuf> { sink().lock().ok().and_then(|s| s.dir.clone()) }

/// Log a line that came from the webview (level + already-formatted text).
pub fn frontend(level: &str, target: &str, msg: &str) {
    let lvl = match level { "error" => Level::Error, "warn" => Level::Warn, "debug" => Level::Debug, _ => Level::Info };
    // Multi-line messages (stack traces) stay together, indented under their line.
    let msg = msg.trim_end().replace('\n', "\n    ");
    log::log!(target: target, lvl, "{msg}");
}

/// Last `max_bytes` of a file as lines (the first, possibly cut, line is dropped).
fn tail_lines(path: &Path, max_bytes: u64) -> Vec<String> {
    let Ok(mut f) = File::open(path) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if f.seek(SeekFrom::Start(start)).is_err() { return vec![]; }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() { return vec![]; }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() { lines.remove(0); }
    lines
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_targets_vs_dependencies() {
        assert!(is_ours("Download"));
        assert!(is_ours("qooti::commands"));
        assert!(!is_ours("tao::platform_impl"));
        assert!(!is_ours("ureq::unit"));
    }

    #[test]
    fn tail_drops_the_cut_line() {
        let dir = std::env::temp_dir().join(format!("qooti-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.log");
        std::fs::write(&p, "aaaa\nbbbb\ncccc\n").unwrap();
        assert_eq!(tail_lines(&p, 1024), vec!["aaaa", "bbbb", "cccc"]);
        assert_eq!(tail_lines(&p, 7), vec!["cccc"]);   // "bb\ncccc\n" → partial "bb" dropped
        let _ = std::fs::remove_dir_all(&dir);
    }
}
