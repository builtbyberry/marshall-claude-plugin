#!/usr/bin/env bash
# Surface Marshall store connection at session start — but ONLY for repos that opt
# into Marshall (state.backend = "srm" in release-config.json — the value keeps
# its old name because it lives in repos' tracked config). For every other repo
# this stays completely silent, so it never nags unrelated projects.
#
# The CLI resolves everything itself: the store URL and project from the repo's
# release-config.json (falling back to the hosted store), and the token from
# `marshall login` or MARSHALL_TOKEN. This hook passes nothing in.
#
# It used to export CLAUDE_PLUGIN_OPTION_MARSHALL_URL / _TOKEN, but 0.8.1 removed the
# manifest's `userConfig` block when the MCP url was hardcoded, so those variables
# have been unset ever since — the exports were reading a mechanism that no longer
# exists and always resolved to empty.
set -uo pipefail

# The agent talks to Marshall over MCP; this hook is just an optional readiness ping
# via the secondary CLI. No CLI on PATH → say nothing.
command -v marshall >/dev/null 2>&1 || exit 0

# --require-repo is what keeps this silent outside Marshall repos. It used to be
# implicit: `marshall me` itself refused unless the repo opted in. That gate was
# removed because it made the CLI's own first run baffling (install, sign in, ask
# who you are, get told about a release-config.json you have never seen) — so the
# hook now asks for it explicitly. Without this flag, a signed-in user would be
# greeted in every repo on the machine.
#
# Non-zero here means any of: this repo doesn't use Marshall, not signed in, or
# the store is unreachable. All of them mean the same thing to us: say nothing.
if who="$(marshall me --require-repo 2>/dev/null)"; then
  printf '{"additionalContext":"Marshall store connected as %s. Use /release-status or /release-next."}\n' "$who"
fi

exit 0
