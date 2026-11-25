import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The recorded video (video/take.py) must use the SAME pop-up code, hold formulas and wording as the live Story. video/test_story_bridge.py checks that: the vendored
// overlay and hold modules become plain scripts, Normal speed equals the numbers take.py always produced, and the wording comes from /api/story.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('video: take.py runs on the shared overlay, hold formulas and wording (video/test_story_bridge.py)', (t) => {
  const run = spawnSync('python3', ['video/test_story_bridge.py'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (run.error && run.error.code === 'ENOENT') { t.skip('python3 is not available here'); return; }
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
