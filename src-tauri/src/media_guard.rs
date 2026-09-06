//! Magic-byte content validation for all media entering the qooti vault.
//!
//! Never trusts file extensions or OS-reported MIME types — they are trivially
//! spoofed.  Every file is identified by its first 512 bytes before it is
//! allowed past the import boundary.  Anything whose real content type is not
//! on the explicit whitelist is rejected with a clear error, logged, and never
//! processed further.

use std::path::Path;

/// Hard cap on imported file size: 4 GiB.
/// Checked via filesystem metadata before any bytes are read into memory.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Bytes read for magic detection — 512 covers every format we support.
const HEADER_LEN: usize = 512;

// ── Public types ─────────────────────────────────────────────────────────────

/// Everything the rest of the import pipeline needs once a file is validated.
#[derive(Debug, Clone)]
pub struct ValidatedMedia {
    pub db_type:       &'static str,  // "image" | "gif" | "video"
    pub subdir:        &'static str,  // "images" | "gifs" | "videos"
    pub mime:          &'static str,  // canonical MIME string
    pub real_ext:      &'static str,  // canonical vault extension (jpg / png / …)
    pub default_ratio: f64,           // fallback aspect ratio (1.0 for images, 1.78 for video)
}

/// Why a file was rejected.
#[derive(Debug)]
pub enum GuardError {
    Io(std::io::Error),
    TooLarge    { size: u64, filename: String },
    Unsupported { filename: String, claimed_ext: String, detected: String },
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::Io(e) =>
                write!(f, "io_error error={e}"),
            GuardError::TooLarge { size, filename } =>
                write!(f, "too_large filename={filename:?} size={size}"),
            GuardError::Unsupported { filename, claimed_ext, detected } =>
                write!(f, "unsupported filename={filename:?} claimed_ext={claimed_ext:?} detected={detected:?}"),
        }
    }
}

