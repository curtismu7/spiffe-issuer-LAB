# SPIFFE Issuer LAB video (lab only, real run)

A silent screen recording of this lab: the public key list, the three test tokens (valid, mismatched, untrusted), and **Present to the gateway** (valid 200, mismatched 401, untrusted 401), with numbered captions and full-screen slides. It follows the demo family's video standards: `VIDEO-BEST-PRACTICES.md` (copy of the canonical file).

Order of work: `SCRIPT.md` (sources first, with the corrections from an independent re-read and a separate review) -> `captions.md` (wording) -> **sample** -> owner review -> live take.

Latest release: [spiffe-issuer-lab-video-2026-11-25](https://github.com/curtismu7/spiffe-issuer-LAB/releases/tag/spiffe-issuer-lab-video-2026-11-25) — two cuts (monitor 1920x1080, laptop 1800x1168), 2:33 each, with real values masked on screen.

## Watch the videos (no setup needed)

The published cuts are committed in this repo, fully masked (no real hosts, audiences or tokens; see "Secrets" below):

- [`video/releases/2026-11-25-monitor.mp4`](releases/2026-11-25-monitor.mp4) — 1920x1080, 2:33, for a large display
- [`video/releases/2026-11-25-laptop.mp4`](releases/2026-11-25-laptop.mp4) — 1800x1168, 2:33, for a laptop screen

Download them (or clone the repo) and play in any video player — no sound, captions are on screen. The same files are attached to the GitHub release above.

## What you need to run the lab yourself

To stand the lab up instead of watching: Docker (OrbStack), then from the repo root `docker compose build && docker compose up`, and open the door URL the compose output prints. The video shows what Real mode does against a real PingOne Privilege gateway; Mock mode (the default) rehearses the same page in-process.

- `SCRIPT.md`: audience, the one idea, the sources table, the scene table, the checks before recording, what is deliberately not in the video.
- `captions.md`: every word on screen. `captions.py` loads it for `take.py`. Edit the wording there, not in the code.
- `take.py`: the recorder. `services.sh`: a private Mock instance of the lab (port 17839) for the sample.

## Run

Needs Docker (OrbStack), node, python3 with playwright and pillow, and ffmpeg. New recordings are written outside the repo tree (the examples write to `../../video-out/`); only the published, masked cuts under `video/releases/` are committed.

    # sample: Mock stand-in, headless, full timing, labelled SAMPLE (never a gateway answer)
    video/services.sh start                       # needs the lab image: docker compose build
    SAMPLE=1 PROFILE=monitor python3 video/take.py ../video-out/sample-work    # writes sample-monitor.mp4; PROFILE=laptop writes sample-laptop.mp4
    video/services.sh stop

    # rehearsal: fast, no video; REHEARSE_SHOTS=dir keeps a still per caption and slide
    REHEARSE=1 SAMPLE=1 REHEARSE_SHOTS=../video-out/shots python3 video/take.py ../video-out/rehearse

    # live take: the lab running in Real mode, then the real run
    PRIV_TENANT=<tenant> CONSOLE_API=<console origin> python3 video/take.py ../video-out/take-work
    HEADLESS_REAL=1 ...                           # the same take recorded headless (screen locked or off)
    PROFILE=monitor|laptop                        # one cut per screen: monitor 1920x1080 (text L, slides x1.3), laptop 1800x1169 (text S); files take-<profile>.mp4
                                                  # headless cuts trim the pre-roll so the video starts on the opening slide

`PRIV_TENANT` and `CONSOLE_API` (the Privilege desktop app's local API origin) are not kept in this public repo. The real take uses them to read the Federated Identity, the agent key and the grant, **read-only**, and compares them with the running lab so the "How Privilege is set up" slide is true on the day.

## What the real take refuses

It stops (non-zero exit, no claim of success) unless: the lab is in Real mode; the public key list is https, verifies, holds exactly one RSA key and no private field, and its `kid` matches the lab's; the decoded tokens on screen differ exactly as the captions say (mismatched only in `sub`, untrusted only in `kid`, which is not published; `exp - iat` equals the lifetime); the 14 console comparisons hold; Present answers 200, 401, 401 as designed, with both refused rows reading the same; the first trace exchange is the Valid token's; and the recording exists.

`video/out/` and `video/assets/` are gitignored (console screenshots show internal hostnames).

## Secrets in the videos

Nothing real is on screen. The take masks values as the page renders, before anything is drawn: the real gateway host and issuer become `https://gateway.example`, the real audience becomes `aws-agent-client`, and the minted tokens and signatures are blurred (and replaced in the request trace by `<JWT-SVID, 681 characters, kept on the server>`). Every published cut is gated before release: the in-page leak counter must read 0, OCR over one frame every 3 seconds must find no real value, and two independent visual review passes must flag nothing. `video/releases/` holds only cuts that passed all three gates, so committing them here is safe.
