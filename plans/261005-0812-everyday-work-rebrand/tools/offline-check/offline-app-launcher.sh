#!/bin/sh
# What WebKitWebDriver starts as the "application": the installed app in $HOME,
# as a desktop launcher would, with its default profile. --automation passes through.
set -eu
cd "$HOME"
exec /usr/bin/sai-atlas "$@"
