#!/usr/bin/env bash
# Starts/stops a private MOCK instance of the lab for the sample video: the lab's own image, no .env, no gateway, fresh throw-away keys,
# on port 17839 (the live lab is 7829), so it never touches a running lab. Only .example hosts are set, and the mode is switched to Mock.
# Usage: video/services.sh start|stop   (any directory). Needs Docker (OrbStack) and the lab image (docker compose build in the repo root).
set -euo pipefail
NAME=spiffe-video-mock; PORT=17839; IMAGE="${LAB_IMAGE:-spiffe-issuer-spiffe-issuer}"
case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:7828" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --tmpfs /data:rw,mode=1777 -e PORT=7828 -e PUBLIC_URL=https://issuer.example -e SPIFFE_GW_URL=https://gateway.example -e SPIFFE_GW_APPS=aggregate-limited "$IMAGE" >/dev/null
    for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.5; done
    curl -fs -X POST -H 'content-type: application/json' -H "Origin: http://127.0.0.1:$PORT" -d '{"source":"mock"}' "http://127.0.0.1:$PORT/api/mode" >/dev/null
    curl -fs "http://127.0.0.1:$PORT/api/info" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['source']=='mock'; print('mock lab up on http://127.0.0.1:$PORT (source=mock)')" ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 || true; echo stopped ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
