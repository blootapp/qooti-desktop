// .qooti pack format (§11.1) and .qootiboard format (§11.2).
// Magic: QOOTIPK1 / QOOTIBRD1
// Note: the real .qooti / .qbord files (commands.rs, boards.rs) are only XOR-obfuscated
// with a key in the source — that hides the zip from casual view, it is NOT encryption.

use anyhow::Result;
use std::path::Path;

pub const PACK_MAGIC: &[u8]  = b"QOOTIPK1";
pub const BOARD_MAGIC: &[u8] = b"QOOTIBRD1";
pub const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB

pub fn unpack(_path: &Path, _dest: &Path) -> Result<()> {
    todo!("Pack extraction not yet implemented")
}

pub fn pack(_source_dir: &Path, _dest: &Path) -> Result<()> {
    todo!("Pack creation not yet implemented")
}

pub fn unpack_board(_path: &Path, _dest: &Path) -> Result<()> {
    todo!(".qootiboard extraction not yet implemented")
}
