use anyhow::Result;
use rusqlite::{Connection, params};
use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: i64 = 30;

pub fn init(app: &AppHandle) -> Result<Connection> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let conn = Connection::open(data_dir.join("qooti.db"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    migrate(&conn)?;

    // Reset any items that were mid-processing when the app last exited.
    let _ = conn.execute_batch(
        "UPDATE inspirations SET ocr_status      = NULL WHERE ocr_status      = 'processing';
         UPDATE inspirations SET auto_tag_status = NULL WHERE auto_tag_status = 'processing';"
    );

    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;

    let current: i64 = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v.parse().unwrap_or(0))
        .unwrap_or(0);

    if current < SCHEMA_VERSION {
        create_schema(conn)?;
        run_additive_migrations(conn)?;
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    Ok(())
}

fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(())
}

// Additive column migrations — safe to re-run; SQLite errors on duplicate column are ignored.
fn run_additive_migrations(conn: &Connection) -> Result<()> {
    let _ = conn.execute_batch("ALTER TABLE tags ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN auto_tag_status TEXT");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN auto_tag_confidence TEXT");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN auto_tag_model TEXT");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN duration_secs REAL");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN last_viewed_at INTEGER");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN import_source TEXT");
    let _ = conn.execute_batch("ALTER TABLE inspirations ADD COLUMN batch_id TEXT");

    // Free-plan feature tables (v28)
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ext_download_queue (
            id              TEXT PRIMARY KEY,
            url             TEXT NOT NULL,
            page_url        TEXT NOT NULL DEFAULT '',
            title           TEXT NOT NULL DEFAULT '',
            source_platform TEXT NOT NULL DEFAULT '',
            queued_at       INTEGER NOT NULL
        );"
    );

    // Backfill tag_usage_counts from actual inspiration_tags associations.
    // Ensures any existing data has accurate counts regardless of how tags were assigned.
    let _ = conn.execute_batch(
        "INSERT OR REPLACE INTO tag_usage_counts (tag_id, count)
         SELECT tag_id, COUNT(*) FROM inspiration_tags GROUP BY tag_id;
         INSERT OR IGNORE INTO tag_usage_counts (tag_id, count)
         SELECT id, 0 FROM tags;"
    );

    // Populate the FTS index from the content table (schema v30). Full rebuild
    // is idempotent and runs once per upgrade, since this function only executes
    // while the stored schema version is behind SCHEMA_VERSION. On a fresh
    // install inspirations is empty, so this is a no-op.
    let _ = conn.execute_batch("INSERT INTO inspirations_fts(inspirations_fts) VALUES('rebuild');");

    Ok(())
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS preferences (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS inspirations (
    id                   TEXT PRIMARY KEY,
    type                 TEXT NOT NULL CHECK(type IN ('image','gif','video','link')),
    title                TEXT,
    source_url           TEXT,
    source_platform      TEXT,
    stored_path          TEXT NOT NULL,
    thumbnail_path       TEXT,
    aspect_ratio         REAL NOT NULL DEFAULT 1.0,
    palette              TEXT,
    ocr_text             TEXT NOT NULL DEFAULT '',
    ocr_status           TEXT,
    ocr_language         TEXT,
    file_hash            TEXT,
    phash                TEXT,
    phash_source         TEXT,
    vault_id             TEXT,
    mime_type            TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    auto_tag_status      TEXT,
    auto_tag_confidence  TEXT,
    auto_tag_model       TEXT,
    duration_secs        REAL,
    import_source        TEXT,
    batch_id             TEXT
);

CREATE INDEX IF NOT EXISTS idx_ins_created  ON inspirations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ins_type     ON inspirations(type);
CREATE INDEX IF NOT EXISTS idx_ins_ocr      ON inspirations(ocr_status);
CREATE INDEX IF NOT EXISTS idx_ins_hash     ON inspirations(file_hash);
CREATE INDEX IF NOT EXISTS idx_ins_platform ON inspirations(source_platform);

-- ─── Full-text search over title + ocr_text (schema v30) ──────────
-- External-content FTS5 table mirroring inspirations. Kept in sync by the
-- triggers below and (re)populated in bulk via the 'rebuild' command in
-- run_additive_migrations. The search branch of list_inspirations queries it
-- as: rowid IN (SELECT rowid FROM inspirations_fts WHERE inspirations_fts MATCH ?)
-- replacing two leading-wildcard LIKE '%q%' full scans over title and ocr_text.
CREATE VIRTUAL TABLE IF NOT EXISTS inspirations_fts USING fts5(
    title, ocr_text,
    content='inspirations',
    content_rowid='rowid',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS inspirations_fts_ai AFTER INSERT ON inspirations BEGIN
    INSERT INTO inspirations_fts(rowid, title, ocr_text)
    VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.ocr_text,''));
