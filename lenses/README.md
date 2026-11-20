# Tag lens files

A **lens** is one downloadable tag list. qooti has three, one per role, and suggests tags from the
lenses that are on. Claude drafted the lists on 2026-11-18. On 2026-11-19 your 87-tag motion list
replaced the drafted one, design started reading pictures only, and one tag may now be in several
lenses (owner decisions 12–16). Your answers that evening removed Launch, Retention and Whiteboard
(84 motion tags now), made motion's Infographics add by hand, renamed seven tags and gave design the
add-by-hand tags Logo and Brand. On 2026-11-20 your 22 YouTube categories replaced the thumbnail list
(version 2: 21 scored and POV add by hand, the 16:9 gate on Horror, Podcast, Tutorial and YouTube
niche), and motion's Sports became videos only, because thumbnail now describes Sports for pictures.
Later that day you chose the new video rule (R45: one frame per second, a tag needs 45 % of the
frames, videos up to 60 s), and with it motion version 3: Visualizer is add by hand and Meme is for
pictures only, because on videos those two were the wrong answers.
The lists are yours to edit. The full design is in
`E:/DP 2/qooti 2.0/MD/qooti-tag-lens-spec.md` (§0c shared tags, §2 files, §5 scoring, §10 content
rules).

## What's where

| Path | What it is | Edit it? |
|---|---|---|
| `lenses/src/motion.json`, `design.json`, `thumbnail.json` | The sources: name, summary, bars, borrows and the entries (labels, groups, prompts, media, aspect, notes). | **Yes.** These are the only lens files you edit. |
| `src-tauri/lenses/qooti-lens-<id>.json` | Built copies that the app bundles (`include_str!` in `lenses.rs`): the source plus one vector per scored entry. | No. Run `build.mjs`. |
| `lenses/dist/qooti-lens-<id>-<version>-<sha12>.json` | Publish copies, byte-identical to the bundled ones. | No. |
| `lenses/dist/qooti-lenses.json` | The catalogue index. The app reads it from `https://api.bloot.app/download/qooti-lenses.json`, which doesn't exist yet. | No. |
| `scripts/lenses/` | The tools: check, build, measure, publish. See `scripts/lenses/README.md`. | Only to change the tools. |
| `E:/DP 2/qooti-tag-eval/` | The private evaluation kit, outside git: the library DB copy, video frames, judge sheets, judgments and measurement runs. | Never commit or upload it. |

## The three lenses

Lists (onboarding, Settings) always use this order.

| # | id | Role | Version | Name (EN · UZ) | Summary (EN · UZ) | Entries | Borrows | Bar picture / video |
|---|---|---|---|---|---|---|---|---|
| 1 | `motion` | specialist | 3 | Video editor / Motion designer · Videomontajchi / Motion dizayner | Ads, UI, 3D, music videos, film, social, tutorials · Reklama, UI, 3D, kliplar, kino, ijtimoiy tarmoqlar, darslar | 84: 48 scored + 36 add by hand | 11 | 0.30 / 0.15 |
| 2 | `design` | **base** | 3 | Graphic designer / Social media post designer · Grafik dizayner / SMD dizayneri | Posters, SMD, UI, 3D, illustration · Posterlar, SMD, UI, 3D, illyustratsiya | 25: 23 scored + 2 add by hand | – | 0.30 / 0.20 (the video bar is unused: pictures only) |
| 3 | `thumbnail` | specialist | 2 | YouTube thumbnail designer · YouTube muqova dizayneri | Gaming, tech, finance, cooking, horror · O‘yinlar, texnologiya, moliya, pazandachilik, qo‘rqinchli | 22: 21 scored + 1 add by hand | 8 | 0.30 / 0.20 (the video bar is unused: pictures only) |

## Tags and entries

- A **tag** is one id with one name per language (its `label`). People see the name on cards, in the
  tag picker and in search, in the app's language. An accepted tag is stored once per item, by id,
  whichever lens suggested it.
- An **entry** is one lens's line for a tag. The same tag may have an entry in several lenses, and each
  entry describes the tag for its own media: design and thumbnail for pictures, motion for videos. For
  example, UI (`ui_design`) has a design entry whose prompts describe app screens (pictures) and a motion
  entry whose prompts describe UI animations (videos). It stays one tag with one name. 18 tags are
  shared today: motion and design share Fashion, Food, Architecture, UI, Typography, 3D, Collage,
  Infographics, Cinematic, Nature, Retro, Logo and Brand; motion and thumbnail share Tutorial, Podcast,
  Gaming, Sports and Documentary. Motion has Infographics, Logo and Brand as add-by-hand entries, and
  design has Logo and Brand that way too: Infographics is suggested on pictures only (design's entry),
  and Logo and Brand are only ever added by hand.
- A **scored** entry (the default) has `media`, `prompts` and an optional `aspect`. It is scored for the
  items its media covers: `picture` (images and GIFs), `video`, or `any` (both).
- An **add-by-hand** entry (`"suggest": false`) has only `id`, `label`, an optional `group` and
  `about`. It is never suggested: the tag is in the tag picker and in search, so people can add it
  themselves. Use it for ideas a still frame can't show (timing, sound, purpose), or for tags that
  measured badly. Each one's `about` says why it is added by hand.
- A **group** (optional, `{en, uz}`) is your heading, like "Techniques" / "Usullar". It isn't a tag and
  needn't be unique. The app keeps it but doesn't show it yet (later: headings in the tag picker).
- **Rules for a tag with several entries.** The checker refuses a set that breaks one, and so does the
  app, which then installs nothing:
  - every entry has exactly the same labels (same case, spaces and apostrophes) and, where it gives
    one, the same group;
  - in all lenses together, at most one scored entry covers pictures (`picture` or `any`) and at most
    one covers videos (`video` or `any`);
  - a lens lists a tag at most once;
  - prompts are unique everywhere, also between the entries of one tag.
- **Limits per lens:** at most 80 scored entries and 120 entries in all (add-by-hand entries count only
  toward the 120), and 256 KB per built file. A lens with no scored entry is allowed with a warning: it
  never suggests anything.

### How a suggestion is made

- **Every installed lens is scored**, whether it is on or off. Turning a lens on or off only changes
  what is shown.
- **Pools, per media.** An item is a picture (images and GIFs) or a video (also when only one frame or
  only its cover can be read). Design's pool holds design's scored entries for that media. A
  specialist's pool holds the same design entries plus its own; there the design entries act as "it's
  something else", and the specialist only suggests its own. Design reads pictures only, so it suggests
  nothing on videos, and on videos a specialist's pool holds only its own entries. Adding or changing a
  specialist never changes design's suggestions (checked: 498 of 498 items identical, with every
  combination of specialists).
