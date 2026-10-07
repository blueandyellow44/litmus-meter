#!/usr/bin/env bash
# One-time setup: creates the Cloudflare Pages project and the KV namespace,
# and writes the namespace id into wrangler.toml. Run from the repo root.
# Does not deploy and does not set secrets; README.md lists those commands.
set -euo pipefail

cd "$(dirname "$0")/.."

npx wrangler pages project create litmus-meter --production-branch main

out=$(npx wrangler kv namespace create METER_KV)
echo "$out"
id=$(printf '%s\n' "$out" | grep -Eo '[0-9a-f]{32}' | head -1)
if [ -z "$id" ]; then
  echo "Could not read the KV namespace id from wrangler's output. Paste it into wrangler.toml by hand." >&2
  exit 1
fi

sed -i.bak -E "s/^id = \"[0-9a-f]{32}\"/id = \"$id\"/" wrangler.toml && rm wrangler.toml.bak
echo "wrangler.toml now binds METER_KV to $id"
