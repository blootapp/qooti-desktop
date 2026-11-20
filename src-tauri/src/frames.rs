// Video frames for tag suggestions (spec §6.1). The CLIP indexer (clip.rs) reads one frame per
// second of each video, at least 8 and at most 32 (`frame_count`; owner decision 2026-11-20,
// "R45"), embeds them in memory and keeps only the vectors (clip_frames), so a video is judged on
// the whole clip rather than its cover (in the owner's library the cover alone pointed at a
// different main tag than the clip in 7 of 10 videos). Until 2026-11-20 every video got 8 frames;
// clip.rs re-reads the rows made that way once (FRAMES_TAG_8).
//
// ffmpeg runs in the background while people work, so it starts at low priority with a single
// thread and no console window.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Frames per video: one per second of the clip, at least this many…
pub const MIN_FRAMES: usize = 8;
/// …and at most this many (a 60 s clip gets one about every 1.7 s).
pub const MAX_FRAMES: usize = 32;
/// The short side of each frame: exactly what CLIP reads.
pub const SHORT_SIDE: u32 = 224;
const FRAME_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Measuring a length reads the whole file; a run cut off by this counts as "length unknown".
const MEASURE_TIMEOUT: Duration = Duration::from_secs(120);

/// How many frames a video `dur` seconds long gets: one per second, rounded up, at least
/// MIN_FRAMES and at most MAX_FRAMES (2 s → 8, 20.4 s → 21, 45 s → 32). Up to 8 s it is 8 at the
/// same times as before 2026-11-20, so those rows stay (clip.rs). A length that isn't a number
/// above 0 gives MIN_FRAMES (callers never pass one). scripts/lenses/embed-frames.mjs frameCount
/// mirrors it.
pub fn frame_count(dur: f64) -> usize {
    if !(dur.is_finite() && dur > 0.0) { return MIN_FRAMES; }
    (dur.ceil() as usize).clamp(MIN_FRAMES, MAX_FRAMES)
}

/// When to take `n` frames from a video `dur` seconds long: the middle of `n` equal slices of
/// the clip without its first and last 4 % (fades, black frames, end cards).
pub(crate) fn frame_times(dur: f64, n: usize) -> Vec<f64> {
    (0..n).map(|i| dur * (0.04 + 0.92 * (i as f64 + 0.5) / n as f64)).collect()
}

/// ffmpeg for background work: no console window and below-normal priority on Windows
/// (CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS). Callers also pass `-threads 1`.
pub(crate) fn low_priority_command(program: &Path) -> Command {
    #[allow(unused_mut)]   // only Windows sets flags
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    cmd
}

/// Lower a just-started child's priority where the spawn flags can't (macOS).
fn lower_priority(_child: &std::process::Child) {
    #[cfg(target_os = "macos")]
    // SAFETY: setpriority(2) on a process id we just spawned.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, _child.id() as libc::id_t, 10);
    }
}

/// Run `cmd`, collect its stdout, kill it after `timeout`. Some(bytes) only on a clean exit.
fn run_capture(mut cmd: Command, timeout: Duration, stdout: bool) -> Option<Vec<u8>> {
    use std::io::Read;
    cmd.stdin(Stdio::null());
    if stdout { cmd.stdout(Stdio::piped()).stderr(Stdio::null()); } else { cmd.stdout(Stdio::null()).stderr(Stdio::piped()); }
    let mut child = cmd.spawn().ok()?;
    lower_priority(&child);
    let mut pipe: Box<dyn Read + Send> = if stdout { Box::new(child.stdout.take()?) } else { Box::new(child.stderr.take()?) };
    let reader = std::thread::spawn(move || { let mut b = Vec::new(); let _ = pipe.read_to_end(&mut b); b });
    let deadline = Instant::now() + timeout;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.success(),
            Ok(None) if Instant::now() >= deadline => { let _ = child.kill(); let _ = child.wait(); break false; }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => break false,
        }
    };
    let bytes = reader.join().unwrap_or_default();
    // `ffmpeg -i <file>` with no output always exits 1, so the probe keeps its stderr regardless.
    (ok || !stdout).then_some(bytes)
}

