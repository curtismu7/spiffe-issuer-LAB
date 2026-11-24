# Story mode spec (SPIFFE Issuer LAB)

**Status:** agreed   **Owner:** Curtis (decides scope)
**Process tier:** 1 (lab prototype only the owner sees).
**Contract:** `AI-DEMO-Standalone/shared/story/README.md` (merged, PR #552/#553). Runbook: `shared/story/ADDING-TO-A-LAB.md`.
**Reference implementation:** `privilege-a2a-anthropic-demo-LAB` (slices 1–3 merged on its main). Copy its files; do not guess.

## Goal
Add a **Demo | Story** toggle to the lab page. Demo is the page exactly as it is; Story walks the same numbered bubbles and text slides the recorded video (`video/take.py`) shows, over the live lab, viewer-paced with an optional Play for me. Works in Mock and Real.

## Design (follows the contract and the runbook)
- Vendor `shared/story/` byte for byte into `web/src/story/` and `server/src/story/` with the pin (`story.sha256`, `scripts/story-checkPin.mjs`).
- Wording stays in `video/captions.md`, parsed by the vendored `captions.js`, served at `GET /api/story` by a lab glue file (`server/src/storyRoute.js`; this lab is plain JS, no TypeScript). The video's `captions.py` gets a `## Header` on the Opening Slide (rule 29) and ignores it; its `take.py` is unchanged in this PR.
- The script is `web/src/storyScript.js`: one entry per caption key, in `take.py`'s bubble order (10 bubbles: intro, federation, jwks, valid, mismatched, untrusted, present, valid_result, refused, trace). Slides: opening, setup, closing. Mock wording keys: the `sample_*` steps that already exist, used as `sampleKey`.
- Wiring `web/src/storyWiring.js` + `web/src/StoryRoot.jsx`, adapted from the A2A lab: this page is one React island (no tabs, no reel pop-outs, no chat messages), so the host is smaller: no `switchTab` content, no popout hooks, no `lastMessage` targets.
- **Run events:** `App.jsx` dispatches `spiffe:run-start` when Present starts and `spiffe:run-end` with `{ ok }` when it settles. Reset is not a page feature here (no Reset button is wired), so no reset event; the wiring keeps the listener harmless. The mint of fresh tokens is not a "run": only Present is.
- **Targets** (all exist on the page today): `[data-testid=sim-banner]`, `[data-testid=federation]`, `[data-testid=mint]`, `[data-testid=token-valid]`, `[data-testid=token-mismatched]`, `[data-testid=token-untrusted]`, each card's decoded payload box `[data-testid=json-<id>-box]`, `[data-testid=present]`, `[data-testid=row-valid]`, `table.results`, the Valid exchange's `.gw-io` block, `[data-testid=run-record]` for the observability bubble (Story-only; skipped when there is no record — the panel shows `ro-empty` then).
- **Live values** fill `{status}`, `{tools}`, `{ttl}` from the page (the results row and the token card), as `take.py` reads them. `{date}` is not filled by Story (the setup slide is shown as written; the wording keeps "Read from Privilege on {date}" only in the video's take). Decision: the Story setup slide wording keeps `{date}` — the wiring supplies it as "(an earlier day)" unless a value is on the page — no: simpler, Story skips filling and the wording uses a fixed sentence without {date}. Final: the setup slide is **video-only** in parity (`VIDEO_ONLY`); Story shows no setup slide because it cannot honestly date it.
- The toggle rides in `App.jsx`'s own `TopMenu` children area (this lab renders TopMenu directly; the toggle goes in the `extra` slot via a prop — TopMenu is vendored and already renders `extra`), with the StoryRoot lazy-loaded, a StoryBoundary, Exit remembering Demo and dropping `?story=1`.
- Prompt steps: none. The lab has one button (Present); the present step is a prompt-style step with `prompt: { press: '[data-testid=present]' }` and no fixed hold, so Play for me presses it.
- This lab's Mock CAN run Present offline (presentMock is in-process), so no simulated-run replay is needed; the `sample_*` wording marks mock rows as the stand-in's answers, exactly as the video's sample does.

## Acceptance criteria (each a runnable check)
1. `node scripts/story-checkPin.mjs .` prints `story pin ok`; `repo.test.mjs` style pin test fails on drift.
2. Parity both ways: every bubble/slide key in `captions.md` has a script step and vice versa; `VIDEO_ONLY` = [`setup`]; `STORY_ONLY` = [`observability_panel`]; mismatches fail `npm test`.
3. The bubble order in the script equals `take.py`'s `bubble(...)` call order; the numbered-bubble counts equal `TOTAL = 10`; the `sample_*` mapping matches `take.py`'s `sample_key=` arguments; these are asserted from `take.py` in the test.
4. Rule 29: the Opening Slide has a `## Header` naming the demo ("SPIFFE agent identity, against a real gateway"); the parser accepts it; `captions.py` still loads (a test imports it).
5. `GET /api/story` answers 200 with the wording + `sourceSha256`; a broken file is a 500 that names the wording problem and never carries a server path; an edit shows on the next request without a restart.
6. Demo mode unchanged: the served page names no story file; `npm test` green (server + web + scripts).
7. Story on, Mock, offline: the full walk reaches `done`; bubbles read "mock stand-in" wording via `sampleKey`; no outbound call beyond the lab's own API.
8. Story on, Real: Present step; valid_result shows the real status and tool count from the row; refusals quoted from the rows; the trace bubble points at the Valid exchange.
9. Play for me: presses Present with a script-made click, waits for `run-done`, never advances past an unfinished run; Normal speed holds equal the shared `hold.js` formulas; stops on manual input.
10. Esc exits to Demo with no overlay left; Back works; Demo mode with Story off is byte-identical behaviour.
11. Browser walk with `shared/story/tools/walk.py` and `play.py` at 1920x1080 and 1800x1169, screenshots read; exit 0.

## Unhappy paths
- Present fails (502 gateway unreachable): `run-end { ok: true }` still fires (the run completed; the rows show it); the refused/valid_result bubbles show what the page shows or are skipped. A request-level failure (`ok: false`) stalls with the message.
- No run yet when valid_result/refused/trace step shows: target missing → skipped quietly.
- Run-record panel empty (`ro-empty`): the observability bubble is skipped.
- Tokens not minted (impossible in this lab — they mint on load): steps skip.
- Story started mid-Real-run: the wait for `run-done` accepts the in-flight run's end (marker taken at step entry).
- Mock/Real switched mid-story: `modeKnown` + restart, as the A2A lab does (mode changes re-run the story).
- Long refusal words: cut to the first clause, as `take.py`'s `short()` does; fact lines never invent a reason.

## Out of scope
Re-recording the video; moving `take.py` onto the shared overlay (slice 4 of the runbook, later PR); editing any vendored file; cluster or tenant changes; the SPIRE card (Story hides nothing).

## Protected / must not break
Demo mode and its tests; the Mock/Real toggle and rule 19/26 behaviour; netguard and the loopback-only API; the vendored pins (TopMenu, JsonPane, gateway-trace, run-observability, standalone-ui.css); the video takes; no internal hostnames, tenant ids or keys in the repo; no screenshot committed.

## Verification plan
`npm test` (server, web, scripts) in the worktree; pin + parity + take.py-derived tests; `walk.py` Mock and Real at both sizes with screenshots read; `play.py`; `/code-review` before PR; merge only when the owner says "merge N".
