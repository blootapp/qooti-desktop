// Structured logger for the Rust backend.
// Format: [ISO_TIMESTAMP] [LEVEL] [target] message
//
// Level defaults to INFO; set RUST_LOG=debug for verbose output.

pub fn init() {
    let _ = env_logger::Builder::new()
        .format(|buf, record| {
            use std::io::Write;
            writeln!(
                buf,
                "[{}] [{}] [{}] {}",
                now_iso(),
                record.level(),
                record.target(),
                record.args(),
            )
        })
        .filter_level(log::LevelFilter::Info)
        .parse_default_env()
        .try_init();
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let ss = secs % 60;
    let mm = (secs / 60) % 60;
    let hh = (secs / 3600) % 24;

    let (y, mo, d) = civil_date(secs / 86400 + 719468);
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

// Howard Hinnant's algorithm: days since proleptic Gregorian epoch → (year, month, day).
fn civil_date(z: u64) -> (u64, u64, u64) {
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y   = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = doy - (153 * mp + 2) / 5 + 1;
    let mo  = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if mo <= 2 { y + 1 } else { y };
    (y, mo, d)
}
