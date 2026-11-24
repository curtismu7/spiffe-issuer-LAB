// The Story script: one entry per caption key, in the order the recorded video walks the lab (video/take.py's bubble() calls). Pure data, no DOM:
// the page wiring (storyWiring.js) turns each entry into an engine step. The wording is in video/captions.md; test/story.test.js checks the two
// agree, and that the order, the numbered-bubble counts and the Mock mapping equal take.py's.
//
//   target   a CSS selector, or { selector } with a guard. A bubble whose target is not there is skipped.
//   prompt   { press } the viewer (or Play) presses that existing button.
//   lines    the name of a live value the page reads for the bubble's fact lines (the page wiring).
//   modes    ['real'] or ['mock']: shown only there. sampleKey: the Mock wording key.

export const STEPS = [
  { key: 'opening', type: 'slide', trigger: 'load' },

  { key: 'intro', type: 'bubble', trigger: 'load', target: '[data-testid=sim-banner]', prefer: 'below', sampleKey: 'sample_intro' },
  { key: 'federation', type: 'bubble', trigger: 'load', target: '[data-testid=federation]', prefer: 'right' },
  { key: 'jwks', type: 'bubble', trigger: 'load', target: { selector: '[data-testid=v-jwks]', note: 'the key list URL, in the Federated Identity card (the video opens the URL itself; Story points at it)' }, prefer: 'below' },
  { key: 'valid', type: 'bubble', trigger: 'load', target: { selector: '[data-testid=json-valid-box]', unlessMinting: true }, prefer: 'right', lines: 'ttl' },
  { key: 'mismatched', type: 'bubble', trigger: 'load', target: '[data-testid=json-mismatched-box]', prefer: 'left' },
  { key: 'untrusted', type: 'bubble', trigger: 'load', target: '[data-testid=json-untrusted-box]', prefer: 'left' },
  { key: 'present', type: 'bubble', trigger: 'load', target: '[data-testid=present]', prefer: 'left', prompt: { press: '[data-testid=present]' }, sampleKey: 'sample_present' },
  { key: 'valid_result', type: 'bubble', trigger: 'run-done', target: { row: 'valid', check: 'accepted' }, prefer: 'below', lines: 'validRow', sampleKey: 'sample_valid_result' },
  { key: 'refused', type: 'bubble', trigger: 'run-done', target: 'table.results', prefer: 'below', lines: 'refusals', sampleKey: 'sample_refused' },
  { key: 'trace', type: 'bubble', trigger: 'run-done', target: { validExchange: true }, prefer: 'left', sampleKey: 'sample_trace' },

  // Story only (the video has no such scene): the lab's own run record panel under the results. Skipped when there is no record.
  { key: 'observability_panel', type: 'bubble', trigger: 'load', target: { runRecord: true }, prefer: 'above', sampleKey: 'sample_observability_panel' },

  { key: 'closing', type: 'slide', trigger: 'load' },
];

// Wording only the video uses: the setup slide (it is dated from a Privilege console read the take does; Story shows no date and so does not show it)
// and the sample closing keys the video splices into its sample's closing slide.
export const VIDEO_ONLY = ['setup', 'sample_closing_lead', 'sample_closing_bullet'];

// Bubbles only Story has (the video has no such scene): the order and count checks against take.py leave them out.
export const STORY_ONLY = ['observability_panel'];

// What the parity test hands to captions.js parity(): the caption keys this script needs.
export function scriptKeys() {
  return {
    steps: STEPS.filter((s) => s.type === 'bubble').map((s) => s.key),
    slides: STEPS.filter((s) => s.type === 'slide').map((s) => s.key),
    sampleKeys: STEPS.map((s) => s.sampleKey).filter(Boolean),
  };
}