/// One frame at `t` seconds as a JPEG with a 224 px short side, so ffmpeg's scaler does the
/// shrinking. `-ss` before `-i` jumps straight to the nearest keyframe, so long videos cost the
/// same as short ones. Gives up after 20 s so a broken file can't hold up the queue.
pub(crate) fn grab_frame(ffmpeg: &Path, video: &str, t: f64) -> Option<Vec<u8>> {
    let mut cmd = low_priority_command(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-ss", &format!("{t:.3}"), "-i", video,
              "-frames:v", "1", "-vf", "scale='if(gte(iw,ih),-2,224)':'if(gte(iw,ih),224,-2)'",
              "-threads", "1", "-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]);
    run_capture(cmd, FRAME_TIMEOUT, true).filter(|b| b.len() > 100)
}

/// A video's length from `ffmpeg -i` (for items saved without one). None when the file's header
/// has no length ("Duration: N/A", for example a WebM recorded in a browser): `measure_duration`.
pub fn probe_duration(ffmpeg: &Path, video: &str) -> Option<f64> {
    let mut cmd = low_priority_command(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-threads", "1", "-i", video]);
    let err = run_capture(cmd, PROBE_TIMEOUT, false)?;
    parse_duration(&String::from_utf8_lossy(&err))
}

/// The length of a video whose header has none: ffmpeg reads every packet of the first video
/// stream without decoding it (`-c copy -f null`) and reports where it ended (`-progress`). It
/// reads the whole file, so it may take up to 2 minutes; a run that fails or is cut off gives
/// None, never the last time it saw. scripts/lenses/embed-frames.mjs (measureDuration) mirrors it.
pub fn measure_duration(ffmpeg: &Path, video: &str) -> Option<f64> {
    let mut cmd = low_priority_command(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-i", video,
              "-map", "0:v:0", "-c", "copy", "-f", "null", "-progress", "pipe:1", "-nostats", "-"]);
    let out = run_capture(cmd, MEASURE_TIMEOUT, true)?;
    parse_progress_duration(&String::from_utf8_lossy(&out))
}

/// The header's length, else the measured one, else None (the video then gets no tag
/// suggestions at all: Tag lens spec §0b.1).
pub fn find_duration(ffmpeg: &Path, video: &str) -> Option<f64> {
    probe_duration(ffmpeg, video).or_else(|| measure_duration(ffmpeg, video))
}

/// A finished `-progress` report → its last `out_time_us`, in seconds. None when the report never
/// got to `progress=end` or holds no time. Builds without `out_time_us` print `out_time_ms`, which
/// counts microseconds too.
fn parse_progress_duration(text: &str) -> Option<f64> {
    let (mut ended, mut us, mut ms) = (false, None, None);
    for line in text.lines().map(str::trim) {
        if line == "progress=end" {
            ended = true;
        } else if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(n) = v.parse::<u64>() { us = Some(n); }
        } else if let Some(v) = line.strip_prefix("out_time_ms=") {
            if let Ok(n) = v.parse::<u64>() { ms = Some(n); }
        }
    }
    if !ended { return None; }
    let secs = us.or(ms)? as f64 / 1e6;
    (secs.is_finite() && secs > 0.0).then_some(secs)
}

/// "Duration: 00:01:23.45," → 83.45
fn parse_duration(text: &str) -> Option<f64> {
    let rest = &text[text.find("Duration:")? + "Duration:".len()..];
    let parts: Vec<f64> = rest[..rest.find(',')?].trim().split(':').map(|p| p.trim().parse::<f64>().ok()).collect::<Option<_>>()?;
    let secs = match parts.as_slice() { [h, m, s] => h * 3600.0 + m * 60.0 + s, _ => return None };
    (secs.is_finite() && secs > 0.0).then_some(secs)
}

