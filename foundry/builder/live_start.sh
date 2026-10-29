#!/bin/bash
# Foundry live stack supervisor: Xvfb + Blender GUI (exec server)
# + x11vnc + websockify/noVNC. Run by foundry-live.service.
export DISPLAY=:99
export HOME=/home/caseydigennaro
B=/home/caseydigennaro/foundry/builder
LOG=$B/live.log
mkdir -p "$B"
echo "=== live stack start $(date) ===" >>"$LOG"

if [ ! -e /tmp/.X11-unix/X99 ]; then
  Xvfb :99 -screen 0 1600x1000x24 -ac >>"$LOG" 2>&1 &
fi
sleep 2
pgrep -f "x11vnc -display :99" >/dev/null ||
  x11vnc -display :99 -rfbport 5900 -forever -shared -nopw -quiet >>"$LOG" 2>&1 &
pgrep -f "websockify.*6080" >/dev/null ||
  websockify --web /usr/share/novnc 6080 localhost:5900 >>"$LOG" 2>&1 &

probe() {
  python3 - <<'PYEOF'
import socket, sys
try:
    with socket.create_connection(("127.0.0.1", 8377), timeout=3) as s:
        s.sendall(b'{"ping": true}\n')
        s.settimeout(4)
        buf = s.recv(512)
    sys.exit(0 if b'"ok": true' in buf else 1)
except Exception:
    sys.exit(1)
PYEOF
}

while true; do
  /usr/bin/blender -noaudio --python "$B/live_boot.py" >>"$LOG" 2>&1 &
  BPID=$!
  fails=0
  sleep 25
  while kill -0 $BPID 2>/dev/null; do
    sleep 30
    if probe; then fails=0; else fails=$((fails + 1)); fi
    if [ $fails -ge 3 ]; then
      echo "watchdog: live blender wedged (3 failed pings) — restarting" >>"$LOG"
      kill $BPID 2>/dev/null
      sleep 2
      kill -9 $BPID 2>/dev/null
      break
    fi
  done
  wait $BPID 2>/dev/null
  echo "watchdog: blender exited — restarting in 3s" >>"$LOG"
  sleep 3
done