impl GuardError {
    pub fn user_message(&self) -> String {
        match self {
            GuardError::TooLarge { .. } =>
                "File is too large to import (max 4 GB).".into(),
            GuardError::Unsupported { filename, .. } =>
                format!("Unsupported or corrupted file: {filename}"),
            GuardError::Io(_) =>
                "Could not read file.".into(),
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Validate a file on disk.
///
/// 1. Checks file size via metadata (no full read).
/// 2. Reads first 512 bytes.
/// 3. Identifies real type from magic bytes via the `infer` crate.
/// 4. Rejects anything not on the supported-type whitelist.
pub fn validate_path(path: &Path) -> Result<ValidatedMedia, GuardError> {
    let filename    = filename_str(path);
    let claimed_ext = ext_str(path);

    let size = std::fs::metadata(path)
        .map_err(GuardError::Io)?
        .len();
    if size > MAX_FILE_BYTES {
        log::warn!(target: "MediaGuard",
            "rejected_too_large filename={filename:?} size={size} claimed_ext={claimed_ext:?}");
        return Err(GuardError::TooLarge { size, filename });
    }

    let header = read_header(path).map_err(GuardError::Io)?;
    classify_or_err(&header, filename, claimed_ext)
}

/// Validate bytes already in memory (e.g. extracted from a .qooti pack).
///
/// Same whitelist and logging as `validate_path`.
pub fn validate_bytes(bytes: &[u8], filename: &str) -> Result<ValidatedMedia, GuardError> {
    let claimed_ext = ext_str(Path::new(filename));

    if bytes.len() as u64 > MAX_FILE_BYTES {
        log::warn!(target: "MediaGuard",
            "rejected_too_large filename={filename:?} size={}", bytes.len());
        return Err(GuardError::TooLarge {
            size: bytes.len() as u64,
            filename: filename.to_string(),
        });
    }

    let header = &bytes[..bytes.len().min(HEADER_LEN)];
    classify_or_err(header, filename.to_string(), claimed_ext)
}

// ── Internals ─────────────────────────────────────────────────────────────────

fn filename_str(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string()
}

fn ext_str(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

fn read_header(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut f   = std::fs::File::open(path)?;
    let mut buf = vec![0u8; HEADER_LEN];
    let n       = f.read(&mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

fn classify_or_err(
    header: &[u8],
    filename: String,
    claimed_ext: String,
) -> Result<ValidatedMedia, GuardError> {
    match classify(header) {
        Some(m) => {
            log::info!(target: "MediaGuard",
                "accepted filename={filename:?} claimed_ext={claimed_ext:?} detected={}", m.mime);
            Ok(m)
        }
        None => {
            let detected = infer::get(header)
                .map(|t| t.mime_type().to_string())
                .unwrap_or_else(|| "unknown".into());
            log::warn!(target: "MediaGuard",
                "rejected filename={filename:?} claimed_ext={claimed_ext:?} detected={detected:?}");
            Err(GuardError::Unsupported { filename, claimed_ext, detected })
        }
    }
}

/// Explicit whitelist: only these content types may enter the vault.
fn classify(header: &[u8]) -> Option<ValidatedMedia> {
    let kind = infer::get(header)?;
    match kind.mime_type() {
        "image/jpeg" => Some(ValidatedMedia {
            db_type: "image", subdir: "images", mime: "image/jpeg",
            real_ext: "jpg",  default_ratio: 1.0,
        }),
        "image/png" => Some(ValidatedMedia {
            db_type: "image", subdir: "images", mime: "image/png",
            real_ext: "png",  default_ratio: 1.0,
        }),
        "image/gif" => Some(ValidatedMedia {
            db_type: "gif",   subdir: "gifs",   mime: "image/gif",
            real_ext: "gif",  default_ratio: 1.0,
        }),
        "image/webp" => Some(ValidatedMedia {
            db_type: "image", subdir: "images", mime: "image/webp",
            real_ext: "webp", default_ratio: 1.0,
        }),
        "image/avif" => Some(ValidatedMedia {
            db_type: "image", subdir: "images", mime: "image/avif",
            real_ext: "avif", default_ratio: 1.0,
        }),
        // infer reports HEIC/HEIF as "image/heif"
        "image/heif" | "image/heic" => Some(ValidatedMedia {
            db_type: "image", subdir: "images", mime: "image/heic",
            real_ext: "heic", default_ratio: 1.0,
        }),
        "video/mp4" => Some(ValidatedMedia {
            db_type: "video", subdir: "videos", mime: "video/mp4",
            real_ext: "mp4",  default_ratio: 1.78,
        }),
        "video/webm" => Some(ValidatedMedia {
            db_type: "video", subdir: "videos", mime: "video/webm",
            real_ext: "webm", default_ratio: 1.78,
        }),
        "video/quicktime" | "video/x-quicktime" => Some(ValidatedMedia {
            db_type: "video", subdir: "videos", mime: "video/quicktime",
            real_ext: "mov",  default_ratio: 1.78,
        }),
        _ => None,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal valid magic-byte prefixes for each supported format
    const JPEG:  &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1];
    const PNG:   &[u8] = &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n', 0, 0, 0, 0x0D];
    const GIF:   &[u8] = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xFF\xFF\xFF\x00\x00\x00!\xF9";
    const WEBM:  &[u8] = &[0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F];

    fn webp_bytes() -> Vec<u8> {
        let mut b = vec![b'R', b'I', b'F', b'F', 0x28, 0, 0, 0, b'W', b'E', b'B', b'P'];
        b.extend_from_slice(b"VP8L");
        b
    }

    // ── Accepted formats ──────────────────────────────────────────

    #[test]
    fn jpeg_accepted() {
        let m = validate_bytes(JPEG, "photo.jpg").unwrap();
        assert_eq!(m.db_type, "image");
        assert_eq!(m.real_ext, "jpg");
    }

    #[test]
    fn png_accepted() {
        let m = validate_bytes(PNG, "image.png").unwrap();
        assert_eq!(m.db_type, "image");
        assert_eq!(m.real_ext, "png");
    }

    #[test]
    fn gif_accepted() {
        let m = validate_bytes(GIF, "anim.gif").unwrap();
        assert_eq!(m.db_type, "gif");
        assert_eq!(m.real_ext, "gif");
    }

    #[test]
    fn webp_accepted() {
        let m = validate_bytes(&webp_bytes(), "image.webp").unwrap();
        assert_eq!(m.db_type, "image");
        assert_eq!(m.real_ext, "webp");
    }

    #[test]
    fn webm_accepted_as_video() {
        let m = validate_bytes(WEBM, "clip.webm").unwrap();
        assert_eq!(m.db_type, "video");
        assert_eq!(m.real_ext, "webm");
    }

    // ── Spoofed / malicious files rejected ────────────────────────

    #[test]
    fn plaintext_renamed_jpg_rejected() {
        let err = validate_bytes(b"Hello, I am plaintext.", "photo.jpg").unwrap_err();
        assert!(matches!(err, GuardError::Unsupported { .. }),
            "plaintext renamed to .jpg must be rejected");
    }

    #[test]
    fn windows_pe_renamed_mp4_rejected() {
        let pe = b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF\x00\x00";
        validate_bytes(pe, "video.mp4").unwrap_err();
    }

    #[test]
    fn elf_binary_renamed_jpg_rejected() {
        let elf = b"\x7FELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00";
        validate_bytes(elf, "picture.jpg").unwrap_err();
    }

    #[test]
    fn zip_renamed_jpg_rejected() {
        let zip = b"PK\x03\x04\x14\x00\x00\x00\x08\x00";
        validate_bytes(zip, "photo.jpg").unwrap_err();
    }

    #[test]
    fn shell_script_renamed_mp4_rejected() {
        validate_bytes(b"#!/bin/bash\nrm -rf /\n", "video.mp4").unwrap_err();
    }

    #[test]
    fn pdf_renamed_jpg_rejected() {
        validate_bytes(b"%PDF-1.4\n1 0 obj\n", "image.jpg").unwrap_err();
    }

    #[test]
    fn null_bytes_rejected() {
        validate_bytes(&[0u8; 64], "image.jpg").unwrap_err();
    }

    #[test]
    fn empty_bytes_rejected() {
        validate_bytes(b"", "photo.jpg").unwrap_err();
    }

    // ── Content wins over extension ────────────────────────────────

    #[test]
    fn png_bytes_with_mp4_extension_accepted_as_image() {
        let m = validate_bytes(PNG, "fake_video.mp4").unwrap();
        assert_eq!(m.db_type, "image",
            "PNG content must be classified as image regardless of .mp4 extension");
    }

    #[test]
    fn jpeg_bytes_with_exe_extension_accepted() {
        // Real JPEG masquerading as executable — still accepted because we trust content
        let m = validate_bytes(JPEG, "malware.exe").unwrap();
        assert_eq!(m.real_ext, "jpg");
    }

    // ── validate_path (disk I/O) ──────────────────────────────────

    fn write_tmp(name: &str, content: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn path_jpeg_accepted() {
        let p = write_tmp("qooti_guard_valid.jpg", JPEG);
        let result = validate_path(&p);
        std::fs::remove_file(&p).ok();
        assert!(result.is_ok());
    }

    #[test]
    fn path_plaintext_renamed_jpg_rejected() {
        let p = write_tmp("qooti_guard_malicious.jpg", b"I am not an image");
        let result = validate_path(&p);
        std::fs::remove_file(&p).ok();
        assert!(result.is_err());
    }

    #[test]
    fn path_pe_exe_renamed_mp4_rejected() {
        let p = write_tmp("qooti_guard_malware.mp4",
            b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF");
        let result = validate_path(&p);
        std::fs::remove_file(&p).ok();
        assert!(result.is_err());
    }

    #[test]
    fn path_png_renamed_webm_still_accepted_as_image() {
        let p = write_tmp("qooti_guard_png_as_webm.webm", PNG);
        let result = validate_path(&p);
        std::fs::remove_file(&p).ok();
        let m = result.expect("PNG content should be accepted regardless of .webm extension");
        assert_eq!(m.db_type, "image");
    }
}
