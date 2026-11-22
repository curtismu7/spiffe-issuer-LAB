# SPIFFE Issuer LAB video (lab only, real run)

A silent screen recording of this lab: the public key list, the three test tokens (valid, mismatched, untrusted), and **Present to the gateway** (valid 200, mismatched 401, untrusted 401), with numbered captions and full-screen slides. It follows the demo family's video standards: `VIDEO-BEST-PRACTICES.md` (copy of the canonical file).

Order of work: `SCRIPT.md` (sources first, with the corrections from an independent re-read and a separate review) -> `captions.md` (wording) -> **sample** -> owner review -> live take.

- `SCRIPT.md`: audience, the one idea, the sources table, the scene table, the checks before recording, what is deliberately not in the video.
- `captions.md`: every word on screen. `captions.py` loads it for `take.py`. Edit the wording there, not in the code.
- `take.py`: the recorder. `services.sh`: a private Mock instance of the lab (port 17839) for the sample.

## Run

Needs Docker (OrbStack), node, python3 with playwright and pillow, and ffmpeg. Keep recordings **outside the repo tree** (the repo's host test scans every file): the examples write to `../../video-out/`.

    # sample: Mock stand-in, headless, full timing, labelled SAMPLE (never a gateway answer)
    video/services.sh start                       # needs the lab image: docker compose build
    SAMPLE=1 python3 video/take.py ../video-out/sample-work    # writes sample.mp4
    video/services.sh stop

    # rehearsal: fast, no video; REHEARSE_SHOTS=dir keeps a still per caption and slide
    REHEARSE=1 SAMPLE=1 REHEARSE_SHOTS=../video-out/shots python3 video/take.py ../video-out/rehearse

    # live take: the lab running in Real mode, then the real run
    PRIV_TENANT=<tenant> CONSOLE_API=<console origin> python3 video/take.py ../video-out/take-work
    HEADLESS_REAL=1 ...                           # the same take recorded headless (screen locked or off)

`PRIV_TENANT` and `CONSOLE_API` (the Privilege desktop app's local API origin) are not kept in this public repo. The real take uses them to read the Federated Identity, the agent key and the grant, **read-only**, and compares them with the running lab so the "How Privilege is set up" slide is true on the day.

## What the real take refuses

It stops (non-zero exit, no claim of success) unless: the lab is in Real mode; the public key list is https, verifies, holds exactly one RSA key and no private field, and its `kid` matches the lab's; the decoded tokens on screen differ exactly as the captions say (mismatched only in `sub`, untrusted only in `kid`, which is not published; `exp - iat` equals the lifetime); the 14 console comparisons hold; Present answers 200, 401, 401 as designed, with both refused rows reading the same; the first trace exchange is the Valid token's; and the recording exists.

`video/out/` and `video/assets/` are gitignored (console screenshots show internal hostnames).
