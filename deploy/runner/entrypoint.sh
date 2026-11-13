#!/bin/sh
# Virtual display, VNC on loopback only (password required), noVNC on loopback,
# then the runner. A person reaches noVNC through
# an SSH forward; nothing here is exposed beyond the host.
set -eu
: "${RUNNER_VNC_PASSWORD:?RUNNER_VNC_PASSWORD is required}"
umask 077
vnc_dir=$(mktemp -d)
x11vnc -storepasswd "$RUNNER_VNC_PASSWORD" "$vnc_dir/passwd" >/dev/null 2>&1
unset RUNNER_VNC_PASSWORD
# Host networking shares X's abstract sockets with the host, so the display
# number must not collide with any display on the host.
export DISPLAY="${RUNNER_DISPLAY:-:47}"
Xvfb "$DISPLAY" -screen 0 1280x860x24 -nolisten tcp &
sleep 1
# x11vnc walks every possible file descriptor; under the container's ~1e9
# open-file limit it spins at full CPU and never accepts a connection.
(ulimit -n 4096 && exec x11vnc -display "$DISPLAY" -localhost -rfbport "${RUNNER_VNC_PORT:-5930}" -rfbauth "$vnc_dir/passwd" -forever -shared -quiet -bg -o /dev/null)
websockify --web /usr/share/novnc "127.0.0.1:${RUNNER_NOVNC_PORT:-6080}" "127.0.0.1:${RUNNER_VNC_PORT:-5930}" >/dev/null 2>&1 &
exec node dist/runner/main.js
