#!/usr/bin/env bash
set -e

claude-manager daemon stop 2>/dev/null || true
sleep 1
pkill -9 -f "manager/daemon.ts|spawner/worker.ts|orchestrator-mcp.ts|worker-mcp.ts|claude --settings" 2>/dev/null || true
sleep 1
rm -f ~/.claude-mgr/state.db* ~/.claude-mgr/daemon.pid
claude-manager daemon start &
sleep 2
claude-manager daemon status
