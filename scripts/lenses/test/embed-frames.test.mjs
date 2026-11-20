// node --test "scripts/lenses/test/*.test.mjs"
// embed-frames.mjs: one frame per second (8–32) as frames.rs takes them; entries read with the
// 8-frame schedule are read again where it differs; a video whose header has no length is measured
// by reading its packets, like the indexer (the video rule); without any length it gets no frames.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseProgressDuration, probeDuration, measureDuration, findDuration, extractFrames,
  frameCount, frameTimes, needsReading, MIN_FRAMES, MAX_FRAMES, SCHEDULE, FRAMES_TAG, FRAMES_TAG_8,
} from '../embed-frames.mjs';
import { FFMPEG } from '../lib/paths.mjs';

test('one frame per second, at least 8 and at most 32 (frames.rs frame_count; R45, 2026-11-20)', () => {
  assert.equal(MIN_FRAMES, 8);
  assert.equal(MAX_FRAMES, 32);
  const table = [[0.4, 8], [2, 8], [7.99, 8], [8, 8], [8.0001, 9], [8.5, 9], [15, 15], [20.4, 21], [30.5, 31], [31, 31], [31.2, 32], [32, 32], [45, 32], [60.5, 32], [1400, 32]];
  for (const [d, n] of table) assert.equal(frameCount(d), n, `${d} s`);
  for (const bad of [0, -3, NaN, Infinity, null, undefined]) assert.equal(frameCount(bad), MIN_FRAMES, String(bad));
  // frameTimes takes the schedule's n by default; up to 8 s it is the old 8-frame schedule
  assert.equal(frameTimes(20.4).length, 21);
  assert.deepEqual(frameTimes(6), frameTimes(6, 8));
  assert.deepEqual(frameTimes(100, 8).map((t) => +t.toFixed(2)), [9.75, 21.25, 32.75, 44.25, 55.75, 67.25, 78.75, 90.25]);
  // the app's clip_frames tags (clip.rs)
  assert.equal(FRAMES_TAG, 'clip-b32-q8@fps1');
  assert.equal(FRAMES_TAG_8, 'clip-b32-q8');
});

test('which store entries are read (again): like clip.rs old_schedule_with, once', () => {
  const e8 = (duration, n = 8) => ({ n, duration, slots: [], times: [], f16: '' });
  assert.equal(needsReading(undefined, 60), true, 'no entry yet');
  assert.equal(needsReading(e8(7.5), 60), false, 'up to 8 s both schedules take the same 8 frames');
  assert.equal(needsReading(e8(8), 60), false);
  assert.equal(needsReading(e8(8.5), 60), true, 'read with 8 frames, 9 now');
  assert.equal(needsReading(e8(20.4, 6), 60), true, 'some of its 8 frames had failed: read again too');
  assert.equal(needsReading(e8(12, 0), 60), false, 'frames failed (n = 0): not tried again here');
  assert.equal(needsReading({ ...e8(20.4, 21), schedule: SCHEDULE }, 60), false, 'already one per second');
  assert.equal(needsReading({ ...e8(20.4, 19), schedule: SCHEDULE }, 60), false, 'one per second, two failed: done, never read again');
  assert.equal(needsReading({ n: 0, long: true, duration: 45 }, 60), true, 'measured too long for the old limit: in now');
  assert.equal(needsReading({ n: 0, long: true, duration: 75 }, 60), false);
  assert.equal(needsReading({ n: 0, long: true, duration: 45 }, 30), false);
});

test('parseProgressDuration takes the last out_time of a finished report', () => {
  const report = 'out_time_us=N/A\nprogress=continue\nout_time_us=5000000\nprogress=continue\nout_time_us=11960000\nprogress=end\n';
  assert.equal(parseProgressDuration(report), 11.96);
  assert.equal(parseProgressDuration(report.replace('progress=end', 'progress=continue')), null, 'cut off: unknown');
  assert.equal(parseProgressDuration('out_time_us=N/A\nprogress=end\n'), null);
  assert.equal(parseProgressDuration('out_time_us=0\nprogress=end\n'), null);
  assert.equal(parseProgressDuration('out_time_us=2500000\r\nprogress=end\r\n'), 2.5, 'Windows line ends');
  assert.equal(parseProgressDuration(''), null);
});

const hasFfmpeg = fs.existsSync(FFMPEG);
test('a WebM with "Duration: N/A" is measured, and then gets its frames (8 for 6 s)', { skip: hasFfmpeg ? false : 'no bundled ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-frames-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Written to a pipe, as a browser recording is: the header has no length.
  const made = spawnSync(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=25',
    '-c:v', 'libvpx', '-b:v', '200k', '-f', 'webm', 'pipe:1'], { maxBuffer: 64 << 20, windowsHide: true });
  assert.equal(made.status, 0);
  const webm = path.join(dir, 'nodur.webm');
  fs.writeFileSync(webm, made.stdout);
  assert.equal(await probeDuration(FFMPEG, webm), null, 'the header says N/A');
  const d = await measureDuration(FFMPEG, webm);
  assert.ok(Math.abs(d - 6) < 0.1, `measured ${d}`);
  const { dur, frames } = await extractFrames(FFMPEG, webm, null);   // header first, then the measurement
  assert.equal(dur, d);
  assert.equal(frames.length, frameCount(d));
  assert.equal(frames.length, 8);
  // A file that can't be read has no length at all (the app never tags it, not even from its cover).
  const broken = path.join(dir, 'broken.webm');
  fs.writeFileSync(broken, made.stdout.subarray(0, 64));
  assert.equal(await findDuration(FFMPEG, broken), null);
});
