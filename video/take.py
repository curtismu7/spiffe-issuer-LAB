"""The SPIFFE Issuer LAB take: opens its own visible 'Google Chrome for Testing' window on the lab, screen-records only that window's page area,
and runs the page with numbered captions: the public key list, the three tokens, then Present to the gateway (valid 200, mismatched 401, untrusted 401).
No sign-in is involved. Adapted from the A2A take (privilege-a2a-anthropic-demo-LAB/video) and the CIMD take (privilege-cimd-test/video).

Usage: python3 take.py <work_dir>
  Modes: REHEARSE=1 (headless, fast, no video; REHEARSE_SHOTS=dir keeps a still per caption), SAMPLE=1 (headless, full timing, mock stand-in, labelled SAMPLE,
  writes sample.mp4), HEADLESS_REAL=1 (the real take recorded headless), default (the real take, ffmpeg screen capture).
  The real take refuses to run unless the lab is in Real mode, the public key list is reachable with one key and no private fields, and the gateway
  answers 200/401/401 as designed. work_dir gets: ready.json (window geometry), take.mp4 / sample.mp4, take.log, result.json.

Which screen: MONITOR picks "medium" (an external monitor the window is placed on; default) or "laptop" (the built-in display). avfoundation's
screen device numbers are not stable here, so the take paints the window green and picks the capture device that shows it (CAPTURE_DEVICE forces one).
"""
import json, os, re, signal, ssl, subprocess, sys, tempfile, time, urllib.request, uuid
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64
from captions import OPENING_SLIDE, CLOSING_SLIDE, STEPS, SLIDES

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "take-work").resolve()
# Two videos, one per screen (owner, 2026-11-22): the window is full screen so the video fills the display.
#   PROFILE=monitor  the middle 1920x1080 monitor: large text (root 18px, the TopMenu "L") and large slides and captions
#   PROFILE=laptop   the built-in display (1800x1169 points): small text (root 14px, "S") so busy screens fit; slides and captions at normal size
# This app's TopMenu has no Text size control wired, so the take sets the root font size itself (the same 14/16/18px the TopMenu maps S/M/L to).
PROFILE = os.environ.get("PROFILE", "monitor")
PROFILES = {"monitor": dict(monitor="medium", display=(1920, 1080), root=18, scale=1.3, dsf=1, video=(1920, 1080)),
            "laptop":  dict(monitor="laptop", display=(1800, 1169), root=14, scale=1.0, dsf=1, video=(1800, 1169))}   # headless: Playwright records at the CSS viewport size; a larger video size only letterboxes the page in a corner
_prof = PROFILES[PROFILE]
SCALE = float(os.environ.get("SCALE", _prof["scale"])); ROOT_PX = int(os.environ.get("ROOT_PX", _prof["root"]))
MONITOR = os.environ.get("MONITOR", _prof["monitor"])        # "medium" (an external monitor) or "laptop" (built-in display)
# Each preset's own global top-left in Quartz/Chromium coordinates (top-left origin, Y grows downward - NOT the
# bottom-left/Y-up convention AppKit's NSScreen reports). "medium" was measured once against a real monitor
# arrangement; "laptop" is exact by definition (a display's own top-left is Quartz (0, 0) only for the main
# display, which the built-in one is on a laptop with no other display marked main).
PRESETS = {"medium": {"origin": (-1920, -905), "win": (-1920, -905)}, "laptop": {"origin": (0, 0), "win": (0, 0)}}   # the window sits at the display's own top-left and fills it
_preset = PRESETS.get(MONITOR, PRESETS["medium"])
ORIGIN_X, ORIGIN_Y = int(os.environ.get("DISPLAY_X", _preset["origin"][0])), int(os.environ.get("DISPLAY_Y", _preset["origin"][1]))
WIN_X, WIN_Y = int(os.environ.get("WIN_X", _preset["win"][0])), int(os.environ.get("WIN_Y", _preset["win"][1]))
WIN_W, WIN_H = _prof["display"]   # the window is the whole display
REHEARSE = os.environ.get("REHEARSE") == "1"   # headless, no recording, no waiting for a person (runs against whatever route the app has: live or the local stand-in)
SAMPLE = os.environ.get("SAMPLE") == "1"       # preview: headless, full timing, records with Playwright, mock stand-in allowed, labelled SAMPLE in the video
HEADLESS_REAL = os.environ.get("HEADLESS_REAL") == "1"   # the REAL take (live route, Real mode, all checks) recorded headless by Playwright, for when the screen is locked or off
RECORD_PW = (SAMPLE or HEADLESS_REAL) and not REHEARSE
HEADLESS = REHEARSE or SAMPLE or HEADLESS_REAL
WAIT_GO = os.environ.get("WAIT_GO") == "1"     # wait for go.flag before recording (default: start after the calibration, no sign-in is needed here)
THEME = os.environ.get("THEME", "light")         # "dark" or "light": the page theme shown throughout the take (standard, 2026-11-21: light by default)
APP = os.environ.get("APP_URL", "http://127.0.0.1:17839" if SAMPLE else "https://local.ping-devops.com:8443/spiffe-issuer")   # real: the lab proxy URL (never loopback); sample: the private mock instance from services.sh
def log(*a):
    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / "take.log").open("a") as f:
        print(*a, file=f, flush=True)

