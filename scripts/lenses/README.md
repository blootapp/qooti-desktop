# Tag lens tools (dev only)

Node 24 scripts for building, checking and measuring the Tag lens files (spec:
`E:/DP 2/qooti 2.0/MD/qooti-tag-lens-spec.md` §2, §5, §9). Run from the worktree root with Git Bash.
Private data (the library DB copy, frames, judge sheets, judgments) lives in the evaluation kit
`E:/DP 2/qooti-tag-eval/` (outside git, see its README) and never comes into this repo.

| Script | Does |
|---|---|
| `lens-score.mjs` | Pure scoring, spec §5 + §0c (per-media pools, picture rule, video rule incl. n == 1 and the failed-frames fallback, aspect gate, merge, filter, signature, display rule, picker), plus the video length rule (`videoStatus`) and the same-name rule (`suggestItem`). Mirrors `src-tauri/src/tagging.rs` (and the display/picker rules of `src/modules/lenses.js`). |
| `check.mjs` | Spec §2.3 + §0c rules for `lenses/src/*.json` and the built files (bundled, dist, index). Errors exit 1. The 77-token rule uses the real CLIP tokenizer. Also errors: a lens id other than motion, design, thumbnail; a version above 100000; a source changed without a higher version than its built file. |
| `build.mjs` | Embeds every prompt of the scored entries (`Xenova/clip-vit-base-patch32` text q8, "This is a photo of {p}"), writes `src-tauri/lenses/qooti-lens-<id>.json`, `lenses/dist/qooti-lens-<id>-<version>-<sha12>.json` and `lenses/dist/qooti-lenses.json`. Deterministic. Refuses a changed lens without a higher version (see below). |
| `embed-frames.mjs` | One frame per second of each video (8 to 32) exactly as `frames.rs` takes them, embedded with the app's vision q8 model (private output). A length missing from the DB is measured as the indexer does: the header, then reading every packet. Entries made with 8 frames (before 2026-11-20) of videos over 8 s are read again, as the app reads those rows again. |
| `measure.mjs` | Scores the library copy as the app would store it, reports per-entry fire rates, never-firing entries, near-duplicates inside each media pool and out-of-domain fires, writes blind judge sheets, and computes precision/coverage per bar from judgments. |
| `verify-vision.mjs` | Checks the vision model is the app's and how close Node's vectors are to the stored Rust vectors. |
| `publish.mjs` | Uploads the catalogue to R2. **Owner only**: refuses without `--yes-publish`. Stops on anything unclear (see below). |
| `native/clip-preprocess/` | The app's exact image decode + preprocessing as a tiny Rust CLI (built offline into the eval kit), so Node embeds the same tensor the Rust indexer would. |

```bash
node scripts/lenses/check.mjs --lens motion          # own problems are errors, other lenses' are warnings
node scripts/lenses/build.mjs --lens motion          # build one lens (nothing written on errors)
node scripts/lenses/build.mjs                        # build all three (strict)
node scripts/lenses/measure.mjs --lens motion --out "E:/DP 2/qooti-tag-eval/runs/motion" [--judgments "E:/DP 2/qooti-tag-eval/judgments"]
node scripts/lenses/embed-frames.mjs                 # incremental (8-frame entries of videos over 8 s and the 30–60 s videos are read)
node --test "scripts/lenses/test/*.test.mjs"         # scorer invariants, shared-tag vectors, one fixture per check rule, build guard, publish stops, measure loading + reports, length measuring
node scripts/lenses/test/fixtures/make-fixtures.mjs  # regenerate the fixtures (and shared-tag-vectors.json) after a rule change
```

Every script takes `--help`. Model files are pinned (revision + sha256) in `lib/models.mjs` and cached in
`E:/DP 2/qooti-tag-eval/hf-cache` (`--cache <dir>` to change).

Node is a little stricter than the Rust installer on purpose (`bar` and `media` are required, prompt
duplicates ignore case and spacing, aspect needs min < max), so anything that passes here installs.
Choices the spec leaves open, made the same way as `src-tauri/src/tagging.rs` (keep in sync): the
aspect gate applies to videos too, and a missing aspect ratio counts as 1.0; ties go to the earlier
concept (base first, then file order), and the first of equal maxima wins a frame.

Videos longer than 60 s (+0.5 s of slack; spec §0.11, `MAX_TAG_VIDEO_SECS` in tagging.rs and
lens-score.mjs; 30 s until 2026-11-20) are never tagged: `measure.mjs` leaves them out of the
population and `embed-frames.mjs` reads no frames of them (`--max-video-secs`, default 60; `Infinity`
keeps every video). The limit is part of the signature (`…|maxvid=60|…`), as in Rust.

Rules shared with the app (keep in sync with tagging.rs):

- **Video rule (R45, the owner's decision of 2026-11-20; measured in
  `E:/DP 2/qooti-tag-eval/runs/videos-adaptive-2026-11-20/report.md`).** One frame per second of the clip,
  rounded up, at least 8 and at most 32 (`embed-frames.mjs frameCount` = frames.rs `frame_count`), at
  the middle of n equal slices without the first and last 4 %. In each pool an own entry needs to top at
  least ceil(0.45 · n) frames (`lens-score.mjs framesNeeded` = tagging.rs `frames_needed`: 8 → 4,
  15 → 7, 21 → 10, 32 → 15) with a mean p over those frames ≥ the video bar; at most 2. Until then: 8
  frames and ceil(n / 2).
