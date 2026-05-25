#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

MODE="${1:-focused}"
IMAGE="${WORKSPACE_TRUST_SMOKE_IMAGE:-oven/bun:1.3.11}"
NODE_MODULES_VOLUME="${WORKSPACE_TRUST_SMOKE_NODE_MODULES_VOLUME:-ato-workspace-trust-node-modules}"
BUN_CACHE_VOLUME="${WORKSPACE_TRUST_SMOKE_BUN_CACHE_VOLUME:-ato-workspace-trust-bun-cache}"
RED_GREEN_TEMP_DIR=''
RED_GREEN_PRE_FIX_REPO=''

FOCUSED_TEST_COMMAND='bun test src/utils/config.workspaceTrust.test.ts src/services/codexNative/workspaceTrustConfigOverrides.test.ts src/services/opencode/OpenCodePermissionNormalizer.test.ts src/utils/swarm/teammateRuntimeEvents.test.ts && bun test src/services/teamBootstrap/teamBootstrapProcessBackend.e2e.test.ts -t "cwd is not a directory|git worktree|workspace trust is missing"'
FULL_TEST_COMMAND='bun test src/utils/config.workspaceTrust.test.ts src/services/codexNative/workspaceTrustConfigOverrides.test.ts src/services/opencode/OpenCodePermissionNormalizer.test.ts src/utils/swarm/teammateRuntimeEvents.test.ts src/services/teamBootstrap/teamBootstrapProcessBackend.e2e.test.ts'

case "${MODE}" in
  focused)
    TEST_COMMAND="${FOCUSED_TEST_COMMAND}"
    ;;
  full)
    TEST_COMMAND="${FULL_TEST_COMMAND}"
    ;;
  red-green)
    TEST_COMMAND=''
    ;;
  *)
    cat >&2 <<EOF
Usage: $0 [focused|full|red-green]

focused    Runs workspace trust unit tests and the targeted process-backend e2e cases.
full       Runs workspace trust unit tests and the full process-backend e2e file.
red-green  Copies the regression tests into a clean pre-fix git worktree, expects
           them to fail there, then runs the focused suite against this checkout.

Environment overrides:
  WORKSPACE_TRUST_SMOKE_IMAGE
  WORKSPACE_TRUST_SMOKE_NODE_MODULES_VOLUME
  WORKSPACE_TRUST_SMOKE_BUN_CACHE_VOLUME
  WORKSPACE_TRUST_REPRO_BASE_REF
EOF
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo 'docker is required for workspace trust smoke tests.' >&2
  exit 127
fi

DOCKER_ARGS=(run --rm)
if [[ -t 1 ]]; then
  DOCKER_ARGS+=(-t)
fi

run_in_docker() {
  local source_repo="$1"
  local command="$2"
  local node_modules_volume="$3"

  docker "${DOCKER_ARGS[@]}" \
    --mount "type=bind,source=${source_repo},target=/repo-source,readonly" \
    --mount "type=volume,source=${node_modules_volume},target=/repo/node_modules" \
    --mount "type=volume,source=${BUN_CACHE_VOLUME},target=/root/.bun/install/cache" \
    -w /repo \
    -e CI=1 \
    -e NODE_ENV=test \
    "${IMAGE}" \
    bash -lc "mkdir -p /repo && tar -C /repo-source --exclude='./node_modules' --exclude='./.git' -cf - . | tar -C /repo -xf - && bun install --frozen-lockfile && ${command}"
}

run_red_green() {
  local base_ref="${WORKSPACE_TRUST_REPRO_BASE_REF:-HEAD}"
  RED_GREEN_TEMP_DIR="$(mktemp -d)"
  RED_GREEN_PRE_FIX_REPO="${RED_GREEN_TEMP_DIR}/pre-fix"

  cleanup() {
    if [[ -n "${RED_GREEN_PRE_FIX_REPO:-}" ]]; then
      git -C "${REPO_ROOT}" worktree remove --force "${RED_GREEN_PRE_FIX_REPO}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${RED_GREEN_TEMP_DIR:-}" ]]; then
      rm -rf "${RED_GREEN_TEMP_DIR}"
    fi
  }
  trap cleanup EXIT

  echo "Preparing pre-fix worktree from ${base_ref}"
  git -C "${REPO_ROOT}" worktree add --detach "${RED_GREEN_PRE_FIX_REPO}" "${base_ref}" >/dev/null
  cp "${REPO_ROOT}/src/utils/config.workspaceTrust.test.ts" \
    "${RED_GREEN_PRE_FIX_REPO}/src/utils/config.workspaceTrust.test.ts"
  cp "${REPO_ROOT}/src/services/teamBootstrap/teamBootstrapProcessBackend.e2e.test.ts" \
    "${RED_GREEN_PRE_FIX_REPO}/src/services/teamBootstrap/teamBootstrapProcessBackend.e2e.test.ts"

  echo "Red phase: expecting the copied regression test to fail on ${base_ref}"
  set +e
  local red_output
  red_output="$(
    run_in_docker \
      "${RED_GREEN_PRE_FIX_REPO}" \
      'unit_status=0; e2e_status=0; echo "Red unit check"; bun test src/utils/config.workspaceTrust.test.ts || unit_status=$?; echo "Red e2e check"; bun test src/services/teamBootstrap/teamBootstrapProcessBackend.e2e.test.ts -t "git worktree" || e2e_status=$?; if [[ "${unit_status}" -eq 0 || "${e2e_status}" -eq 0 ]]; then echo "Expected both red checks to fail."; exit 1; fi; exit 42' \
      "${NODE_MODULES_VOLUME}-red" 2>&1
  )"
  local red_status=$?
  set -e
  printf '%s\n' "${red_output}"
  if [[ "${red_status}" -ne 42 ]]; then
    echo "Expected the pre-fix worktree to fail in both red checks, but got status ${red_status}." >&2
    exit 1
  fi
  if ! grep -Fq 'trusts a valid git worktree when Claude persisted trust under the canonical repo root' <<<"${red_output}"; then
    echo "The pre-fix failure did not include the workspace trust regression test." >&2
    exit 1
  fi
  if ! grep -Fq 'launches from a git worktree when trust is stored under the canonical repo root' <<<"${red_output}"; then
    echo "The pre-fix failure did not include the workspace trust e2e regression test." >&2
    exit 1
  fi
  echo "Red phase reproduced the workspace trust regression."

  echo "Green phase: expecting this checkout to pass the focused suite"
  run_in_docker "${REPO_ROOT}" "${FOCUSED_TEST_COMMAND}" "${NODE_MODULES_VOLUME}"
}

echo "Running workspace trust smoke (${MODE}) in ${IMAGE}"
echo "Repository: ${REPO_ROOT}"

if [[ "${MODE}" == 'red-green' ]]; then
  run_red_green
else
  run_in_docker "${REPO_ROOT}" "${TEST_COMMAND}" "${NODE_MODULES_VOLUME}"
fi