def list_screen_devices():
    """The avfoundation device numbers currently labelled "Capture screen N" - never hardcoded, since a camera
    connecting or disconnecting (including an iPhone via Continuity Camera) shifts every index after it."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                         capture_output=True, text=True, timeout=15).stderr
    return [int(m.group(1)) for m in re.finditer(r"\[(\d+)\] Capture screen \d+", out)]

def detect_capture_device(work):
    """Which of the current "Capture screen N" devices actually shows this window: paint the page solid green,
    grab one frame from each candidate, and pick whichever has a large contiguous green run (a plain "any green
    pixel" test false-positives on a green-ish desktop wallpaper). Raises with a clear message if none match,
    rather than silently guessing wrong and recording the wrong screen."""
    from PIL import Image
    candidates = list_screen_devices()
    if not candidates:
        raise RuntimeError("no avfoundation 'Capture screen N' device found - is Screen Recording permission granted?")
    best = (None, 0)
    for dev in candidates:
        frame = work / f"_calib_{dev}.png"
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation",
                           "-framerate", "30", "-pixel_format", "uyvy422", "-i", f"{dev}:none", "-frames:v", "1", str(frame)],
                          capture_output=True, timeout=15)
        if r.returncode != 0 or not frame.exists():
            continue
        im = Image.open(frame).convert("RGB")
        w, h = im.size
        px = im.load()
        matched = 0
        for y in range(0, h, 3):
            run = 0
            for x in range(w):
                px_r, px_g, px_b = px[x, y]
                if px_g > 120 and px_g > px_r * 2.2 and px_g > px_b * 2.2:
                    run += 1
                    if run > w * 0.3:
                        matched += run
                else:
                    run = 0
        frame.unlink(missing_ok=True)
        log("calibration: device", dev, "matched", matched)
        if matched > best[1]:
            best = (dev, matched)
    if best[0] is None:
        raise RuntimeError(f"calibration found the green marker on none of {candidates} - the window may be off-screen for this MONITOR preset")
    return best[0]

OVERLAY = r"""
(() => {
  if (window.__cm) return;
  const S = window.__cmScale || 1; const px = (n) => Math.round(n * S) + 'px';
  const css = `
  html{font-size:${window.__cmRoot || 16}px !important}
  .cm-hl{position:fixed;z-index:2147483644;border:3px solid #ff3b57;border-radius:10px;box-shadow:0 0 0 9999px rgba(8,10,13,.28);pointer-events:none;transition:all .25s}
  .cm-bub{box-sizing:border-box;position:fixed;z-index:2147483645;width:${px(470)};background:#f7f8fc;color:#14202e;border:3px solid #e3002b;border-radius:20px;padding:${px(14)} ${px(20)} ${px(14)} ${px(64)};font:${px(18)}/1.4 system-ui,sans-serif;box-shadow:0 14px 36px rgba(0,0,0,.55)}
  .cm-bub .n{position:absolute;left:${px(14)};top:${px(14)};width:${px(36)};height:${px(36)};border-radius:50%;background:#e3002b;color:#fff;font:700 ${px(19)}/${px(36)} system-ui;text-align:center}
  .cm-bub h3{margin:0 0 4px;font-size:${px(19)};color:#14202e !important;font-weight:800}
  .cm-bub p{margin:0;color:#233044}
  .cm-bub ul{margin:8px 0 0;padding:0;list-style:none}
  .cm-bub li{margin:6px 0;padding:6px 9px;background:#e8ebf3;border-radius:6px;font:${px(15)}/1.5 ui-monospace,Menlo,monospace;color:#051727;font-weight:600;word-break:break-word;overflow-wrap:anywhere}
  .cm-bub .of{position:absolute;right:14px;top:10px;font-size:${px(12)};color:#5b667a}
  .cm-tail{position:absolute;width:22px;height:22px;background:#f7f8fc;border:3px solid #e3002b;transform:rotate(45deg)}
  .cm-pill{position:fixed;right:14px;bottom:12px;z-index:2147483646;background:#1d232b;color:#f2f4f7;border:1px solid #3a4350;border-radius:999px;padding:4px 14px;font:700 13px system-ui,sans-serif;pointer-events:none}
  .cm-slide{box-sizing:border-box;position:fixed;z-index:2147483647;inset:0;display:flex;align-items:center;justify-content:center;background:#051727;font:17px/1.5 system-ui,sans-serif;padding:24px}
  .cm-slide .card{zoom:${S};box-sizing:border-box;width:min(1100px,calc(94vw / ${S}));max-height:calc(92vh / ${S});overflow-y:auto;background:#0f2236;color:#f2f4f7;border:3px solid #e3002b;border-radius:24px;padding:32px 40px;box-shadow:0 24px 60px rgba(0,0,0,.6)}
  .cm-slide h1{margin:0 0 10px;font-size:32px;font-weight:800;color:#fff}
  .cm-slide .lead{margin:0 0 20px;color:#c7d0dc;font-size:19px}
  .cm-slide .cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
  @media (max-width:760px){ .cm-slide .cols{grid-template-columns:1fr} }
  .cm-slide .card.withimg{width:min(1400px,calc(98vw / ${S}))}
  .cm-slide .card.withimg h1{font-size:28px;margin-bottom:6px}.cm-slide .card.withimg .lead{margin-bottom:12px}
  .cm-slide .split{display:grid;grid-template-columns:1.25fr 1fr;gap:26px;align-items:start;margin-bottom:6px}
  .cm-slide .split img{width:100%;border-radius:10px;border:1px solid #2a3b52;background:#fff}
  .cm-slide .col h2{margin:0 0 8px;font-size:19px;color:#8fbcff}
  .cm-slide .col.colb h2{color:#ffb4a8}
  .cm-slide .col ul{margin:0;padding-left:20px}
  .cm-slide .col li{margin:7px 0;font-size:18px}
  .cm-slide .verdict{margin:22px 0 0;padding-top:16px;border-top:1px solid #2a3b52;font-weight:700;color:#fff;font-size:18px}
  .reel-backdrop{justify-content:flex-start !important;padding-left:20px !important}
  .reel-dialog{width:min(${Math.round(880 * S)}px,100%) !important}`;
  const root = () => document.documentElement;
  const ensure = () => { if (!root() || document.getElementById('cm-style')) return; const st = document.createElement('style'); st.id = 'cm-style'; st.textContent = css; root().appendChild(st);
    const pill = document.createElement('div'); pill.className = 'cm-pill'; pill.textContent = window.__pillText || 'LIVE RUN'; root().appendChild(pill); };
  document.addEventListener('DOMContentLoaded', ensure); ensure();
  const els = []; const clear = () => { while (els.length) els.pop().remove(); };
  setInterval(() => { document.querySelectorAll('h2.card__title').forEach((h) => { if (/SPIRE server control/.test(h.textContent)) { const c = h.closest('.card') || h.closest('section'); if (c) c.style.display = 'none'; } });
    document.querySelectorAll('.jform__v--token, .jwt').forEach((e) => { e.style.filter = 'blur(7px)'; });
    document.querySelectorAll('.jdec__h').forEach((h) => { if (/signature/i.test(h.textContent) && h.nextElementSibling) h.nextElementSibling.style.filter = 'blur(7px)'; }); }, 250);
  window.__authUrl = null; 
  window.__cm = { clear, slide(o) {
    ensure(); clear();
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<h1></h1><p class="lead"></p><div class="cols">
      <div class="col cola"><h2></h2><ul></ul></div>
      <div class="col colb"><h2></h2><ul></ul></div></div><p class="verdict"></p>`;
    card.querySelector('h1').textContent = o.title;
    card.querySelector('.lead').textContent = o.lead;
    card.querySelector('.cola h2').textContent = o.cola.h;
    card.querySelector('.cola ul').append(...o.cola.lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    card.querySelector('.colb h2').textContent = o.colb.h;
    card.querySelector('.colb ul').append(...o.colb.lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    card.querySelector('.verdict').textContent = o.verdict;
    if (o.image) { card.classList.add('withimg'); const split = document.createElement('div'); split.className = 'split'; const im = document.createElement('img'); im.src = o.image; im.alt = 'Screenshot of the Privilege console'; const cols = card.querySelector('.cols'); cols.style.gridTemplateColumns = '1fr'; cols.parentNode.insertBefore(split, cols); split.append(im, cols); }
    // Belt and suspenders on top of the CSS max-height: an explicit pixel value computed from the real
    // viewport, so this never depends on vh units resolving the way a particular Chromium build expects.
    card.style.maxHeight = Math.round(innerHeight * 0.88 / S) + 'px';
    const wrap = document.createElement('div'); wrap.className = 'cm-slide'; wrap.append(card);
    root().appendChild(wrap); els.push(wrap);
  }, cap(o) {
    ensure(); clear();
    const vw = innerWidth, vh = innerHeight, W = Math.round(470 * S), GAP = 26, M = 12;
    const t = o.target ? document.querySelector(o.target) : null;
    // Scroll the target's own panel so it is on screen before measuring it: otherwise a sidebar field, a reel
    // frame or a step-detail row that has scrolled out of view gets highlighted in the wrong place, or the
    // viewer never actually sees what the caption is pointing at.
    if (t) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = t ? t.getBoundingClientRect() : null;
    if (r) { const h = document.createElement('div'); h.className = 'cm-hl'; h.style.cssText = `left:${r.left-5}px;top:${r.top-5}px;width:${r.width+10}px;height:${r.height+10}px`; root().appendChild(h); els.push(h); }
    const b = document.createElement('div'); b.className = 'cm-bub';
    b.innerHTML = `<span class="n"></span><span class="of"></span><h3></h3><p></p>` + (o.lines ? '<ul>' + o.lines.map(() => '<li></li>').join('') + '</ul>' : '');
    b.querySelector('.n').textContent = o.n; b.querySelector('.of').textContent = o.n + ' of ' + o.total;
    b.querySelector('h3').textContent = o.title; b.querySelector('p').textContent = o.text;
    (o.lines || []).forEach((l, i) => { b.querySelectorAll('li')[i].textContent = l; });
    b.style.visibility = 'hidden'; root().appendChild(b); els.push(b);
    const H = b.getBoundingClientRect().height;
    let left, top, side = null;
    if (o.place === 'bl') { left = M + 8; top = vh - H - 24; }
    else if (!r) { left = (vw - W) / 2; top = vh - H - 40; }
    else {
      const fits = { right: r.right + GAP + W + M <= vw, left: r.left - GAP - W >= M, below: r.bottom + GAP + H + M <= vh, above: r.top - GAP - H >= M };
      const order = o.prefer ? [o.prefer, 'right', 'left', 'below', 'above'] : ['right', 'left', 'below', 'above'];
      side = order.find((s) => fits[s]) || (vw - r.right > r.left ? 'right' : 'left');
      if (side === 'right') { left = r.right + GAP; top = r.top + r.height / 2 - H / 2; }
      else if (side === 'left') { left = r.left - GAP - W; top = r.top + r.height / 2 - H / 2; }
      else if (side === 'below') { left = r.left + r.width / 2 - W / 2; top = r.bottom + GAP; }
      else { left = r.left + r.width / 2 - W / 2; top = r.top - GAP - H; }
    }
    left = Math.max(M, Math.min(vw - W - M, left)); top = Math.max(M, Math.min(vh - H - M, top));
    b.style.left = left + 'px'; b.style.top = top + 'px'; b.style.visibility = 'visible';
    if (r && side && o.place !== 'bl') {
      const tail = document.createElement('div'); tail.className = 'cm-tail';
      const cx = Math.max(left + 26, Math.min(left + W - 26, r.left + r.width / 2)), cy = Math.max(top + 26, Math.min(top + H - 26, r.top + r.height / 2));
      if (side === 'right') { tail.style.left = '-13px'; tail.style.top = (cy - top - 11) + 'px'; tail.style.borderRight = 'none'; tail.style.borderTop = 'none'; }
      if (side === 'left') { tail.style.right = '-13px'; tail.style.top = (cy - top - 11) + 'px'; tail.style.borderLeft = 'none'; tail.style.borderBottom = 'none'; }
      if (side === 'below') { tail.style.top = '-13px'; tail.style.left = (cx - left - 11) + 'px'; tail.style.borderBottom = 'none'; tail.style.borderRight = 'none'; }
      if (side === 'above') { tail.style.bottom = '-13px'; tail.style.left = (cx - left - 11) + 'px'; tail.style.borderTop = 'none'; tail.style.borderLeft = 'none'; }
      b.appendChild(tail);
    }
  } };
})();
"""
TOTAL = 10   # numbered caption bubbles; the take counts them and logs a mismatch
EXPECT_STATUS = [200, 401, 401]   # valid, mismatched, untrusted: the lab's design, and what the live gateway answered on 2026-11-22

def hold(text, extra=0.0):
    return max(5.0, len(text.split()) * 0.30 + 2.2) + extra

def slide_payload(cfg):
    """captions.py's flat shape -> the JS slide() function's shape. Edit captions.md, not this."""
    image = None
    if cfg.get("image"):
        raw = (Path(__file__).parent / "assets" / cfg["image"]).read_bytes()
        image = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    return dict(image=image, title=cfg["title"], lead=cfg["lead"],
                cola=dict(h=cfg["col_a_heading"], lines=cfg["col_a_lines"]),
                colb=dict(h=cfg["col_b_heading"], lines=cfg["col_b_lines"]),
                verdict=cfg["verdict"])

def slide_hold_text(cfg):
    return " ".join([cfg["lead"], *cfg["col_a_lines"], *cfg["col_b_lines"], cfg["verdict"]])

def hold_slide(cfg, extra=0.0, cap=10.0):
    # Owner rule (2026-11-22): no slide is held longer than 10 seconds. The text in captions.md is trimmed to be skimmed in that time.
    return min(10.0, max(6.0, len(slide_hold_text(cfg).split()) * 0.25 + 3.0))

def fill(text, **vals):
    for k, v in vals.items():
        text = text.replace("{" + k + "}", str(v))
    return text

def get_json(url, timeout=15, verify=False):
    ctx = ssl.create_default_context()
    if not verify: ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE   # the family lab-proxy uses a local mkcert CA; the public key list is fetched with verify=True
    with urllib.request.urlopen(url, timeout=timeout, context=ctx) as r:
        return r.status, json.loads(r.read().decode())

def preflight(info, jwks_url):
    """The script's 'checks before recording': what must be true of the live system for the captions to be true. Returns (ok, notes, published_kids)."""
    notes = []; ok = True; kids = set(); cfg = info.get("config", {})
    if not SAMPLE:
        if info.get("source") != "real": ok = False; notes.append("mode is not Real: " + str(info.get("source")))
        if not cfg.get("publicUrlSet"): ok = False; notes.append("PUBLIC_URL is not set")
        if not jwks_url.startswith("https://"): ok = False; notes.append("the key list URL is not https")
    if cfg.get("alg") != "RS256": ok = False; notes.append("alg is not RS256 (the captions name n and e)")
    if cfg.get("untrustedMode") != "key": ok = False; notes.append("untrusted mode is not 'key' (the caption says only the key differs)")
    try:
        status, jwks = get_json(jwks_url, verify=not SAMPLE)   # real: normal certificate checking on the public URL
        keys = jwks.get("keys", [])
        private = [k for k in keys if any(f in k for f in ("d", "p", "q", "dp", "dq", "qi"))]
        kids = {k.get("kid") for k in keys}
        if status != 200 or len(keys) != 1 or private: ok = False; notes.append(f"key list: status {status}, {len(keys)} key(s), private fields {bool(private)}")
        elif not (keys[0].get("n") and keys[0].get("e") and keys[0].get("kty") == "RSA"): ok = False; notes.append("the published key is not an RSA key with n and e")
        elif keys[0].get("kid") != cfg.get("trustedKid"): ok = False; notes.append("published kid differs from the lab's trusted kid")
        else: notes.append("key list ok: 1 RSA key (n, e), no private fields, kid matches, fetched with certificate checking" if not SAMPLE else "key list ok (sample, loopback)")
    except Exception as e:
        ok = False; notes.append(f"key list not reachable at {jwks_url}: {e}")
    return ok, notes, kids

def console_check(info):
    """Read-only: GET the Federated Identity, the agent key and the grant from the Privilege console API and compare them with the live lab,
    so the 'How Privilege is set up' slide is true on the day of the take. Needs PRIV_TENANT (not stored in this public repo) and the Privilege
    desktop app on this Mac; names are overridable. Returns (ok, notes, date) and never writes anything."""
    tenant = os.environ.get("PRIV_TENANT")
    if not tenant: return False, ["PRIV_TENANT is not set: the setup slide was not re-read"], None
    names = dict(nhi=os.environ.get("PRIV_NHI", "spiffe-issuer-lab-svid"), key=os.environ.get("PRIV_KEY", "spiffe-lab-svid"), grant=os.environ.get("PRIV_GRANT", "spiffe-lab-svid-aggregate-limited"))
    api = os.environ.get("CONSOLE_API")   # the Privilege desktop app's local console API origin; no default is kept in this public repo
    if not api: return False, ["CONSOLE_API is not set: the setup slide was not re-read"], None
    base = api.rstrip("/") + f"/api/{tenant}/v1/"
    b64 = lambda s: base64.b64encode(s.encode()).decode()
    cfg = info["config"]; notes = []; bad = []
    def get(path):
        req = urllib.request.Request(base + path, headers={"x-procyon-session-id": str(uuid.uuid4()), "accept": "application/json"})
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        for attempt in range(4):   # the Privilege desktop app's local API is sometimes slow to answer: retry, never relax the check
            try:
                with urllib.request.urlopen(req, timeout=25, context=ctx) as r: return json.loads(r.read().decode())
            except Exception:
                if attempt == 3: raise
                time.sleep(4)
    try:
        nhi = get("nonhumanidentities/default/" + names["nhi"])["Spec"]; key = get("agentaccesskeys/default/" + names["key"])["Spec"]; grant = get("pacpolicys/default/" + names["grant"])
    except Exception as e:
        return False, [f"console API not readable: {e}"], None
    f = nhi["Federation"]; now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    def chk(label, cond):
        (notes if cond else bad).append(("ok: " if cond else "MISMATCH: ") + label)
    chk("identity enabled", nhi.get("Enabled") is True)
    chk("identity issuer equals the lab's issuer", f.get("Issuer") == cfg["issuer"])
    chk("identity key list URL equals the lab's", f.get("JwksURI") == cfg["jwksUrl"])
    chk("identity audience equals the door URL", f.get("Audience") == cfg["audience"])
    chk("identity pins the valid SPIFFE ID (required claim sub)", (f.get("RequiredClaims", {}).get("Map", {}) or {}).get("sub") == cfg["validSub"])
    chk("identity max lifetime covers the token lifetime and is at most 300", cfg["ttlSeconds"] <= (f.get("MaxTokenLifetimeSec") or 3600) <= 300)
    chk("identity scope is mcp only", nhi.get("Scopes", {}).get("Elems") == ["mcp"])
    chk("identity not expired", (nhi.get("NotAfter") or "9999") > now)
    chk("key not revoked, not expired, scope mcp", key.get("Revoked") is False and (key.get("NotAfter") or "9999") > now and key.get("Scopes", {}).get("Elems") == ["mcp"])
    chk("key custodian is the identity", key.get("CustodianRef", {}).get("RefID") == b64(f"{tenant}@@@default@@@{names['nhi']}"))
    chk("key holds no secret (no VirtualKey)", not key.get("VirtualKey"))
    rule = grant["Spec"]["ActionMap"]["MCP"]["PolicyRule"][0]
    chk("grant is issued to the identity", [r.get("RefID") for r in grant.get("IssuedTo", {}).get("ObjectRef", [])] == [b64(f"{tenant}@@@default@@@{names['nhi']}")])
    chk("grant is on the lab's door", rule["ObjectRef"]["RefID"] == b64(f"{tenant}@@@default@@@{cfg['app']}"))
    chk("grant is current", (grant.get("NotAfter") or "9999") > now)
    return (not bad), notes + bad, time.strftime("%Y-%m-%d")

def main():
    WORK.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="spiffe-take-")
    # No "Save password?" bubble in the recording: switch the password manager off in this throw-away profile.
    (Path(profile) / "Default").mkdir(parents=True, exist_ok=True)
    (Path(profile) / "Default" / "Preferences").write_text(json.dumps({
        "credentials_enable_service": False, "credentials_enable_autosignin": False,
        "profile": {"password_manager_enabled": False}, "autofill": {"profile_enabled": False, "credit_card_enabled": False}}))
    base = APP.rstrip("/")
    result = {"ok": False, "checks": []}
    info = get_json(base + "/api/info")[1]
    jwks_url = (base + "/.well-known/jwks.json") if SAMPLE else info["config"]["jwksUrl"]
    pre_ok, pre_notes, published = preflight(info, jwks_url)
    result["checks"] += pre_notes; log("preflight:", pre_ok, pre_notes)
    if not pre_ok:
        (WORK / "result.json").write_text(json.dumps(result, indent=1)); print("preflight failed:", pre_notes); sys.exit(3)
    ttl = info["config"]["ttlSeconds"]; cfg = info["config"]
    con_ok, con_notes, con_date = console_check(info)
    result["checks"] += con_notes; log("console check:", con_ok, con_notes)
    if not con_ok and not SAMPLE:
        (WORK / "result.json").write_text(json.dumps(result, indent=1)); print("console check failed:", con_notes); sys.exit(3)
    setup_slide = dict(SLIDES["setup"])
    setup_slide["lead"] = fill(setup_slide["lead"], date=con_date or "an earlier day (the real take re-reads them)")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile, headless=HEADLESS, no_viewport=not HEADLESS, viewport={"width": WIN_W, "height": WIN_H} if HEADLESS else None,
            color_scheme="light", ignore_https_errors=True,
            **({"device_scale_factor": _prof["dsf"]} if HEADLESS else {}),   # the laptop is a retina display: render at 2x, record at 2400 px wide
            **({"record_video_dir": str(WORK / "pw-video"), "record_video_size": {"width": _prof["video"][0], "height": _prof["video"][1]}} if RECORD_PW else {}),
            args=[f"--window-position={WIN_X},{WIN_Y}", f"--window-size={WIN_W},{WIN_H}", "--no-first-run", "--no-default-browser-check", *([] if HEADLESS else ["--kiosk"])])
        T0 = time.monotonic()   # the Playwright video starts with the page: everything before the opening slide is trimmed off
        ctx.add_init_script("window.__cmScale = " + json.dumps(SCALE) + "; window.__cmRoot = " + json.dumps(ROOT_PX) + ";")
        ctx.add_init_script("window.__pillText = " + json.dumps("SAMPLE: mock stand-in, not a live run" if SAMPLE else "REAL RUN: real gateway, test tokens") + ";")
        ctx.add_init_script("try { localStorage.setItem('theme', %s); } catch (e) {}" % json.dumps(THEME))
        ctx.add_init_script(OVERLAY)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(base + "/"); page.wait_for_selector("[data-testid=mode-badge]"); page.wait_for_selector("[data-testid=token-valid]")
        if not HEADLESS:
            subprocess.run(["osascript", "-e", 'tell application "System Events" to set frontmost of (first process whose name is "Google Chrome for Testing") to true'], capture_output=True)
        page.bring_to_front(); page.wait_for_timeout(1500)

        if HEADLESS:
            DEV = None
        elif os.environ.get("CAPTURE_DEVICE"):
            DEV = os.environ["CAPTURE_DEVICE"]; log("capture device: forced via CAPTURE_DEVICE=", DEV)
        else:
            page.evaluate("""() => { document.body.style.setProperty('background', '#00FF00', 'important');
                document.body.style.setProperty('min-height', '100vh', 'important'); }""")
            page.wait_for_timeout(500)
            DEV = str(detect_capture_device(WORK))
            page.evaluate("() => { document.body.style.removeProperty('background'); document.body.style.removeProperty('min-height'); }")
            log("capture device: auto-detected", DEV, "for MONITOR=", MONITOR, "at", (WIN_X, WIN_Y))

        g = page.evaluate("() => ({screenX: window.screenX, screenY: window.screenY, outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio})")
        dpr = g["dpr"] or 1   # ffmpeg crops PHYSICAL pixels; window geometry is logical, so scale by devicePixelRatio
        g["crop"] = {"w": round(g["innerW"] * dpr), "h": round(g["innerH"] * dpr),
                     "x": round((g["screenX"] - ORIGIN_X) * dpr), "y": round((g["screenY"] - ORIGIN_Y + (g["outerH"] - g["innerH"])) * dpr)}
        (WORK / "ready.json").write_text(json.dumps(g)); log("ready", g)
        page.evaluate("o => window.__cm.cap(o)", dict(n=0, total=TOTAL, title="Test frame", text="This is the recording area. Nothing is being recorded yet.", target="[data-testid=mode-badge]"))
        if WAIT_GO:
            log("waiting for go.flag")
            while not (WORK / "go.flag").exists():
                if (WORK / "abort.flag").exists():
                    log("aborted"); ctx.close(); return
                time.sleep(0.5)
        else:
            page.wait_for_timeout(2000)
        page.evaluate("() => window.__cm.clear()")
        c = g["crop"]
        ff = None if HEADLESS else subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-framerate", "30", "-capture_cursor", "1",
                               "-pixel_format", "uyvy422", "-i", f"{DEV}:none", "-vf", f"crop={c['w']}:{c['h']}:{c['x']}:{c['y']}",
                               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-t", "900", str(WORK / "take.mp4")],
                              stdin=subprocess.PIPE, stderr=open(WORK / "ffmpeg.log", "w"))
        log("rehearsal" if REHEARSE else "sample recording started (playwright)" if SAMPLE else "recording started"); time.sleep(0.2 if REHEARSE else 1.5)
        shots = os.environ.get("REHEARSE_SHOTS")
        count = {"n": 0}
        slow = 0.04 if REHEARSE else 1

        def snap(name, pg=None):
            if REHEARSE and shots:
                (pg or page).wait_for_timeout(300); Path(shots).mkdir(parents=True, exist_ok=True)
                (pg or page).screenshot(path=str(Path(shots) / f"{name}.png"))

        def bubble(key, target=None, lines=None, secs=None, prefer=None, sample_key=None, place=None, pg=None, **vals):
            """One numbered caption. The number is counted here, so a conditional scene never leaves a gap."""
            pg = pg or page
            count["n"] += 1
            st = STEPS[sample_key] if (SAMPLE and sample_key) else STEPS[key]
            vals.setdefault("ttl", ttl)
            title, text = fill(st["title"], **vals), fill(st["text"], **vals)
            pg.evaluate("o => window.__cm.cap(o)", dict(n=count["n"], total=TOTAL, title=title, text=text, target=target, lines=lines, prefer=prefer, place=place))
            snap(f"step-{count['n']:02d}-{key}", pg)
            pg.wait_for_timeout(int((secs if secs is not None else hold(text + " ".join(lines or []))) * 1000 * slow))
            pg.evaluate("() => window.__cm.clear()")

        T = {}
        def show_slide(cfg, extra=0.0, name="slide"):
            page.evaluate("o => window.__cm.slide(o)", slide_payload(cfg))
            if name == "opening": T["open"] = time.monotonic()
            snap(name)
            page.wait_for_timeout(int(hold_slide(cfg, extra=extra) * 1000 * slow))
            page.evaluate("() => window.__cm.clear()")

        def tag(selector, ident):
            """Give the first match an id so a caption can point at it (the overlay targets by selector)."""
            page.evaluate("i => document.querySelectorAll('#' + i).forEach((e) => e.removeAttribute('id'))", ident)
            loc = page.locator(selector)
            if loc.count(): loc.first.evaluate("(e, i) => { e.id = i; }", ident)
            else: log("tag: nothing matches", selector)

        def tag_payload(card_testid, ident):
            """The decoded token's PAYLOAD block of one card (the box under the 'payload' heading)."""
            ok = page.evaluate("""([t, i]) => { const card = document.querySelector('[data-testid=' + t + ']'); if (!card) return false;
                const h = [...card.querySelectorAll('.jdec__h')].find((x) => /payload/i.test(x.textContent)); if (!h) return false;
                const box = h.nextElementSibling; if (!box) return false; document.querySelectorAll('#' + i).forEach((e) => e.removeAttribute('id')); box.id = i; return true; }""", [card_testid, ident])
            if not ok: log("payload block not found in", card_testid)
            return ok

        def read_card(testid):
            """The decoded header and payload rows of one token card, as shown on the page."""
            return page.evaluate("""t => { const card = document.querySelector('[data-testid=' + t + ']'); const out = {};
                card.querySelectorAll('.jdec__card .jform__row').forEach((r) => { const k = r.querySelector('dt'), v = r.querySelector('dd');
                    if (k && v && !(k.textContent.trim() in out)) out[k.textContent.trim()] = v.textContent.trim(); }); return out; }""", testid)

        def check_tokens():
            """What the captions say about the three tokens, checked on the decoded tokens that are on screen. Raises if any is untrue."""
            v, m, u = read_card("token-valid"), read_card("token-mismatched"), read_card("token-untrusted")
            num = lambda x: int(str(x).split()[0])
            problems = []
            if v.get("alg") != "RS256": problems.append("valid alg is not RS256")
            if v.get("kid") not in published: problems.append("valid kid is not in the published key list")
            if v.get("sub") != cfg["validSub"]: problems.append("valid sub is not the configured SPIFFE ID")
            if v.get("aud") != cfg["audience"] or v.get("iss") != cfg["issuer"]: problems.append("valid aud or iss differ from the configuration")
            if num(v.get("exp", 0)) - num(v.get("iat", 0)) != ttl: problems.append("valid exp - iat is not the configured lifetime")
            for k in ("alg", "kid", "iss", "aud", "iat", "exp"):
                if m.get(k) != v.get(k): problems.append(f"mismatched differs from valid in {k}")
            if m.get("sub") in (None, v.get("sub")): problems.append("mismatched sub equals valid sub")
            for k in ("alg", "iss", "aud", "sub", "iat", "exp"):
                if u.get(k) != v.get(k): problems.append(f"untrusted differs from valid in {k}")
            if u.get("kid") == v.get("kid") or u.get("kid") in published: problems.append("untrusted kid is published or equals the valid kid")
            if problems: raise RuntimeError("tokens are not as the captions say: " + "; ".join(problems))
            result["checks"].append("tokens as captioned: mismatched differs only in sub, untrusted only in kid (not published), exp - iat = %d s" % ttl)
            return num(v["exp"]) - num(v["iat"])

        ok = False
        try:
            if SAMPLE:   # the sample's private stand-in is in Mock mode already (services.sh); make sure the page agrees
                assert page.locator("[data-testid=mode-badge]").inner_text().strip().lower() == "mock", "sample must run in Mock mode"
            else:
                assert page.locator("[data-testid=mode-badge]").inner_text().strip().lower() == "real", "the real take must run in Real mode"
            page.wait_for_timeout(600)
            if page.evaluate("() => [...document.querySelectorAll('h2.card__title')].some((h) => /SPIRE server control/.test(h.textContent) && h.offsetParent !== null)"):
                raise RuntimeError("the SPIRE card is still visible (the take hides it)")
            show_slide(OPENING_SLIDE, extra=0.0, name="opening")
            page.evaluate("() => window.scrollTo(0, 0)")

            bubble("intro", "[data-testid=sim-banner]", sample_key="sample_intro", prefer="below")
            bubble("federation", "[data-testid=federation]", prefer="right")

            # The public key list, in its own tab, as the gateway sees it.
            # Same tab, so the one recording (Playwright records each tab as its own file) holds this scene too.
            page.goto(jwks_url); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(600)
            # Same JSON, indented and enlarged so it can be read on a recording (the browser's own viewer shows it on one line).
            page.evaluate("() => { const p = document.querySelector('pre'); if (p) { try { p.textContent = JSON.stringify(JSON.parse(p.textContent), null, 2); } catch (e) {} } document.body.style.zoom = '1.5'; }")
            page.wait_for_timeout(300)
            bubble("jwks", "pre", prefer="below")
            page.goto(base + "/"); page.wait_for_selector("[data-testid=token-valid]"); page.wait_for_timeout(800)

            # Fresh tokens now, so the decoded tokens on screen are well inside their lifetime when Present is pressed.
            page.click("[data-testid=mint]"); page.wait_for_timeout(1200)
            tok_ttl = check_tokens()
            tag_payload("token-valid", "cm-pay-valid")
            bubble("valid", "#cm-pay-valid", prefer="right", ttl=tok_ttl)
            tag_payload("token-mismatched", "cm-pay-mm")
            bubble("mismatched", "#cm-pay-mm", prefer="left")
            tag_payload("token-untrusted", "cm-pay-un")
            bubble("untrusted", "#cm-pay-un", prefer="left")
            show_slide(setup_slide, name="slide-setup")   # the live configuration, read from the console API (read-only) on the day

            page.locator("[data-testid=present]").scroll_into_view_if_needed()
            bubble("present", "[data-testid=present]", sample_key="sample_present", prefer="left")
            page.click("[data-testid=present]")
            page.wait_for_selector("[data-testid=results-table]", timeout=60000); page.wait_for_timeout(1000)
            rows = {}
            for rid in ("valid", "mismatched", "untrusted"):
                rows[rid] = dict(status=page.locator(f"[data-testid=status-{rid}]").inner_text().strip(), words=page.locator(f"[data-testid=words-{rid}]").inner_text().strip())
            statuses = [rows[r]["status"] for r in ("valid", "mismatched", "untrusted")]
            result["rows"] = rows
            as_designed = page.locator("[data-testid=results-table] .chip--ok").count() == 3
            result["checks"].append(f"statuses {statuses}, all as designed: {as_designed}")
            m = re.search(r"returned (\d+) tool", rows["valid"]["words"])
            tools = m.group(1) if m else "?"
            if not SAMPLE and not m: raise RuntimeError("valid row does not say how many tools came back: " + rows["valid"]["words"][:120])
            if statuses != [str(s) for s in EXPECT_STATUS] or not as_designed:
                log("NOT AS DESIGNED: the take will not claim success", statuses); raise RuntimeError(f"gateway answers {statuses} are not 200/401/401")
            if not SAMPLE and not rows["valid"]["words"].lower().startswith("accepted"):
                raise RuntimeError("valid row does not say accepted: " + rows["valid"]["words"])
            clean = lambda w: re.sub(r"\s*(REAL|MOCK)\s*$", "", w).strip().rstrip(".")
            refused_words = clean(rows["mismatched"]["words"])
            if not SAMPLE and (clean(rows["untrusted"]["words"]) != refused_words or len(refused_words) > 60):
                raise RuntimeError("the two refused rows do not read the same, or are too long for a caption: %r vs %r" % (refused_words, clean(rows["untrusted"]["words"])))
            page.locator("table.results").scroll_into_view_if_needed()
            bubble("valid_result", "[data-testid=row-valid]", sample_key="sample_valid_result", prefer="below", status=statuses[0], tools=tools)
            bubble("refused", "table.results", sample_key="sample_refused", prefer="below", words=refused_words)

            # The request as sent: open the Valid exchange of the trace.
            first = page.locator("details.gw-ex").first
            if not first.count() or "valid token" not in first.locator(":scope > summary").inner_text().lower():
                raise RuntimeError("the first trace exchange is missing or is not the Valid token's")
            if first.count():
                # All exchanges start open: keep the Valid one (first) open and fold the others so it is the one on screen.
                page.evaluate("() => document.querySelectorAll('details.gw-ex').forEach((d, i) => { d.open = i === 0; })")
                first.scroll_into_view_if_needed(); page.wait_for_timeout(500)
                io = first.locator(".gw-io")
                if io.count(): io.first.evaluate("e => { e.id = 'cm-io'; }")
                bubble("trace", "#cm-io", sample_key="sample_trace", prefer="left")
            if count["n"] != TOTAL: raise RuntimeError("%d caption bubbles were shown but the counter says %d" % (count["n"], TOTAL))
            page.evaluate("() => window.__cm.clear()")
            closing = dict(CLOSING_SLIDE)
            if SAMPLE:   # the sample never claims a live run
                closing["lead"] = STEPS["sample_closing_lead"]["text"]
                closing["col_a_lines"] = [*CLOSING_SLIDE["col_a_lines"][:2], STEPS["sample_closing_bullet"]["text"]]   # the sample never says it got 200 from a gateway
            show_slide(closing, extra=0.0, name="closing")
            ok = True
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"; log("FAILED:", result["error"])
        finally:
            result["ok"] = ok
            log("stopping recording")
            if ff is not None:
                try: ff.send_signal(signal.SIGINT)
                except Exception: pass
                try: ff.wait(timeout=30)
                except Exception: ff.kill()
            if ff is not None and ok:   # the screen capture must still be running and have produced a real file
                if ff.poll() is not None and ff.returncode not in (0, 255, -2): ok = False; result["error"] = "ffmpeg exited early: %s" % ff.returncode
                vf = WORK / "take.mp4"
                if not vf.exists() or vf.stat().st_size < 200_000: ok = False; result["error"] = "take.mp4 is missing or too small"
                result["ok"] = ok
            (WORK / "result.json").write_text(json.dumps(result, indent=1))
            (WORK / "done.flag").write_text("done")
        vpath = page.video.path() if RECORD_PW and page.video else None
        ctx.close()
        if vpath:
            out = WORK / (("sample-%s.mp4" if SAMPLE else "take-%s.mp4") % PROFILE)
            trim = max(0.0, T.get("open", T0) - T0 - 0.1)   # cut the pre-roll: the video starts on the opening slide
            log("trim pre-roll: %.2fs" % trim)
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(vpath), "-ss", "%.2f" % trim, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(out)], check=True)
            log("video:", out)
        print("ok" if ok else "FAILED: " + result.get("error", "?"))
        sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