- **Frame schedules.** The app tags each `clip_frames` row with how its frames were taken:
  `clip-b32-q8@fps1` (one per second) or `clip-b32-q8` (8 frames, rows written before 2026-11-20). Both
  are scored; an 8-frame row of a video over 8 s is read again once (up to 8 s both schedules take the
  same frames). `measure.mjs --frames db` reads both. `embed-frames.mjs` marks its entries
  `schedule: "fps1"` and reads entries without it again under the same rule (`needsReading`); an `fps1`
  entry whose frames partly failed is never read again, and an entry whose frames all failed (n = 0) only
  with `--force`.
- **Video length.** A video is scored only when its length is known (a number above 0) and at most
  60.5 s. With no frames read yet it is waiting. When the length can't be measured at all (frames
  stored with n = 0), it is never scored, not even from its cover, and `measure.mjs` leaves it out.
- **Same name.** A concept is never suggested to an item that already has a people's tag (source
  `user` or `import`) with the same name as its English or Uzbek label. Names are compared trimmed,
  lower-cased, with ‘ ’ ʻ ʼ ` read as '. Dropped concepts leave a gap (nothing moves up).
  `measure.mjs` reads people's tags from the DB copy.
- **Signature** `lens-score-4|clip-b32-q8|maxvid=60|<id>@<sha256>,…` (version 2 since the length and
  same-name rules, version 3 since the shared-tag model below, version 4 since the video rule of
  2026-11-20).

### Shared tags (spec §0c, scorer version 3)

One tag (one concept id, one name) may have an **entry** in several lenses, each describing it for its
own media: design and thumbnail for pictures, motion for videos. The port notes
(`E:/DP 2/qooti-tag-eval/mirror-motion-v2/PORT-NOTES.md`) have the exact semantics and test vectors for
the app. Lens content and the per-lens tag tables: `lenses/README.md`.

- **Entries of one id** carry identical `label`s; a `group` (the owner's heading, `{en, uz}`, optional,
  text rules, max 24 characters, carried through and unused for now) must be the same wherever an entry
  gives one. A lens lists an id at most once.
- **Disjoint media:** in the whole catalogue at most one *scored* entry of an id covers pictures
  (`picture`/`any`) and at most one covers videos (`video`/`any`).
- **Add-by-hand entry:** `"suggest": false`, no `prompts`, `vec`, `media` or `aspect`. Never scored, in
  no pool; it puts the tag in the picker. `build.mjs` embeds nothing for it.
- **Limits per lens:** at most 80 scored entries and 120 entries in all (warning when none is scored).
- **Labels:** unique per language across tags (entries of one id share theirs), compared trimmed,
  lower-cased and with ‘ ’ ʻ ʼ \` read as '; an English label may not be another tag's Uzbek label.
  No label, group, lens name or summary holds `_` (`text.underscore`; the app shows them as they
  are, and "web_design" reads as an id). Prompts stay unique across the whole catalogue, also
  between entries of one tag.
- **Borrows** still name design's ids. A specialist may also own an entry for a borrowed tag only when
  the two entries' media don't overlap (motion owns `typography` for videos, borrows it for pictures).
- **Pools** per item media (a video's one-frame and cover fallbacks use the video pools): design's
  scored entries covering it, plus each specialist's own. An empty pool suggests nothing.
- **Display:** a key shows on an item of media m when an enabled lens has a scored entry for it
  covering m, or is a specialist that borrows it and design's entry covers m. A key ranks with the
  first such lens (motion, thumbnail, design), then `col:` hints; by score, then by key.
- **Picker:** every tag an enabled lens has an entry for (scored or add-by-hand) or borrows.
- **Check codes:** `shared.label`, `shared.group`, `shared.media_overlap`, `borrows.overlap`,
  `dup.label_cross`, `concept.hand_field`, `concept.suggest`, `lens.scored_count` (errors);
  `borrows.hand`, `lens.no_scored` (warnings). `dup.concept_id` now means "twice in one lens".
- **measure.mjs** reports one row per entry (`entries`, `per_entry`; a shared tag has a row per lens),
  `add_by_hand`, never-firing entries as `lens/id`, near-duplicates per media pool (`media`, `pool`,
  `anchor`), and role views with the new display rule (`first_is_own` / `first_is_borrowed`).
  Judge sheets and judgments stay keyed by item + concept id.
- **Fixtures:** the valid fixtures hold a shared tag (`d_type`), shared and single add-by-hand tags and
  groups; `test/fixtures/shared-tag-vectors.json` holds hand-written inputs and expected outputs for
  the scorer, the display rule, the picker and the signature.
- **Versions.** The app installs a lens file only when its version is higher than the installed
  one. So `build.mjs` refuses to write a lens whose file would change at the same (or a lower)
  version ("content changed: bump the version") and writes nothing; `check.mjs` reports it as an
  error. Exceptions: the bundled file is a placeholder, or `--allow-same-version` (only for a
  version no one has installed yet). Versions go up to 100000.
- **Publishing.** `publish.mjs` stops before uploading anything when: a lens id isn't motion,
  design or thumbnail; a bundled file has no source or is older than its source; R2 can't be read
  and the public URL doesn't answer a clean 404 (only that means "not published yet"); or the live
  index can't be backed up. The backup is always written and read back before the first upload.
