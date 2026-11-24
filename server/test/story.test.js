import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CAPTIONS_PATH, loadCaptions, resetCaptionsCache, storyResponse } from '../src/storyRoute.js';
import { parity } from '../src/story/captions.js';
import { checkPin } from '../../scripts/story-checkPin.mjs';
import { STEPS, STORY_ONLY, VIDEO_ONLY, scriptKeys } from '../../web/src/storyScript.js';
import { startLab, baseEnv, tmpStore } from './helpers.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('story: the vendored Story files match their pin (an edited copy fails CI)', () => {
  assert.deepEqual(checkPin(root), []);
});

test('story: every caption key has a step in the script and every step has wording (the parity test)', () => {
  assert.deepEqual(parity(loadCaptions(), scriptKeys(), { allowUnused: VIDEO_ONLY }), []);
});

test('story: the parity check really fails when the wording and the script drift', () => {
  const captions = loadCaptions();
  const missingWording = { ...captions, steps: Object.fromEntries(Object.entries(captions.steps).filter(([k]) => k !== 'valid_result')) };
  assert.deepEqual(parity(missingWording, scriptKeys(), { allowUnused: VIDEO_ONLY }), ['the demo has step "valid_result" but captions.md does not']);
  const extra = { ...scriptKeys(), steps: [...scriptKeys().steps, 'brand_new'] };
  assert.deepEqual(parity(captions, extra, { allowUnused: VIDEO_ONLY }), ['the demo has step "brand_new" but captions.md does not']);
});

test('story: the bubbles come in the same order as in take.py, with the same Mock mapping, and the count is the video\'s 10', () => {
  const video = fs.readFileSync(`${root}video/take.py`, 'utf8');
  const order = [...video.matchAll(/\bbubble\("([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.equal(order.length, 10);
  assert.deepEqual(STEPS.filter((s) => s.type === 'bubble' && !STORY_ONLY.includes(s.key)).map((s) => s.key), order);
  // take.py's TOTAL counts the numbered bubbles; the script's live bubbles are the same 10
  assert.match(video, /^TOTAL = 10\b/m);
  // every sample_key= in take.py sits on the script step with the same key, and names wording that exists
  const captions = loadCaptions();
  const samples = [...video.matchAll(/bubble\("([a-z0-9_]+)"[^\n]*?sample_key="([a-z0-9_]+)"/g)];
  assert.ok(samples.length >= 5, 'take.py maps sample wording');
  for (const [, key, sk] of samples) {
    const step = STEPS.find((s) => s.key === key);
    assert.ok(step, `${key} is in the script`);
    assert.equal(step.sampleKey, sk, `${key}: the script's sampleKey is take.py's`);
    assert.ok(captions.steps[sk], `${sk} wording exists`);
  }
  // the present step presses the same button take.py clicks
  const present = STEPS.find((s) => s.key === 'present');
  assert.match(video, /page\.click\("\[data-testid=present\]"\)/);
  assert.equal(present.prompt.press, '[data-testid=present]');
});

test('story (rule 29): the Opening Slide has a header naming the demo, and the video loader still reads the file', () => {
  const captions = loadCaptions();
  assert.ok(captions.opening.header && captions.opening.header.length > 3, 'the opening slide has a header');
  assert.equal(captions.opening.header, 'SPIFFE agent identity, against a real gateway');
});

test('story: captions.md and the script are public-safe (no internal host, tenant id, key or UUID)', () => {
  const text = fs.readFileSync(CAPTIONS_PATH, 'utf8') + fs.readFileSync(`${root}web/src/storyScript.js`, 'utf8');
  assert.equal(/ping-devops|procyon|\.local\b|sk-ant|mcpgw|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), false);
});

test('story: storyResponse serves the parsed wording, and a broken file is a 500 that names the problem (never a crash, never a path)', () => {
  const ok = storyResponse();
  assert.equal(ok.status, 200);
  assert.ok(ok.body.opening.title && ok.body.steps.intro);
  assert.equal(ok.body.sourceSha256, createHash('sha256').update(fs.readFileSync(CAPTIONS_PATH)).digest('hex'));
  const tmp = fs.mkdtempSync(`${root}.tmp-story-`);
  try {
    const bad = `${tmp}/captions.md`;
    fs.writeFileSync(bad, '# Step: x\n\n## Title\nonly a title\n');
    const broken = storyResponse(bad);
    assert.equal(broken.status, 500);
    assert.match(broken.body.error, /^Story wording could not be read: captions\.md: step "x" needs both a "## Title" and a "## Text" section$/);
    const missing = storyResponse(`${tmp}/missing.md`);
    assert.equal(missing.status, 500);
    assert.match(missing.body.error, /missing or unreadable/);
    assert.equal(JSON.stringify(missing.body).includes(tmp), false, 'the 500 never carries a server path');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  resetCaptionsCache();
});

test('story: a fix to captions.md shows without a restart (the wording is read again when the bytes change, whatever the timestamp)', () => {
  const tmp = fs.mkdtempSync(`${root}.tmp-story2-`);
  const file = `${tmp}/captions.md`;
  const slide = (t) => `# Opening Slide\n\n## Header\nh\n\n## Title\n${t}\n\n## Lead\nl\n\n## Column A: a\n- x\n\n## Column B: b\n- y\n\n## Verdict\nv\n\n---\n\n`;
  const doc = (t) => slide(t) + slide('c').replace('# Opening Slide', '# Closing Slide');
  try {
    fs.writeFileSync(file, doc('first'));
    assert.equal(loadCaptions(file).opening.title, 'first');
    const when = new Date(Date.now() - 60_000);
    fs.utimesSync(file, when, when);
    fs.writeFileSync(file, doc('second'));
    fs.utimesSync(file, when, when);            // new bytes, the very same timestamp
    assert.equal(loadCaptions(file).opening.title, 'second');
    const served = storyResponse(file);
    assert.equal(served.body.opening.title, 'second');
    assert.equal(served.body.sourceSha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'the served hash matches the bytes it parsed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  resetCaptionsCache();
});

test('story: GET /api/story answers the wording, and the Demo page does not mention Story', async () => {
  const lab = await startLab({ env: baseEnv(), store: tmpStore() });
  try {
    const r = await lab.get('/api/story');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const body = await r.json();
    assert.ok(body.steps.intro?.title && body.opening.title);
    assert.equal(typeof body.sourceSha256, 'string');
    const page = await (await fetch(`${lab.base}/`)).text();
    assert.equal(/api\/story|storyScript|story-bar/i.test(page), false, 'Demo mode: the served page does not mention Story');
  } finally { await lab.close(); }
});
