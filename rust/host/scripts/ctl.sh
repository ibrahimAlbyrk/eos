#!/bin/bash
# Talks to the running app over its single-instance socket: `ctl.sh --status`, `ctl.sh --quit`,
# `ctl.sh eos://pair/…`, or no argument to show the window. Prints the app's one-line answer.
#
#   usage: ctl.sh <path to Eos.app> [--status|--quit|eos://…]
set -euo pipefail
APP="$1"; shift
DATA="${EOS_DEV_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
EOS_SHELL_DATA="${EOS_SHELL_DATA:-$DATA/shell-out/data}" exec "$APP/Contents/MacOS/Eos" "$@"
