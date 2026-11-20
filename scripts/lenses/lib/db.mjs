// Read-only access to a qooti library DB copy through Node's built-in node:sqlite.
// Never point this at the live app data: work on the copy in the eval folder (spec §11).
import fs from 'node:fs';
import path from 'node:path';

let sqliteMod = null;
async function sqlite() {
  if (sqliteMod) return sqliteMod;
  // node:sqlite prints an ExperimentalWarning on load; keep tool output clean.
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const msg = typeof w === 'string' ? w : (w && w.message) || '';
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] && rest[0].type) || (w && w.name) || '';
    if (/SQLite/i.test(msg) && /Experimental/i.test(String(type))) return;
    return orig.call(process, w, ...rest);
  };
  try {
    sqliteMod = await import('node:sqlite');
  } finally {
    process.emitWarning = orig;
  }
  return sqliteMod;
}

const APP_DATA_HINT = /app\.bloot\.qooti/i;

/** Opens `file` read-only. Refuses the live app-data DB. */
export async function openReadOnly(file) {
  const abs = path.resolve(file);
  if (APP_DATA_HINT.test(abs.replace(/\\/g, '/'))) {
    throw new Error(`refusing to open the live library (${abs}); use the copy in the eval folder`);
  }
  if (!fs.existsSync(abs)) throw new Error(`DB not found: ${abs}`);
  const { DatabaseSync } = await sqlite();
  return new DatabaseSync(abs, { readOnly: true });
}

export function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** Media kind used by the scorer: 'picture' for image/gif, 'video' for video, null otherwise. */
export function mediaKind(type) {
  if (type === 'image' || type === 'gif') return 'picture';
  if (type === 'video') return 'video';
  return null;
}