- **Pictures** get a tag when its probability in its pool is at least the lens's picture bar: at most 3
  per lens.
- **Videos** get one frame per second of the clip, at least 8 and at most 32, spread evenly without the
  first and last 4 %. A tag must win at least 45 % of those frames (4 of 8, 7 of 15, 10 of 21, 15 of
  32), with a mean probability over the frames it won of at least the video bar: at most 2. Videos
  longer than 60 s are never tagged, and neither are videos whose length can't be read. (Your decision
  of 2026-11-20, "R45"; until then 8 frames, half of them, and videos up to 30 s. Measured in
  `E:/DP 2/qooti-tag-eval/runs/videos-adaptive-2026-11-20/report.md`.) Videos read with 8 frames before
  are read again once, in the background.
- **Same name.** A tag is never suggested to an item that already has a tag people made with the same
  name as its English or Uzbek label (for example their own "poster" tag and the Poster tag). Case,
  spaces at the ends and the apostrophe style (‘ ’ ') don't matter.
- **`aspect`** drops a suggestion when the item's width/height ratio is outside the range.
- **`borrows`**: while a specialist is on, it also shows those design tags, without turning design on,
  wherever design's entry covers the item (today: on pictures). A specialist may also have its own entry
  for a tag it borrows, but only for the other media: motion borrows design's Typography for pictures
  and has its own Typography entry for videos.
- **On a card**: at most 3 suggestions on pictures and 2 on videos, one question at a time. They are
  ordered by the first lens that is on and shows the tag (motion, then thumbnail, then design; a
  borrowed tag ranks with the specialist that shows it), then collection hints, then by score.
- **Tag picker** (detail panel): every tag that a lens that is on has an entry for (scored or add by
  hand) or borrows, plus the tags people made. A shared tag is one row.
- **Scorer version** `lens-score-4` (since the video rule of 2026-11-20): a library scored by an older
  version is re-scored once from its stored vectors.

## Tags

"How" says what the entry is scored for: pictures, videos or both. "Shared" names the lens that
describes the same tag for the other media; "also in" names a lens that has the tag as add by hand.
"Test library" is the entry's own suggestions on the test library at the lens's bars (2026-11-19, see
the results below): how many, then judged right / partly / wrong, and how many nobody has judged yet.
A dash means the entry never reached its bar there (untested, mostly because that library has little
of that kind). Add-by-hand entries are never suggested.

### motion (version 3; 84 entries: 48 scored, 36 add by hand)

Borrows from design (shown on pictures): fashion, food, architecture, ui_design, typography, render_3d,
collage, infographic, dark_cinematic, nature, retro. The tags and groups follow your list
(`E:/DP 2/qooti-tag-eval/owner-lists/motion-2026-11-19.txt`), in its order, with your answers of
2026-11-19 applied; "–" means no heading.

| Group (EN · UZ) | id | EN | UZ | How | Test library |
|---|---|---|---|---|---|
| Commercial · Reklama | `commercial` | Commercial | Reklama roligi | videos | – |
| Commercial · Reklama | `brand` | Brand | Brend | add by hand (also in design) |  |
| Commercial · Reklama | `logo` | Logo | Logotip | add by hand (also in design) |  |
| Commercial · Reklama | `ads` | Ads | Reklama | add by hand |  |
| Commercial · Reklama | `packshot` | Packshot | Pekshot | videos | – |
| Commercial · Reklama | `fashion` | Fashion | Moda | videos (shared: design for pictures) | – |
| Commercial · Reklama | `beauty` | Beauty | Kosmetika | pictures and videos | – |
| Commercial · Reklama | `food` | Food | Taom | videos (shared: design for pictures) | – |
| Commercial · Reklama | `architecture` | Architecture | Arxitektura | videos (shared: design for pictures) | 1: 0 / 1 / 0 |
| Commercial · Reklama | `aftermovie` | Aftermovie | Tadbir videosi | videos | – |
| Commercial · Reklama | `corporate` | Corporate | Korporativ video | videos | – |
| UI · UI | `ui_design` | UI | UI | videos (shared: design for pictures) | 32: 25 / 7 / 0 |
| UI · UI | `saas` | SaaS | SaaS | add by hand |  |
| UI · UI | `explainer` | Explainer | Ekspleyner | videos | 1: 1 / 0 / 0 |
| UI · UI | `keynote` | Keynote | Prezentatsiya | videos | – |
| UI · UI | `dashboard` | Dashboard | Dashbord | videos | 1: 0 / 0 / 1 |
| UI · UI | `onboarding` | Onboarding | Onbording | add by hand |  |
| Motion · Motion | `character` | Character | Personaj | pictures and videos | 1: 1 / 0 / 0 |
| Motion · Motion | `abstract` | Abstract | Abstrakt | pictures and videos | 2: 0 / 1 / 1 |
| Motion · Motion | `isometric` | Isometric | Izometrik | add by hand |  |
| Motion · Motion | `liquid` | Liquid | Suyuqlik | pictures and videos | – |
| Motion · Motion | `glitch` | Glitch | Glitch | add by hand |  |
| Motion · Motion | `particles` | Particles | Zarrachalar | pictures and videos | – |
| Motion · Motion | `loops` | Loops | Looplar | add by hand |  |
| Motion · Motion | `generative` | Generative | Generativ | add by hand |  |
| Motion · Motion | `overlays` | Overlays | Overleylar | videos | – |
| – | `typography` | Typography | Tipografika | videos (shared: design for pictures) | 2: 1 / 1 / 0 |
| – | `render_3d` | 3D | 3D | videos (shared: design for pictures) | 1: 1 / 0 / 0 |
| – | `collage` | Collage | Kollaj | videos (shared: design for pictures) | 3: 3 / 0 / 0 |
| – | `infographic` | Infographics | Infografika | add by hand (shared: design for pictures) |  |
| – | `stopmotion` | Stopmotion | Stop-motion | videos | – |
| – | `map` | Map | Xarita | pictures and videos | 4: 4 / 0 / 0 |
| – | `titles` | Titles | Titrlar | add by hand |  |
| Music · Musiqa | `lyrics` | Lyrics | Qo‘shiq matni | add by hand |  |
| Music · Musiqa | `music_video` | Musicvideo | Klip | videos | – |
| Music · Musiqa | `visualizer` | Visualizer | Audio spektr | add by hand (2026-11-20: wrong on videos) |  |
| Music · Musiqa | `teaser` | Teaser | Tizer | add by hand |  |
| Music · Musiqa | `concert` | Concert | Konsert | pictures and videos | – |
| Music · Musiqa | `canvas` | Canvas | Spotify Canvas | add by hand |  |
| Cinematic · Kinematografik | `dark_cinematic` | Cinematic | Kinematografik | videos (shared: design for pictures) | 1: 1 / 0 / 0 |
| Cinematic · Kinematografik | `short_film` | Shortfilm | Qisqa film | add by hand |  |
| Cinematic · Kinematografik | `fan_edit` | Fanedit | Edit | add by hand |  |
| Cinematic · Kinematografik | `grading` | Grading | Rang tuzatish | videos | – |
| Cinematic · Kinematografik | `one_shot` | Oneshot | Bir dubl | add by hand |  |
| Cinematic · Kinematografik | `drone` | Drone | Dron | pictures and videos | – |
| Cinematic · Kinematografik | `travel` | Travel | Sayohat | pictures and videos | – |
| Cinematic · Kinematografik | `nature` | Nature | Tabiat | videos (shared: design for pictures) | – |
| Cinematic · Kinematografik | `documentary` | Documentary | Hujjatli film | videos (shared: thumbnail for pictures) | – |
| Cinematic · Kinematografik | `wedding` | Wedding | To‘y | pictures and videos | 1: 1 / 0 / 0 |
| Cinematic · Kinematografik | `sports` | Sports | Sport | videos (shared: thumbnail for pictures) | – |
| – | `trailer` | Trailer | Treyler | add by hand |  |
| Social · Ijtimoiy tarmoqlar | `intro` | Intro | Intro | add by hand |  |
| Social · Ijtimoiy tarmoqlar | `essay` | Essay | Video esse | add by hand |  |
| Social · Ijtimoiy tarmoqlar | `talking_head` | Talkinghead | Kameraga nutq | videos | – |
| Social · Ijtimoiy tarmoqlar | `podcast` | Podcast | Podkast | videos (shared: thumbnail for pictures) | – |
| Social · Ijtimoiy tarmoqlar | `reels` | Reels | Reels | add by hand |  |
| Social · Ijtimoiy tarmoqlar | `vibe` | Vibe | Vayb | add by hand |  |
| Social · Ijtimoiy tarmoqlar | `velocity` | Velocity | Velocity | add by hand |  |
| Social · Ijtimoiy tarmoqlar | `vlog` | Vlog | Vlog | videos | – |
| – | `meme` | Meme | Mem | pictures (2026-11-20: wrong on videos) | – |
| Education · Ta’lim | `tutorial` | Tutorial | Video dars | videos (shared: thumbnail for pictures) | – |
| Education · Ta’lim | `screencast` | Screencast | Screencast | videos | 2: 0 / 2 / 0 |
| Education · Ta’lim | `course` | Course | Kurs | add by hand |  |
| Education · Ta’lim | `science` | Science | Ilm-fan | pictures and videos | – |
| Techniques · Usullar | `transitions` | Transitions | O‘tishlar | add by hand |  |
| Techniques · Usullar | `ramps` | Speed ramp | Speed ramp | add by hand |  |
| Techniques · Usullar | `sound` | Sound | Tovush | add by hand |  |
| Techniques · Usullar | `rhythm` | Rhythm | Ritm | add by hand |  |
| Techniques · Usullar | `text` | Text | Matn | videos | 4: 2 / 2 / 0 |
| Techniques · Usullar | `impact` | Impact | Zarba | add by hand |  |
| Techniques · Usullar | `split_screen` | Splitscreen | Split-ekran | videos | – |
| Techniques · Usullar | `rotoscoping` | Rotoscoping | Rotoskoping | add by hand |  |
| Techniques · Usullar | `vfx` | VFX | VFX | videos | – |
| Techniques · Usullar | `chromakey` | Chromakey | Xromakey | pictures and videos | – |
| Techniques · Usullar | `reveal` | Reveal | Paydo bo‘lish | add by hand |  |
| Niche · Nisha | `retro` | Retro | Retro | videos (shared: design for pictures) | – |
| Niche · Nisha | `y2k` | Y2K | Y2K | pictures and videos | – |
| Niche · Nisha | `ar` | AR | AR | videos | – |
| Niche · Nisha | `projection` | Projection | Proyeksiya | add by hand |  |
| Niche · Nisha | `interactive` | Interactive | Interaktiv | add by hand |  |
| – | `anime` | Anime | Anime | pictures and videos | – |
| – | `brutalist` | Brutalist | Brutalizm | add by hand |  |
| – | `gaming` | Gaming | O‘yinlar | videos (shared: thumbnail for pictures) | 1: 1 / 0 / 0 |
| – | `ai` | AI | AI | add by hand |  |

### design (version 3, the base lens; 25 entries: 23 scored, 2 add by hand)

Every scored entry is `picture` (decision 12). 10 of them are shared with motion, which describes those
tags for videos. Infographics is in motion too, but only as add by hand, so it is never suggested on
videos. Logo and Brand are add by hand, here and in motion. SMD only shows on pictures from 9:16 up to
a little wider than square.

| id | EN | UZ | How | Aspect | Test library |
|---|---|---|---|---|---|
| `poster` | Poster | Poster | pictures |  | 30: 28 / 2 / 0 |
| `typography` | Typography | Tipografika | pictures (shared: motion for videos) |  | 11: 8 / 3 / 0 |
| `social_post` | SMD | SMD | pictures | 0.5–1.3 | 9: 7 / 1 / 1 |
| `infographic` | Infographics | Infografika | pictures (also in motion, add by hand) |  | 18: 12 / 5 / 1 |
| `packaging` | Packaging | Qadoq dizayni | pictures |  | 8: 5 / 3 / 0 |
| `ui_design` | UI | UI | pictures (shared: motion for videos) |  | 92: 71 / 17 / 4 |
| `web_design` | Website | Veb-sayt | pictures |  | 24: 14 / 1 / 9 |
| `icons` | Icons | Ikonkalar | pictures |  | 33: 20 / 6 / 7 |
| `illustration` | Illustration | Illyustratsiya | pictures |  | 8: 5 / 3 / 0 |
| `collage` | Collage | Kollaj | pictures (shared: motion for videos) |  | 9: 7 / 1 / 1 |
| `render_3d` | 3D | 3D | pictures (shared: motion for videos) |  | 6: 5 / 1 / 0 |
| `minimal` | Minimal | Minimal | pictures |  | 2: 2 / 0 / 0 |
| `retro` | Retro | Retro | pictures (shared: motion for videos) |  | 1: 0 / 1 / 0 |
| `dark_cinematic` | Cinematic | Kinematografik | pictures (shared: motion for videos) |  | – |
| `portrait` | Portrait | Portret | pictures |  | – |
| `fashion` | Fashion | Moda | pictures (shared: motion for videos) |  | – |
| `product_photo` | Product shot | Tovar surati | pictures |  | – |
| `food` | Food | Taom | pictures (shared: motion for videos) |  | – |
| `nature` | Nature | Tabiat | pictures (shared: motion for videos) |  | – |
| `architecture` | Architecture | Arxitektura | pictures (shared: motion for videos) |  | – |
| `interior` | Interior | Interyer | pictures |  | – |
| `space` | Space | Kosmos | pictures |  | 2: 2 / 0 / 0 |
| `holiday` | Holiday | Bayram | pictures |  | 1: 1 / 0 / 0 |
| `logo` | Logo | Logotip | add by hand (also in motion) |  |  |
| `brand` | Brand | Brend | add by hand (also in motion) |  |  |

### thumbnail (version 2; 22 entries: 21 scored, 1 add by hand)

Borrows from design: portrait, dark_cinematic, collage, render_3d, illustration, food, nature, space.
Your 22 YouTube categories (2026-11-20), in your order: every scored entry is `picture`, of any shape
except Horror, Podcast, Tutorial and YouTube niche, which have the 16:9 gate `aspect: [1.6, 1.95]`.
POV is add by hand (CLIP can't read its first-person framing or its "POV" text). Tutorial, Podcast,
Gaming, Sports and Documentary are shared with motion, which describes them for videos. Version 1's
Reaction face, Before & after, Versus, Arrows, Top list, True crime, Stock chart, Money and History
are gone: a library that has one of them as a tag keeps it, with its name, and it is never suggested
again. Gaming, Tutorial, Podcast and Technology keep their version 1 prompts, History's moved to
Documentary, and Finance took two each from Money and Stock chart. The test-library figures below
use the blind verdicts of 2026-11-20 (`E:/DP 2/qooti-tag-eval/runs/thumbnail-v2-2026-11-20/`).

| id | EN | UZ | How | 16:9 gate | Test library |
|---|---|---|---|---|---|
| `manipulation` | Manipulation | Manipulyatsiya | pictures | no | – |
| `business` | Business | Biznes | pictures | no | – |
| `cooking` | Cooking | Pazandachilik | pictures | no | – |
| `design_diy` | Design & DIY | Dizayn va DIY | pictures | no | – |
| `education` | Education | Ta’lim | pictures | no | – |
| `entertainment` | Entertainment | Ko‘ngilochar | pictures | no | – |
| `finance` | Finance | Moliya | pictures | no | 4: 4 / 0 / 0 |
| `fitness` | Fitness | Fitnes | pictures | no | – |
| `gaming` | Gaming | O‘yinlar | pictures (shared: motion for videos) | no | 1: 1 / 0 / 0 |
| `horror` | Horror | Qo‘rqinchli | pictures | yes | – |
| `music` | Music | Musiqa | pictures | no | – |
| `pov` | POV | POV | add by hand |  |  |
| `podcast` | Podcast | Podkast | pictures (shared: motion for videos) | yes | 1: 0 / 1 / 0 |
| `politics` | Politics | Siyosat | pictures | no | – |
| `pop_science` | Pop science | Ilmiy-ommabop | pictures | no | – |
| `self_growth` | Self-growth | Shaxsiy rivoj | pictures | no | – |
| `sports` | Sports | Sport | pictures (shared: motion for videos) | no | – |
| `documentary` | Documentary | Hujjatli film | pictures (shared: motion for videos) | no | 1: 1 / 0 / 0 |
| `tech` | Technology | Texnologiya | pictures | no | 1: 1 / 0 / 0 |
| `travel_vlog` | Travel & Vlog | Sayohat va vlog | pictures | no | 1: 1 / 0 / 0 |
| `tutorial` | Tutorial | Video dars | pictures (shared: motion for videos) | yes | 3: 3 / 0 / 0 |
| `youtube_niche` | YouTube niche | YouTube nishasi | pictures | yes | – |

## Results on the test library (2026-11-19, thumbnail 2026-11-20)

**Videos with the rule of 2026-11-20 (R45, motion version 3):** on the library copy of 2026-11-20 (110
videos up to 60 s, frames read one per second exactly as the app reads them), motion's card has a
suggestion on 51 of 110 videos, 80.4 % right and 96.1 % right or partly (41 / 8 / 2): up to 30 s 42 of
81 at 81.0 % / 95.2 %, 30–60 s 9 of 29 at 77.8 % / 100 %. The 8-frame rule it replaced: 47 of 81 at
72.3 % / 95.7 %. The rest of this section is the 2026-11-19 measurement, with 8 frames and videos up
to 30 s. (`E:/DP 2/qooti-tag-eval/runs/videos-adaptive-2026-11-20/report.md`.)

The test library is a read-only copy of the owner's library: 498 items the app would tag (420 pictures
and 78 videos up to 30 s; longer videos are left out, as in the app), with real picture shapes.
Pictures use the app's own stored vectors. Videos use 8 frames per video, embedded in Node the same way
the app will; that path is not yet checked against the Rust indexer. The lists were first measured in
the private mirror (`E:/DP 2/qooti-tag-eval/runs/motion-v2/`: `summary.md`, and the reports in
`final/`), then again after your answers (`E:/DP 2/qooti-tag-eval/runs/answers-2026-11-19b/`, where
design has the same content under version 2), and with the thumbnail list of 2026-11-20
(`E:/DP 2/qooti-tag-eval/runs/thumbnail-v2-2026-11-20/final/`). The answers change only what motion
does on videos; the thumbnail list changes only what thumbnail shows (design and motion give the same
suggestions as before). Every shown suggestion is judged now: the last two of motion's (one UI, right;
one Dashboard, wrong) were judged on 2026-11-20.

