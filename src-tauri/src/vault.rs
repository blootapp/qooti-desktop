use std::path::PathBuf;
use anyhow::Result;
use tauri::{AppHandle, Manager};

const VAULT_PATH_CONFIG: &str = "vault_path.txt";

/// Returns the active vault root. If the user has set a custom path via
/// set_custom_vault_path(), that is used; otherwise falls back to the
/// default app-data location.
pub fn get_vault_path(app: &AppHandle) -> Result<PathBuf> {
    if let Some(custom) = read_custom_vault_path(app)? {
        ensure_structure(&custom)?;
        return Ok(custom);
    }
    let vault = default_vault_path(app)?;
    ensure_structure(&vault)?;
    Ok(vault)
}

pub fn default_vault_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("vault"))
}

pub fn read_custom_vault_path(app: &AppHandle) -> Result<Option<PathBuf>> {
    let cfg = app.path().app_data_dir()?.join(VAULT_PATH_CONFIG);
    if !cfg.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&cfg)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(trimmed)))
}

pub fn write_custom_vault_path(app: &AppHandle, path: &PathBuf) -> Result<()> {
    let cfg = app.path().app_data_dir()?.join(VAULT_PATH_CONFIG);
    std::fs::write(cfg, path.to_string_lossy().as_bytes())?;
    Ok(())
}

pub fn clear_custom_vault_path(app: &AppHandle) -> Result<()> {
    let cfg = app.path().app_data_dir()?.join(VAULT_PATH_CONFIG);
    if cfg.exists() {
        std::fs::remove_file(cfg)?;
    }
    Ok(())
}

pub fn ensure_structure(vault: &PathBuf) -> Result<()> {
    for dir in &["images", "videos", "gifs", "links", "thumbnails", "profile", "temp"] {
        std::fs::create_dir_all(vault.join(dir))?;
    }
    Ok(())
}

pub fn vault_relative(vault: &PathBuf, abs: &PathBuf) -> Option<String> {
    abs.strip_prefix(vault).ok().map(|p| p.to_string_lossy().into_owned())
}

pub fn vault_absolute(vault: &PathBuf, relative: &str) -> PathBuf {
    vault.join(relative)
}

/// Returns free bytes available at the given path's disk.
/// Uses platform-specific syscalls; returns None if unavailable.
pub fn disk_free_bytes(path: &PathBuf) -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free_bytes: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free: u64 = 0;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_bytes,
                &mut total_bytes,
                &mut total_free,
            )
        };
        if ok != 0 { Some(free_bytes) } else { None }
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::mem;
        let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { mem::zeroed() };
        let ret = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
        if ret == 0 { Some(stat.f_bavail as u64 * stat.f_frsize as u64) } else { None }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

/// Returns total size in bytes of all files under the given directory (recursive).
pub fn dir_size_bytes(dir: &PathBuf) -> u64 {
    walkdir_size(dir)
}

fn walkdir_size(dir: &PathBuf) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.flatten().fold(0u64, |acc, entry| {
        let path = entry.path();
        if path.is_dir() {
            acc + walkdir_size(&path)
        } else {
            acc + entry.metadata().map(|m| m.len()).unwrap_or(0)
        }
    })
}
