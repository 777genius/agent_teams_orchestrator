#!/usr/bin/env bash
# Real OpenCode V2 execution on Linux in CI, without model requests or credentials.
#
# Why this lane exists: until 2026-10-25 no CI job could start a V2 child on Linux. The
# launcher accepted only bubblewrap 0.13.0, the runners ship none, and ubuntu-24.04 denies
# bwrap its user namespace through AppArmor. So when the host began sending the 240s catalog
# lease deadline to the child as its activation deadline (36a214fe), the Linux child, whose
# ceiling is 90s, refused every provider connect, model test and catalog read with
# execution_identity_mismatch, and every Linux check stayed green. The child-side contract
# test covered only the darwin ceiling. Here every qualified linux-x64 version starts the
# packaged V2 catalog server inside the real sandbox.
#
# Usage: opencode-v2-linux-execution.sh <packaged dist directory>
set -euo pipefail
DIST=$(realpath "${1:?packaged dist directory}")
REPO=$(realpath "$(dirname "$0")/../..")
OUT="${RUNNER_TEMP:?}/TEST-opencode-v2-linux"
mkdir -p "$OUT"
BWRAP_VERSION=0.13.1
BWRAP_SHA256=0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d
# The kernel fixture pins the Bun 1.3.11 linux-x64 binary; this is its release archive.
BUN_ZIP_SHA256=8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed

echo "::group::bubblewrap $BWRAP_VERSION at /usr/bin/bwrap"
sudo apt-get update -qq
sudo apt-get install -y -qq meson ninja-build libcap-dev pkg-config >/dev/null
src="$OUT/bubblewrap-$BWRAP_VERSION"
mkdir -p "$src"
curl -fsSL --retry 3 -o "$src.tar.xz" "https://github.com/containers/bubblewrap/releases/download/v$BWRAP_VERSION/bubblewrap-$BWRAP_VERSION.tar.xz"
echo "$BWRAP_SHA256  $src.tar.xz" | sha256sum -c -
tar -xf "$src.tar.xz" -C "$src" --strip-components=1
(cd "$src" && meson setup build --buildtype=release -Dtests=false >/dev/null && ninja -C build bwrap >/dev/null)
sudo install -m 0755 -o root -g root "$src/build/bwrap" /usr/bin/bwrap
/usr/bin/bwrap --version
echo "::endgroup::"

# The profile from docs/opencode-v2-qualification/linux-sandbox.md. The userns
# restriction itself stays on, as on a stock Ubuntu 24.04 machine.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
    'profile TEST-opencode-v2-bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '}' \
    | sudo tee /etc/apparmor.d/TEST-opencode-v2-bwrap >/dev/null
  sudo apparmor_parser -r /etc/apparmor.d/TEST-opencode-v2-bwrap
  echo "kernel.apparmor_restrict_unprivileged_userns=1 kept; /usr/bin/bwrap profile loaded"
fi

echo "::group::kernel containment fixture"
curl -fsSL --retry 3 -o "$OUT/bun-linux-x64.zip" https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip
echo "$BUN_ZIP_SHA256  $OUT/bun-linux-x64.zip" | sha256sum -c -
(cd "$OUT" && unzip -q -o bun-linux-x64.zip)
"$OUT/bun-linux-x64/bun" "$REPO/src/services/opencode/host/fixtures/linuxKernelQualification.ts" "$OUT/TEST-kernel"
echo "::endgroup::"

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
  echo "::group::V2 $version catalog read inside the sandbox"
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
    echo "V2 $version: catalog server started in the sandbox"
  else
    echo "::error::V2 $version catalog read failed (exit $code)"; tail -20 "$w/models.stderr" || true
    failed=1
  fi
  find "$w/home" -path '*provider-diagnostics*' -name '*.json' -exec cat {} \; 2>/dev/null || true
  echo "::endgroup::"
done
exit "$failed"
