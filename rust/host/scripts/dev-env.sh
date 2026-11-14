# Source this: where a development or test run keeps its private data. Every value can be set
# from outside, so several people (or agents) can run side by side without sharing a data
# folder.
#
#   EOS_DEV_DATA   private data root (default: eos-rs-data next to the worktrees); its `home`
#                  is the sanitized data folder every run copies
#   EOS_DEV_HOME   the data folder a run opens, a COPY of real data, made from
#                  $EOS_DEV_DATA/home when missing (default: $EOS_DEV_DATA/run-shell)
#   EOS_DEV_OUT    logs, the shell's data folder, test output (default: $EOS_DEV_DATA/shell-out)
export EOS_DEV_DATA="${EOS_DEV_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
export EOS_DEV_HOME="${EOS_DEV_HOME:-$EOS_DEV_DATA/run-shell}"
export EOS_DEV_OUT="${EOS_DEV_OUT:-$EOS_DEV_DATA/shell-out}"
