#!/usr/bin/env bash
# Real OpenCode V2 execution on Linux in CI, without model requests or credentials.
#
# Why this lane exists: when the host began sending the 240s catalog lease deadline to the
# child as its activation deadline (36a214fe), the Linux child, whose ceiling is 90s,
# refused every provider connect, model test and catalog read with
# execution_identity_mismatch, and every Linux check stayed green because no CI job
# started a V2 child on Linux. Here every qualified linux-x64 version starts the packaged
# V2 catalog server and reports provider status.
#
# Usage: opencode-v2-linux-execution.sh <packaged dist directory>
set -euo pipefail
DIST=$(realpath "${1:?packaged dist directory}")
REPO=$(realpath "$(dirname "$0")/../..")
OUT="${RUNNER_TEMP:?}/TEST-opencode-v2-linux"
mkdir -p "$OUT"

# The packaged delivery, laid out as the release archive.
runtime="$OUT/runtime"
mkdir -p "$runtime"
cp "$DIST/cli" "$runtime/claude-multimodel"
cp "$DIST/opencode-delivery.json" "$runtime/"
cp -R "$DIST/local-cli" "$DIST/bun" "$DIST/cursor-managed" "$runtime/"

versions=$(node -e '
  const records = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).versions
  console.log(records.filter(record => record.platforms.includes("linux-x64")).map(record => record.version).join(" "))
' "$REPO/src/services/opencode/compatibility/opencode-v2-qualifications.json")
[ -n "$versions" ] || { echo "no linux-x64 qualified V2 version"; exit 1; }

failed=0
for version in $versions; do
  echo "::group::V2 $version catalog read and provider status"
  w="$OUT/TEST-v2-$version"
  mkdir -p "$w/home" "$w/project"
  npm install --prefix "$w/oc" --ignore-scripts --no-audit --no-fund "@opencode/cli-linux-x64@$version" >/dev/null
  oc="$w/oc/node_modules/@opencode/cli-linux-x64/bin/opencode"
  "$oc" --version
  git -C "$w/project" init -q
  set +e
  env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 HOME="$w/home" TMPDIR="$w/home" \
    XDG_CONFIG_HOME="$w/home/.config" XDG_DATA_HOME="$w/home/.local/share" \
    XDG_CACHE_HOME="$w/home/.cache" XDG_STATE_HOME="$w/home/.local/state" \
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH="$oc" \
    "$runtime/claude-multimodel" runtime providers models --runtime opencode --provider opencode \
      --project-path "$w/project" --limit 5 --json >"$w/models.json" 2>"$w/models.stderr"
  code=$?
  set -e
  # A started catalog server answers with models; any refusal returns an error object.
  if node -e '
    const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")), view = result.models
    console.log(JSON.stringify({ error: result.error ?? null, totalCount: view?.totalCount ?? null,
      returnedCount: view?.returnedCount ?? null, catalogState: view?.catalogState ?? null }))
    process.exit(result.error || !Array.isArray(view?.models) ? 1 : 0)
  ' "$w/models.json" && [ "$code" -eq 0 ]; then
    echo "V2 $version: catalog server started"
  else
    echo "::error::V2 $version catalog read failed (exit $code)"; tail -20 "$w/models.stderr" || true
    failed=1
  fi
  # The provider status reads the catalog through the same packaged runtime.
  set +e
  (cd "$w/project" && env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 HOME="$w/home" TMPDIR="$w/home" \
    XDG_CONFIG_HOME="$w/home/.config" XDG_DATA_HOME="$w/home/.local/share" \
    XDG_CACHE_HOME="$w/home/.cache" XDG_STATE_HOME="$w/home/.local/state" \
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH="$oc" \
    "$runtime/claude-multimodel" runtime status --provider opencode --json >"$w/status.json" 2>"$w/status.stderr")
  set -e
  if node -e '
    const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")), providers = payload.providers
    const status = Array.isArray(providers) ? providers.find(row => row.providerId === "opencode") : providers?.opencode
    console.log(JSON.stringify({ supported: status?.supported ?? null, statusCheckOutcome: status?.statusCheckOutcome ?? null,
      statusMessage: status?.statusMessage ?? null, detailMessage: status?.detailMessage ?? null }))
    process.exit(status?.supported === true && status.statusCheckOutcome === "model_only" ? 0 : 1)
  ' "$w/status.json"; then
    echo "V2 $version: provider status reports the catalog"
  else
    echo "::error::V2 $version provider status is not ready"; tail -20 "$w/status.stderr" || true
    failed=1
  fi
  find "$w/home" -path '*provider-diagnostics*' -name '*.json' -exec cat {} \; 2>/dev/null || true
  echo "::endgroup::"
done
exit "$failed"