/// Up to `frame_count(length)` JPEG frames of `video` (224 px short side), spread across the clip
/// as `frame_times` says. `duration` is the stored length; when it is missing, ffmpeg finds it
/// (`find_duration`). Frames that can't be read are skipped, so this can return fewer, or none.
pub fn extract_frames(ffmpeg: &Path, video: &str, duration: Option<f64>) -> Vec<Vec<u8>> {
    let Some(dur) = duration.filter(|d| d.is_finite() && *d > 0.0).or_else(|| find_duration(ffmpeg, video)) else {
        return Vec::new();
    };
    frame_times(dur, frame_count(dur)).into_iter().filter_map(|t| grab_frame(ffmpeg, video, t)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_spread_across_the_clip_without_its_ends() {
        let t = frame_times(100.0, 8);
        assert_eq!(t.len(), 8);
        assert!((t[0] - 9.75).abs() < 1e-9 && (t[7] - 90.25).abs() < 1e-9);
        assert!(t.windows(2).all(|w| w[1] > w[0]));
        assert!(t.iter().all(|&x| x > 4.0 && x < 96.0));
        assert_eq!(frame_times(10.0, 1), vec![5.0]);
    }

    #[test]
    fn one_frame_per_second_from_8_to_32() {
        // Owner decision 2026-11-20 (R45): one frame per second of the clip, rounded up, 8–32.
        for (dur, n) in [(0.4, 8), (2.0, 8), (7.99, 8), (8.0, 8), (8.0001, 9), (8.5, 9), (15.0, 15), (20.4, 21),
                         (30.5, 31), (31.0, 31), (31.2, 32), (32.0, 32), (45.0, 32), (60.5, 32), (1400.0, 32)] {
            assert_eq!(frame_count(dur), n, "{dur} s");
        }
        // Not a length: the minimum (callers never pass one)
        for bad in [0.0, -3.0, f64::NAN, f64::INFINITY] { assert_eq!(frame_count(bad), MIN_FRAMES, "{bad}"); }
        // Up to 8 s the schedule is the 8 frames every video got before, at the same times
        for dur in [0.5, 3.0, 8.0] { assert_eq!(frame_times(dur, frame_count(dur)), frame_times(dur, 8)); }
        // A 20.4 s clip: 21 frames, one per 0.89 s, inside the first and last 4 %
        let t = frame_times(20.4, frame_count(20.4));
        assert_eq!(t.len(), 21);
        assert!(t.windows(2).all(|w| (w[1] - w[0] - 20.4 * 0.92 / 21.0).abs() < 1e-9));
        assert!(t[0] > 20.4 * 0.04 && t[20] < 20.4 * 0.96);
    }

    #[test]
    fn reads_the_duration_line() {
        let err = "Input #0, mov,mp4 from 'x.mp4':\n  Duration: 00:01:23.45, start: 0.000000, bitrate: 1 kb/s";
        assert!((parse_duration(err).unwrap() - 83.45).abs() < 1e-9);
        assert_eq!(parse_duration("Duration: N/A, start"), None);
        assert_eq!(parse_duration("nothing"), None);
    }

    #[test]
    fn reads_the_progress_report() {
        // What the bundled ffmpeg prints for a 40-second WebM with no length in its header.
        let report = "out_time_us=0\nout_time_ms=0\nprogress=continue\nbitrate=N/A\n\
                      out_time_us=39900000\nout_time_ms=39900000\nout_time=00:00:39.900000\nprogress=end\n";
        assert!((parse_progress_duration(report).unwrap() - 39.9).abs() < 1e-9);
        assert!((parse_progress_duration(&report.replace('\n', "\r\n")).unwrap() - 39.9).abs() < 1e-9);
        // A run that never finished (killed after its time limit) is "unknown", not its last time.
        assert_eq!(parse_progress_duration("out_time_us=12000000\nprogress=continue\n"), None);
        // An "N/A" after a number keeps the number; older builds only print out_time_ms (µs too).
        assert!((parse_progress_duration("out_time_us=5000000\nout_time_us=N/A\nprogress=end").unwrap() - 5.0).abs() < 1e-9);
        assert!((parse_progress_duration("out_time_ms=7500000\nprogress=end").unwrap() - 7.5).abs() < 1e-9);
        assert_eq!(parse_progress_duration("out_time_us=0\nprogress=end"), None);
        assert_eq!(parse_progress_duration("out_time_us=-9223372036854775807\nprogress=end"), None);
        assert_eq!(parse_progress_duration("progress=end"), None);
    }

    fn bundled_ffmpeg() -> Option<std::path::PathBuf> {
        #[cfg(windows)] let name = "ffmpeg-x86_64-pc-windows-msvc.exe";
        #[cfg(target_os = "macos")] let name = "ffmpeg-aarch64-apple-darwin";
        #[cfg(not(any(windows, target_os = "macos")))] let name = "ffmpeg-x86_64-unknown-linux-gnu";
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name)).filter(|p| p.exists())
    }

    /// A WebM written to a pipe, as browsers record them: no length in its header.
    fn headerless_webm(ff: &Path, file: &Path, secs: u32, size: &str, fps: u32) {
        let out = std::fs::File::create(file).unwrap();
        let made = low_priority_command(ff)
            .args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", &format!("testsrc=duration={secs}:size={size}:rate={fps}"),
                   "-c:v", "libvpx", "-b:v", "100k", "-f", "webm", "pipe:1"])
            .stdout(Stdio::from(out)).status().unwrap();
        assert!(made.success());
    }

    /// Needs the bundled ffmpeg (src-tauri/binaries); skipped where it isn't present.
    #[test]
    fn measures_videos_whose_header_has_no_length() {
        let Some(ff) = bundled_ffmpeg() else { eprintln!("skipped: no bundled ffmpeg"); return };
        let dir = std::env::temp_dir().join(format!("qooti-nolength-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let short = dir.join("short.webm");
        let long = dir.join("long.webm");
        headerless_webm(&ff, &short, 6, "320x240", 10);
        headerless_webm(&ff, &long, 36, "160x120", 5);
        let (short, long) = (short.to_str().unwrap(), long.to_str().unwrap());
        assert_eq!(probe_duration(&ff, short), None, "the header has no length");
        // The packets end at the last frame's start: 5.9 s and 35.8 s.
        let s = measure_duration(&ff, short).expect("measured");
        assert!((s - 5.9).abs() < 0.15, "{s}");
        let l = find_duration(&ff, long).expect("measured");
        assert!((l - 35.8).abs() < 0.25 && l > 30.5, "{l}");
        // With the measured length the frames can be read as usual (5.9 s: 8 frames).
        assert_eq!(extract_frames(&ff, short, None).len(), MIN_FRAMES);
        let missing = dir.join("missing.webm");
        assert_eq!(measure_duration(&ff, missing.to_str().unwrap()), None);
        assert_eq!(find_duration(&ff, missing.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Needs the bundled ffmpeg (src-tauri/binaries); skipped where it isn't present.
    #[test]
    fn extracts_one_jpeg_frame_per_second_with_a_224px_short_side() {
        #[cfg(windows)] let name = "ffmpeg-x86_64-pc-windows-msvc.exe";
        #[cfg(target_os = "macos")] let name = "ffmpeg-aarch64-apple-darwin";
        #[cfg(not(any(windows, target_os = "macos")))] let name = "ffmpeg-x86_64-unknown-linux-gnu";
        let ff = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name);
        if !ff.exists() { eprintln!("skipped: no bundled ffmpeg"); return; }
        let dir = std::env::temp_dir().join(format!("qooti-frames-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 4 s: the minimum of 8 frames; 12.5 s: one per second, 13
        for (file, size, wide, secs, want) in [("wide.mp4", "640x360", true, "4", MIN_FRAMES), ("tall.webm", "360x640", false, "4", MIN_FRAMES),
                                               ("long.mp4", "320x180", true, "12.5", 13)] {
            let video = dir.join(file);
            let made = low_priority_command(&ff)
                .args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", &format!("testsrc=duration={secs}:size={size}:rate=25"),
                       "-pix_fmt", "yuv420p", "-y"]).arg(&video)
                .status().unwrap();
            assert!(made.success());
            let path = video.to_str().unwrap();
            let secs: f64 = secs.parse().unwrap();
            let d = probe_duration(&ff, path).expect("duration");
            assert!((d - secs).abs() < 0.1, "duration {d}");
            // Without a stored duration ffmpeg measures it first.
            for frames in [extract_frames(&ff, path, Some(secs)), extract_frames(&ff, path, None)] {
                assert_eq!(frames.len(), want, "{file}");
                for jpg in frames {
                    assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
                    let img = image::load_from_memory(&jpg).unwrap();
                    let (w, h) = (img.width(), img.height());
                    if wide { assert_eq!(h, SHORT_SIDE); assert!(w > h) } else { assert_eq!(w, SHORT_SIDE); assert!(h > w) }
                }
            }
        }
        let missing = dir.join("missing.mp4");
        assert!(grab_frame(&ff, missing.to_str().unwrap(), 1.0).is_none());
        assert!(extract_frames(&ff, missing.to_str().unwrap(), None).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