"Shown" is what a user of that role sees: only that role's lens on, own and borrowed tags. "Right"
counts only "yes"; "right or partly" adds "partly".

| Role (its lens alone on) | Shown | Right | Right or partly | Items with a suggestion | First question: own / borrowed |
|---|---|---|---|---|---|
| motion | 194 | 74.2 % | 95.9 % | 190 of 498 (38.2 %) | 57 / 133 |
| design | 254 | 73.6 % | 90.9 % | 242 of 498 (48.6 %), pictures only | 242 / 0 |
| thumbnail | 37 | 81.1 % | 97.3 % | 36 of 498 (7.2 %), pictures only | 12 / 24 |

- **Motion on videos:** 53 suggestions on 53 of the 78 videos (67.9 %), 71.7 % right (53 judged). In
  version 1 most video suggestions were borrowed design tags; now motion's own entries cover videos.
- **Thumbnail's own tags:** 12 suggestions, 91.7 % right, 100 % right or partly (version 1: 18, 94.4 %
  right). Only 7 of its 21 scored tags reach the bar on this library (Finance 4, Tutorial 3, Gaming,
  Podcast, Documentary, Technology and Travel & Vlog 1 each), so one verdict moves a tag between 0 %
  and 100 %. Its borrowed design tags show 25 more (19 right, 5 partly, 1 wrong).
