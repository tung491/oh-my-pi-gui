#!/bin/sh
# What WebKitWebDriver starts as the "application": the installed app under
# strace, so every connect() of the app and of every child it starts (sidecar,
# supervisor, tools, WebKit's processes) lands in one trace. -ttt stamps each
# line with epoch seconds (the timeline uses the same clock), -Y adds the
# process name to each pid. The app starts in $HOME, as a desktop launcher
# would, with its default profile and the seeded ~/.omp; WebDriver appends
# --automation, which passes through.
set -eu
out=${EGRESS_OUT:?EGRESS_OUT is not set}
cd "$HOME"
exec strace -f -ttt -Y -e trace=connect,sendto,sendmsg -o "$out/egress-app.txt" /usr/bin/sai-atlas "$@"
