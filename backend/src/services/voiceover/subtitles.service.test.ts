import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCues, renderSubtitles, subtitleTime } from './subtitles.service.js';
import { MAX_TEMPO, placeClips } from './timeline.service.js';

test('placeClips leaves a clip that fits untouched', () => {
  const [p] = placeClips([{ startSec: 2, durationSec: 3 }, { startSec: 8, durationSec: 1 }], 20);
  assert.deepEqual(p, { startSec: 2, endSec: 5, tempo: 1, trimmed: false });
});

test('placeClips speeds up a long clip so it ends before the next line', () => {
  const [p] = placeClips([{ startSec: 0, durationSec: 5.5 }, { startSec: 5, durationSec: 1 }], 20);
  assert.equal(p!.tempo, 1.1);
  assert.ok(p!.endSec <= 5);
  assert.equal(p!.trimmed, false);
});

test('placeClips trims past MAX_TEMPO and never overlaps', () => {
  const placed = placeClips([{ startSec: 0, durationSec: 10 }, { startSec: 4, durationSec: 9 }], 9);
  assert.equal(placed[0]!.tempo, MAX_TEMPO);
  assert.equal(placed[0]!.trimmed, true);
  assert.equal(placed[0]!.endSec, 4);
  assert.equal(placed[1]!.endSec, 9);
});

test('subtitleTime formats SRT and VTT', () => {
  assert.equal(subtitleTime(3723.4567, 'srt'), '01:02:03,457');
  assert.equal(subtitleTime(5, 'vtt'), '00:00:05.000');
});

test('buildCues splits long lines into two-line cues within the line span', () => {
  const text = 'Open Patients from the sidebar, then click Register to add a new patient with their basic details.';
  const cues = buildCues([{ startSec: 10, endSec: 16, text }]);
  assert.ok(cues.length >= 2);
  assert.equal(cues[0]!.startSec, 10);
  assert.equal(cues.at(-1)!.endSec, 16);
  for (const c of cues) {
    const lines = c.text.split('\n');
    assert.ok(lines.length <= 2);
    assert.ok(lines.every((l) => l.length <= 42));
  }
});

test('renderSubtitles produces valid SRT and VTT', () => {
  const cues = [{ startSec: 1, endSec: 2.5, text: 'Hello' }];
  assert.equal(renderSubtitles(cues, 'srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello\n');
  assert.equal(renderSubtitles(cues, 'vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n');
});