- **All three lenses on:** 323 suggestions shown, 74.0 % right, 92.3 % right or partly (323 judged).
  The first question on a card comes from motion's own tags on 57 items, from design tags that motion
  borrows on 133, from design on 97 and from thumbnail on 21 (11 own, 10 borrowed); 190 items have
  none. Those first questions are 75.6 % right and 92.9 % right or partly (308 judged).

**Quality bar (spec §10):**

| Rule | Result |
|---|---|
| Right (strict precision) of shown suggestions ≥ 60 %, on ≥ 60 judged per lens | motion 74.2 % (194 judged), design 73.6 % (254); thumbnail 81.1 %, but this library only produces 37 shown suggestions (12 of its own) |
| No tag fires on more than 25 % of items | motion's UI entry fires on 32 of the 78 videos (41.0 %), because almost half of that library's videos are UI animations (25 right, 7 partly, none wrong); every other entry stays at or under 21.9 % (design's UI, on pictures); thumbnail's busiest tag is Finance, on 4 of 420 pictures |
| Specialist tags fire on ≤ 5 % of clearly out-of-domain items | motion 0 of 20 (0 %); thumbnail 0 of 167 (0 %) |
| No near-twins (Pearson r ≥ 0.75 of per-item probabilities) | none inside any pool; highest across lenses 0.754 (motion's Travel / thumbnail's Travel & Vlog, on pictures), which never share a pool, so neither weakens the other |
| The design lens is unchanged when specialists are installed | 498 of 498 items identical, with every combination of specialists |

**Choosing a bar.** A lower bar shows more suggestions and more wrong ones. These curves are for each
lens's own entries (right, and the share of pictures or videos with a suggestion):

| Lens | Bar | Right | Coverage |
|---|---|---|---|
| design, pictures | 0.25 · **0.30** · 0.35 | 65.4 % · **73.6 %** · 79.0 % | 68.8 % · **57.6 %** · 49.3 % |
| motion, videos | **0.15** · 0.20 · 0.30 | **71.7 %** · 72.1 % · 82.1 % | **67.9 %** · 55.1 % · 35.9 % |
| thumbnail, pictures | 0.20 · 0.25 · **0.30** | 82.6 % · 93.3 % · **91.7 %** | 5.5 % · 3.6 % · **2.9 %** |

Motion's video bar stays at 0.15: at 0.20, 72.1 % would be right, but only 55 % of videos would get a
suggestion instead of 68 %. Thumbnail's curve rests on 12 to 23 suggestions, too few to move its bar.

## How to edit an entry

A scored entry:

```json
{ "id": "map",
  "label":   { "en": "Map", "uz": "Xarita" },
  "media":   "any",
  "prompts": ["a road map", "a street map", "a map with a route"],
  "about":   { "en": "Note for you; never used for scoring." } }
```

An add-by-hand entry with a group:

```json
{ "id": "transitions", "label": { "en": "Transitions", "uz": "O‘tishlar" },
  "group": { "en": "Techniques", "uz": "Usullar" }, "suggest": false,
  "about": { "en": "Add by hand: a transition happens between frames." } }
```

A shared tag: one entry in each lens, with the same labels and media that don't overlap. In
`design.json`, for pictures:

```json
{ "id": "typography", "label": { "en": "Typography", "uz": "Tipografika" }, "media": "picture",
  "prompts": ["a font specimen", "a typeface showcase", "expressive lettering"] }
```

and in `motion.json`, for videos:

```json
{ "id": "typography", "label": { "en": "Typography", "uz": "Tipografika" }, "media": "video",
  "prompts": ["kinetic typography", "expressive animated lettering", "hand lettering animation"] }
```

- **`id`**: lowercase letters, digits and `_` (2–40 characters). One id is one tag. Don't rename an id
  once a version is released: accepted tags are stored by id, so a renamed id is a new tag (old tags
  keep the old label), and the judgments in the eval kit stop counting.
- **`label`**: `en` and `uz`. Aim for 14 characters or fewer, because the card slot is narrow (the
  checker warns above 14 and rejects above 24). Labels must be unique per language across tags,
  ignoring case, spaces at the ends and the apostrophe style, and an English label may not be another
  tag's Uzbek label: one name must point to one tag in search and in the picker. A tag's own EN and UZ
  may be the same ("Minimal" / "Minimal"). English uses sentence case. No `_` in labels, groups, lens
  names or summaries: they are shown as they are, and an underscore reads as an id; use a space (the
  checker's `text.underscore`; the app refuses the file). Labels don't affect scoring, so changing one
  needs a rebuild but no new measurement; for a shared tag, change it in every lens that has the tag.
  The English label is also the tag's stored name, which older qooti versions (1.2.2) show; the app
  updates it at the next start after a label changes.
- **`group`**: optional `{en, uz}`, at most 24 characters, with the same text rules as labels. The
  entries of one tag that give a group must give the same one.
- **`suggest`**: leave it out for a scored entry. `false` makes the entry add by hand; it then has no
  `prompts`, `media` or `aspect`.
- **`prompts`** (scored entries): 2–4 short English phrases (2–8 allowed; the checker warns above 4),
  2–6 words each (at most 8), all in the same style ("a road map"). They must be unique across all
  three lenses, also between the entries of one tag. The build wraps each one in "This is a photo of
  {p}". Changing a prompt changes the entry's vector: rebuild and measure again.
- **`media`** (scored entries, required): `any`, `picture` (images and GIFs) or `video`. Design entries
  are `picture` (decision 12). Use `video` for ideas that need footage, and for motion's entry of a tag
  that design or thumbnail describes for pictures.
- **`aspect`**: optional `[min, max]` of width/height. Use it only for formats: a 16:9 thumbnail is
  `[1.6, 1.95]`, SMD is `[0.5, 1.3]`.
- **`about`**: optional notes for you. They are copied into the built files, which ship inside the app
  and become public when published, so keep anything private out of them.
- **Lens fields:** `name` (≤ 48 characters) and `summary` (≤ 60) appear in onboarding and Settings;
  `bar` is `{picture, video}`, each 0.05–0.95; `borrows` (specialists only) lists design tag ids;
  `version` is described below.

**Writing prompts: what the model can and can't see**

- It can't read words. A post defined by its text (sale, giveaway, quote) can't be a tag.
- It sees a 224 px centre square. Small details (arrows, outlines, thin strokes) vanish, and formats
  need `aspect`, not prompts.
- Concrete, visible things work best ("stacks of dollar bills", "a video editing timeline"). Vague
  styles measure badly: in the first study "abstract" was right 0 of 66 times and "neon" 0 of 8, and
  Glitch became add by hand after 0 right of 21.
- Timing can't be seen: still frames show no transitions, speed ramps, rhythm or sound. Make such
  tags add by hand.
- One prompt can pull in unrelated items: "a world map" pulled in globes, and "at night" pulled in any
  dark frame. Measure after every prompt change.
- Near-twins split their items and both get weaker. Merge them, or keep only the specific one if it
  measures better.

**Where a new tag goes**

- **For pictures, in more than one role:** a `picture` entry in design, and its id in the `borrows` of
  the specialists that should show it.
- **For pictures and videos, described differently:** a shared tag, with a `picture` entry in design
  (or thumbnail) and a `video` entry in motion, same id and labels.
- **Only meaningful for one specialist:** an entry in that specialist. Specialists can only borrow
  design tags, never each other's: thumbnail's Tutorial, Podcast, Gaming, Sports and Documentary
  entries don't show to motion users, whose own entries for those tags cover videos only.
- **Can't be seen in a still frame** (timing, sound, purpose), or measured badly: an add-by-hand entry.

**Uzbek**

- Write o‘ and g‘ with ‘ (U+2018) and the tutuq with ’ (U+2019). Never use `'`, `` ` ``, `ʻ` or `ʼ`;
  the checker and the app reject them.
- Glossary: kutubxona (library), to‘plam (collection, never for lens), element (item), muqova
  (thumbnail), Sozlamalar (Settings), yuklab olish (download). "O‘chirish" means Delete in qooti; never
  use it for "turn off". "Tag lens" stays in English in both languages.

**Versions**

The app installs a lens file (bundled or from the catalogue) only when that lens is missing or the
file's `version` is higher than the installed one. So **every change, even a label, needs
`version` + 1**, or installed apps keep the old file. `build.mjs` enforces this: it stops with
"content changed: bump the version" and writes nothing, and `check.mjs` shows the same error.
`node scripts/lenses/build.mjs --allow-same-version` skips the check; use it only for a version no one
has installed. Versions go up to 100000. Only the ids `motion`, `design` and `thumbnail` are allowed;
any other lens file is an error.

- **Shared tags change together.** A shared tag's labels and group live in several files, and the app
  checks the whole set before it installs anything. To rename a shared tag, rename it in every lens
  that has it, give each of those lenses a new version, and publish them together: a set with two
  names for one tag doesn't install.
- **Today:** motion is version 3: Visualizer add by hand and Meme for pictures only, with the video
  rule of 2026-11-20. Your library already has motion version 2 (sha256 94e10a59be27…, your list, which
  replaced version 1), so this one needs the higher number (built without `--allow-same-version`).
  Design is version 3: your library
  already has a design version 2 from the dev build of 2026-11-19 (only the renames UI, 3D, SMD and
  Infographics; sha256 4a1e744e2205…), so the pictures-only list needs a higher number. Thumbnail is
  version 2: your library has version 1 (sha256 d6250d2c2f4d…), so the new list needs a higher number;
  its 9 dropped tags stay in the library as tags that are no longer suggested. Your answers changed
  motion 2 and design 3, and the thumbnail list changed motion 2 again (Sports on videos only), before
  any library had installed them, so all three kept their numbers (built with `--allow-same-version`).

## Rebuild, check and measure

Git Bash, from the worktree root (`E:/DP 2/qooti-redesign`), Node 24:

```bash
node scripts/lenses/check.mjs                  # sources + built files; must end with 0 error(s)
node scripts/lenses/build.mjs                  # builds all three: bundled copies, dist copies, index
node scripts/lenses/check.mjs                  # again, after the build
node --test "scripts/lenses/test/*.test.mjs"   # tool tests
```

- The build is deterministic: unchanged sources give byte-identical files ("unchanged" in its output).
  `updated_at` only moves when a lens's content changes, and the index `serial` only when an entry
  changes. The build also removes each lens's older copies from `lenses/dist`.
- `build.mjs --lens <id>` builds one lens while you work on it; finish with a full build.
- In the app, `cargo test --lib bundled` (in `src-tauri`) checks that the bundled files parse and
  install together.

`measure.mjs` leaves out videos longer than 60 s (+0.5 s) by itself, as the app does
(`--max-video-secs`, default 60; `Infinity` keeps them). The 30-second copy of the library
(`qooti-copy-max30s-realaspect.db`) has no 30–60 s videos, which the app tags since 2026-11-20: measure
videos on a full copy (for example `qooti-copy-2026-11-20.db`) with frames read one per second. Like
the app, it also leaves out videos whose length can't be read, and it applies the same-name rule
with the tags people made, read from the DB copy:

```bash
EVAL="E:/DP 2/qooti-tag-eval"
node scripts/lenses/measure.mjs --db "$EVAL/db/qooti-copy-max30s-realaspect.db" --out "$EVAL/runs/<name>" \
     --judgments "$EVAL/judgments-answers-2026-11-19" --domains "$EVAL/runs/final/domains-merged.json"
node "$EVAL/tools/crosslens.mjs" --db "$EVAL/db/qooti-copy-max30s-realaspect.db" --judgments "$EVAL/judgments-answers-2026-11-19" \
     --out "$EVAL/runs/<name>/crosslens.json" --domains "$EVAL/runs/final/domains-merged.json"
```

- `report.md` lists coverage per lens, the role views, fire rates per entry (⚠ above 25 %), entries
  that never fire, near-twins inside each pool, out-of-domain fires and precision per bar. A shared tag
  has one row per lens.
- `crosslens.mjs` (in the eval kit) adds the checks across lenses: design unchanged with the
  specialists installed, the closest pairs between lenses, items where two lenses fire together, and
  the first question per card. With the shared-tag tools it must read each entry's vector and lens
  through `scoringEntry(prepared, id, media)`; the copy in the eval kit still reads them from the
  concept rows, which these tools no longer have (see the port notes,
  `E:/DP 2/qooti-tag-eval/mirror-motion-v2/PORT-NOTES.md`, "Outside this mirror").
- `qooti-copy-max30s-realaspect.db` has the real picture shapes, which the app now stores; the 16:9
  and SMD gates need them.
- Pass the merged label file (above) rather than several `--domains` files: with several files,
  `measure.mjs` lets a later file replace an earlier file's labels for the same item.

## How judgments work

1. `measure.mjs` writes blind judge sheets (`runs/<name>/judge/`): every suggestion made at the low
   bar 0.15 that nobody has judged yet, with no scores and no lens names.
2. The judge looks at each picture (or the video's frames) and answers each tag: **yes** (a user would
   happily accept it), **partly** (related, or only partly true) or **no**.
3. Answers are saved in `E:/DP 2/qooti-tag-eval/judgments/`, keyed by item and tag id.
   `judgments-motion-v2/` holds a copy of them plus the rounds for the 2026-11-19 lists, and
   `judgments-answers-2026-11-19/` adds the round for your answers; use that one for these lists.
   Answers stay valid when prompts change and count again whenever that tag is suggested
   on that item. When a label's meaning changes, judge again in a new round; the highest round wins.
4. `measure.mjs --judgments` then reports right / partly / wrong and coverage at every bar.

The 2026-11-19 numbers use 1,165 judged pairs from 18 files, all made by Claude agents; a blind judge
(no lens names, no scores) checked the new pairs, and its verdict counts wherever it gave one. The
lenses were tuned and measured on the same library, so expect lower precision on other libraries, and
treat the numbers as a guide rather than a guarantee.

## Publishing

- Nothing is published yet. The app treats a missing catalogue as "nothing new" and uses the bundled
  lenses.
- `scripts/lenses/publish.mjs` uploads the lens files, then the index, to R2. **Only run it with the
  owner's explicit OK**; it refuses to do anything without `--yes-publish`. It backs up the live
  index before the first upload, and stops without uploading when anything is unclear: a lens
  file without a source or older than its source, an unknown lens id, or a live index it can't
  read (it treats the index as "not published yet" only when the public URL answers 404).
- Lenses that share a tag whose name changed must be published together (see Versions).
- Never edit, rename or delete the legacy file in the GitHub repo `blootapp/qooti-tag-lens`: builds up
  to 1.2.2 read it at every start.

## Open points for the owner

- **Most motion tags are untested.** 34 of its 49 scored entries never reached their bar on the test
  library, which has little footage of those kinds (ads, music videos, weddings, sports, vlogs and so
  on). Check them on a footage-heavy library.
- **Motion's UI fires on 41.0 % of the test library's videos**, above the 25 % rule, because almost
  half of them are UI animations. Of its 32 suggestions, 25 are right and 7 partly right.
- **Most thumbnail tags are untested.** The test library has few real YouTube thumbnails (99 of its
  420 pictures are 16:9): 14 of the 21 scored tags never reached the bar, Horror and YouTube niche
  never fired on a 16:9 picture, and the 7 that did rest on 1–4 pictures each, with one judge per
  pair. `E:/DP 2/qooti-tag-eval/README.md` lists a test set of about 220 thumbnails to collect.
- **Travel and Travel & Vlog are close** (r 0.754 on pictures, motion's `any` entry and thumbnail's
  picture entry). They are in different pools, so neither weakens the other, but someone with motion
  and thumbnail both on could be asked both on one travel picture (not seen on this library: Travel
  never fired on a picture there).
- **Eight design tags never fired** on this library, which has few photos: Cinematic, Portrait,
  Fashion, Product shot, Food, Nature, Architecture and Interior. The photo tags are kept on purpose:
  photos need a home in design, which is the "something else" for the specialists on pictures.
- **Motion's pictures-and-videos tags** (Beauty, Character, Abstract, Liquid, Particles, Map, Concert,
  Drone, Travel, Wedding, Science, Chromakey, Y2K and Anime) and its pictures-only Meme show only to
  motion users.
  To offer one to every role on pictures, give design a `picture` entry for it, switch motion's entry
  to `video`, add it to the `borrows` where wanted, and measure again.
- **Groups** are in the files but not shown in the app yet.
- **Uzbek labels to confirm** in the thumbnail list: Manipulyatsiya, Dizayn va DIY, Ko‘ngilochar,
  Qo‘rqinchli, Shaxsiy rivoj and YouTube nishasi. "Sayohat va vlog" and "YouTube nishasi" are 15
  characters, one over what the card slot fits (a checker warning, like "Korporativ video").
- The **`about` notes** ship inside the app and the published files.
