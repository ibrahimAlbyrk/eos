# Source this: where a development run keeps its private data and which isolated Node daemon
# it talks to. Every value can be set from outside, so several people (or agents) can run
# side by side without sharing a data folder or a port.
#
#   EOS_DEV_DATA       private data root (default: eos-rs-data next to the worktrees)
#   EOS_DEV_HOME       the isolated daemon's data folder, a COPY of real data
#                      (default: $EOS_DEV_DATA/run-shell)
#   EOS_DEV_OUT        logs, the shell's data folder, test output (default: $EOS_DEV_DATA/shell-out)
#   EOS_DEV_PORT       the daemon's API port (default 7490); EOS_DEV_RAW_PORT its raw-content
#                      port (default: the next one)
#   EOS_DEV_WORKER_PORTS  the port range the daemon may give workers (default 7600-7650)
export EOS_DEV_DATA="${EOS_DEV_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
export EOS_DEV_HOME="${EOS_DEV_HOME:-$EOS_DEV_DATA/run-shell}"
export EOS_DEV_OUT="${EOS_DEV_OUT:-$EOS_DEV_DATA/shell-out}"
export EOS_DEV_PORT="${EOS_DEV_PORT:-7490}"
export EOS_DEV_RAW_PORT="${EOS_DEV_RAW_PORT:-$((EOS_DEV_PORT + 1))}"
export EOS_DEV_WORKER_PORTS="${EOS_DEV_WORKER_PORTS:-7600-7650}"