END;

CREATE TRIGGER IF NOT EXISTS inspirations_fts_ad AFTER DELETE ON inspirations BEGIN
    INSERT INTO inspirations_fts(inspirations_fts, rowid, title, ocr_text)
    VALUES ('delete', old.rowid, COALESCE(old.title,''), COALESCE(old.ocr_text,''));
END;

-- Re-index only when the indexed text actually changed — avoids FTS churn on
-- the frequent view_count / last_viewed_at / palette updates.
CREATE TRIGGER IF NOT EXISTS inspirations_fts_au AFTER UPDATE ON inspirations
WHEN new.title IS NOT old.title OR new.ocr_text IS NOT old.ocr_text BEGIN
    INSERT INTO inspirations_fts(inspirations_fts, rowid, title, ocr_text)
    VALUES ('delete', old.rowid, COALESCE(old.title,''), COALESCE(old.ocr_text,''));
    INSERT INTO inspirations_fts(rowid, title, ocr_text)
    VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.ocr_text,''));
END;

CREATE TABLE IF NOT EXISTS collections (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    visible_on_home INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
    collection_id   TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    inspiration_id  TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
    position        INTEGER,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (collection_id, inspiration_id)
);

-- PK is (collection_id, inspiration_id); this covers reverse lookups by
-- inspiration_id used by the collection_names correlated subquery in
-- list_inspirations / get_inspiration (runs once per returned row).
CREATE INDEX IF NOT EXISTS idx_ci_inspiration ON collection_items(inspiration_id);

CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    source     TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inspiration_tags (
    inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
    tag_id         TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (inspiration_id, tag_id)
);

-- PK leads with inspiration_id; this covers the tag filter (tag_id IN (...))
-- in list_inspirations and the shared-tag lookup in list_because_you_viewed.
CREATE INDEX IF NOT EXISTS idx_it_tag ON inspiration_tags(tag_id);

CREATE TABLE IF NOT EXISTS tag_usage_counts (
    tag_id TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS milestones (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL,
    achieved_at       INTEGER NOT NULL,
    certificate_shown INTEGER NOT NULL DEFAULT 0,
    shared            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS duplicate_pairs (
    id               TEXT PRIMARY KEY,
    inspiration_id_a TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
    inspiration_id_b TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
    match_type       TEXT NOT NULL CHECK(match_type IN ('hash','phash','ocr_text')),
    similarity_score REAL NOT NULL,
    reviewed         INTEGER NOT NULL DEFAULT 0,
    dismissed        INTEGER NOT NULL DEFAULT 0,
    detected_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS license_cache (
    id                  INTEGER PRIMARY KEY CHECK(id = 1),
    license_key         TEXT,
    plan_type           TEXT,
    expires_at          INTEGER,
    last_validated_at   INTEGER,
    device_fingerprint  TEXT,
    revoked_at          INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    type       TEXT,
    title      TEXT,
    body       TEXT,
    data       TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
    read_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_outbox (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    data       TEXT,
    created_at INTEGER NOT NULL,
    sent       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tag_feedback (
    id              TEXT PRIMARY KEY,
    inspiration_id  TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,
    action          TEXT NOT NULL CHECK(action IN ('kept','deleted','edited')),
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_tag_weights (
    tag          TEXT PRIMARY KEY,
    weight       REAL NOT NULL DEFAULT 1.0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_vocab (
    id           TEXT PRIMARY KEY,
    labels_json  TEXT NOT NULL DEFAULT '{}',
    prompts_json TEXT NOT NULL DEFAULT '[]',
    built_in     INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS download_sessions (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL,
    quality       TEXT NOT NULL DEFAULT 'best',
    import_source TEXT NOT NULL DEFAULT 'app_download',
    status        TEXT NOT NULL,
    error_msg     TEXT,
    filename      TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ext_download_queue (
    id              TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    page_url        TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    source_platform TEXT NOT NULL DEFAULT '',
    queued_at       INTEGER NOT NULL
);
"#;
