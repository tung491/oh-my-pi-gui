#!/usr/bin/env bash
# Module gate for the Tauri port. Usage: bash scripts/check-module.sh <module>
# Modules: foundation, omp, tabs, desktop, services, ollama, updater, renderer.
# `snapshots` instead runs only the whole-tree gate that needs no merge base: every
# src-tauri/contracts/*.api.txt against `cargo public-api` (CI runs it on every branch).
# Stops at the first failing gate and prints `check-module <module>: PASS` last on success.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MODULE="${1:-}"
case "$MODULE" in
  foundation|omp|tabs|desktop|services|ollama|updater|renderer|snapshots) ;;
  *) echo "usage: bash scripts/check-module.sh <foundation|omp|tabs|desktop|services|ollama|updater|renderer|snapshots>" >&2; exit 2 ;;
esac

# --- toolchain --------------------------------------------------------------
# An explicit CARGO_HOME_BIN in the environment wins over the pins file.
ENV_CARGO_HOME_BIN="${CARGO_HOME_BIN:-}"
# shellcheck disable=SC1091
source "$ROOT/scripts/rust-pins.env"
CARGO_HOME_BIN="${ENV_CARGO_HOME_BIN:-${CARGO_HOME_BIN:?CARGO_HOME_BIN missing from scripts/rust-pins.env}}"
export PATH="$CARGO_HOME_BIN:$PATH"
# bun lives outside the system PATH on developer machines; find it the same way.
if ! command -v bun >/dev/null 2>&1; then
  for candidate in "$HOME/.bun/bin" /usr/local/bin /opt/homebrew/bin; do
    if [[ -x "$candidate/bun" ]]; then export PATH="$candidate:$PATH"; break; fi
  done
fi
command -v bun >/dev/null 2>&1 || { echo "bun is missing; install it from https://bun.sh" >&2; exit 1; }
CARGO="$CARGO_HOME_BIN/cargo"
if ! "$CARGO" tauri --version 2>/dev/null | grep -q '^tauri-cli 2\.'; then
  echo 'cargo tauri is missing; run ~/.cargo/bin/cargo install tauri-cli --version "^2" --locked' >&2
  exit 1
fi
MANIFEST="src-tauri/Cargo.toml"

fail() { echo "check-module $MODULE: FAIL (gate $1): $2" >&2; exit 1; }
warn() { echo "check-module $MODULE: WARN (gate $1): $2" >&2; }
step() { echo "== gate $1: $2"; }

# --- owned paths ------------------------------------------------------------
case "$MODULE" in
  foundation)
    OWNED=(
      "src-tauri/Cargo.toml" "src-tauri/Cargo.lock" "src-tauri/build.rs" "src-tauri/tauri.conf.json" "src-tauri/rust-toolchain.toml"
      "src-tauri/capabilities/" "src-tauri/contracts/" "src-tauri/tests/" "src-tauri/icons/"
      "src-tauri/src/main.rs" "src-tauri/src/lib.rs" "src-tauri/src/ctx.rs" "src-tauri/src/ports.rs" "src-tauri/src/bridge.rs"
      "src-tauri/src/webview.rs" "src-tauri/src/prefs.rs" "src-tauri/src/paths.rs" "src-tauri/src/product.rs" "src-tauri/src/i18n.rs"
      "src-tauri/src/runtime_log.rs" "src-tauri/src/testing.rs" "src-tauri/src/test_hooks.rs"
      "src-tauri/src/omp/" "src-tauri/src/tabs/" "src-tauri/src/desktop/" "src-tauri/src/services/" "src-tauri/src/ollama/" "src-tauri/src/updater/"
      "scripts/check-module.sh" "scripts/tauri-dev.ts" "scripts/rust-pins.env"
      "src/shared/bridge/" "src/renderer/boot/" "src/renderer/styles/first-paint.css"
      "src/renderer/main.tsx" "src/renderer/quick-entry/main.tsx" "src/renderer/index.html" "src/renderer/quick-entry.html" "src/renderer/global.d.ts"
      "src/renderer/lib/themes.test.ts" "vite.renderer.shared.ts" "vite.tauri.config.ts" "package.json" "bun.lock" ".gitignore"
    )
    RUST_FILES=(src-tauri/src/main.rs src-tauri/src/lib.rs src-tauri/src/ctx.rs src-tauri/src/ports.rs src-tauri/src/bridge.rs src-tauri/src/webview.rs
      src-tauri/src/prefs.rs src-tauri/src/paths.rs src-tauri/src/product.rs src-tauri/src/i18n.rs src-tauri/src/runtime_log.rs src-tauri/src/testing.rs src-tauri/src/test_hooks.rs)
    SNAPSHOTS=(ports omp tabs desktop services ollama updater)
    ;;
  updater)
    OWNED=("src-tauri/src/updater/" "src-tauri/tauri.conf.json" "src-tauri/tauri.linux.conf.json"
      "src-tauri/icons/" "src-tauri/linux/"
      "scripts/stage-tauri-sidecar.ts" "scripts/release-feeds.ts" "scripts/release-feeds.test.ts" "scripts/tauri-packaging-config.test.ts"
      "package.json" ".github/workflows/ci.yml")
    RUST_FILES=(); while IFS= read -r f; do RUST_FILES+=("$f"); done < <(find src-tauri/src/updater -name '*.rs' | sort)
    SNAPSHOTS=(updater ports)
    ;;
  snapshots)
    SNAPSHOTS=(); for f in src-tauri/contracts/*.api.txt; do f="${f##*/}"; SNAPSHOTS+=("${f%.api.txt}"); done
    ;;
  renderer)
    OWNED=("src/renderer/" "plans/")
    FROZEN=("src/renderer/boot/" "src/renderer/main.tsx" "src/renderer/quick-entry/main.tsx" "src/renderer/global.d.ts" "src/renderer/index.html" "src/renderer/quick-entry.html")
    ;;
  *)
    OWNED=("src-tauri/src/$MODULE/")
    RUST_FILES=(); while IFS= read -r f; do RUST_FILES+=("$f"); done < <(find "src-tauri/src/$MODULE" -name '*.rs' | sort)
    SNAPSHOTS=("$MODULE" ports)
    ;;
esac

owned_path() {
  local file="$1" prefix
  for prefix in "${OWNED[@]}"; do
    if [[ "$prefix" == */ ]]; then [[ "$file" == "$prefix"* ]] && return 0; else [[ "$file" == "$prefix" ]] && return 0; fi
  done
  return 1
}

frozen_path() {
  local file="$1" prefix
  for prefix in "${FROZEN[@]:-}"; do
    [[ -z "$prefix" ]] && continue
    if [[ "$prefix" == */ ]]; then [[ "$file" == "$prefix"* ]] && return 0; else [[ "$file" == "$prefix" ]] && return 0; fi
  done
  return 1
}

# Gate 3, whole-tree: needs no merge base, so `snapshots` runs it alone.
check_snapshots() {
  step 3 "cargo public-api snapshots match contracts/*.api.txt"
  if [[ ! -f out/renderer-tauri/index.html ]]; then
    echo "  out/renderer-tauri is missing; building it (tauri::generate_context! needs it)"
    bun run build:renderer:tauri >/dev/null || fail 3 "could not build the Tauri renderer"
  fi
  PUBLIC_API_TOOLCHAIN="${PUBLIC_API_TOOLCHAIN:?PUBLIC_API_TOOLCHAIN missing from scripts/rust-pins.env}"
  CARGO_PUBLIC_API_VERSION="${CARGO_PUBLIC_API_VERSION:?CARGO_PUBLIC_API_VERSION missing from scripts/rust-pins.env}"
  INSTALLED_PA=$("$CARGO" public-api --version 2>/dev/null | awk '{print $2}')
  if [[ "$INSTALLED_PA" != "$CARGO_PUBLIC_API_VERSION" ]]; then
    fail 3 "cargo-public-api $CARGO_PUBLIC_API_VERSION is required (installed: ${INSTALLED_PA:-none}); run: $CARGO install cargo-public-api --version $CARGO_PUBLIC_API_VERSION --locked"
  fi
  if ! "$CARGO_HOME_BIN/rustup" run "$PUBLIC_API_TOOLCHAIN" rustc --version >/dev/null 2>&1; then
    fail 3 "toolchain $PUBLIC_API_TOOLCHAIN is missing; run: $CARGO_HOME_BIN/rustup toolchain install $PUBLIC_API_TOOLCHAIN --profile minimal"
  fi
  SNAP_DIR=$(mktemp -d)
  trap 'rm -rf "$SNAP_DIR"' EXIT
  if ! (cd src-tauri && "$CARGO" "+$PUBLIC_API_TOOLCHAIN" public-api -ss > "$SNAP_DIR/full.txt" 2> "$SNAP_DIR/err.txt"); then
    cat "$SNAP_DIR/err.txt" >&2
    fail 3 "cargo public-api failed"
  fi
  for snap in "${SNAPSHOTS[@]}"; do
    grep "sai_atlas_lib::${snap}::" "$SNAP_DIR/full.txt" > "$SNAP_DIR/$snap.api.txt" || true
    if ! cmp -s "$SNAP_DIR/$snap.api.txt" "src-tauri/contracts/$snap.api.txt"; then
      diff -u "src-tauri/contracts/$snap.api.txt" "$SNAP_DIR/$snap.api.txt" >&2 || true
      fail 3 "public API of $snap changed (frozen in src-tauri/contracts/$snap.api.txt)"
    fi
  done
}

if [[ "$MODULE" == "snapshots" ]]; then
  check_snapshots
  echo "check-module $MODULE: PASS (${SNAPSHOTS[*]})"
  exit 0
fi

# --- gate 1: changed files stay inside the module ----------------------------
BASE="${BASE:-$(git merge-base HEAD tauri/foundation 2>/dev/null || git rev-parse HEAD)}"
step 1 "changed files since $BASE are owned by $MODULE"
OUTSIDE=()
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if ! owned_path "$file" || frozen_path "$file"; then OUTSIDE+=("$file"); fi
done < <(git diff --name-only "$BASE" -- . ':!plans/')
if ((${#OUTSIDE[@]} > 0)); then
  printf '  %s\n' "${OUTSIDE[@]}" >&2
  fail 1 "files outside the module's ownership changed"
fi

# --- renderer: its own gate set ---------------------------------------------
if [[ "$MODULE" == "renderer" ]]; then
  step 2 "bunx vitest run";                 bunx vitest run || fail 2 "vitest failed"
  step 3 "bun run check:types";             bun run check:types || fail 3 "typecheck failed"
  step 4 "bunx biome check (changed files)"
  CHANGED=(); while IFS= read -r f; do [[ -f "$f" && "$f" =~ \.(ts|tsx|js|mjs)$ ]] && CHANGED+=("$f"); done < <(git diff --name-only "$BASE" -- src/renderer)
  if ((${#CHANGED[@]} > 0)); then bunx biome check "${CHANGED[@]}" || fail 4 "biome reported problems"; fi
  step 5 "bun run build";                   bun run build || fail 5 "renderer build failed"
  step 6 "node scripts/lint-surfaces.mjs";  node scripts/lint-surfaces.mjs || fail 6 "lint-surfaces failed"
  echo "check-module $MODULE: PASS"
  exit 0
fi

# --- gate 2: no stubs left ----------------------------------------------------
step 2 "no todo!/unimplemented!/not_ported stubs in owned Rust files"
STUBS=$(grep -nE 'todo!\(|unimplemented!\(|not_ported\(' "${RUST_FILES[@]}" 2>/dev/null | grep -vE 'fn not_ported\(|^[^:]+:[0-9]+:\s*//' || true)
if [[ -n "$STUBS" ]]; then
  echo "$STUBS" >&2
  fail 2 "stub bodies remain"
fi

# --- gate 3: API snapshots are byte-identical ---------------------------------
check_snapshots

# --- gate 4: clippy ------------------------------------------------------------
step 4 "cargo clippy (deny warnings, unwrap_used, expect_used)"
"$CARGO" clippy --manifest-path "$MANIFEST" --all-targets --all-features -- -D warnings -D clippy::unwrap_used -D clippy::expect_used || fail 4 "clippy failed"

# --- gate 5: serde types rename_all -------------------------------------------
step 5 "every owned file deriving Serialize/Deserialize uses rename_all"
for file in "${RUST_FILES[@]}"; do
  if grep -qE 'derive\([^)]*(Serialize|Deserialize)' "$file" && ! grep -q 'rename_all' "$file"; then
    fail 5 "$file derives Serialize/Deserialize without a rename_all attribute"
  fi
done

# --- gate 6: no blocking std APIs ---------------------------------------------
step 6 "no std::thread::sleep or std::process::Command in owned files"
if grep -nE 'std::thread::sleep|std::process::Command' "${RUST_FILES[@]}" >&2; then
  fail 6 "blocking std APIs found"
fi

# --- gate 7: tests ---------------------------------------------------------------
step 7 "cargo test (default and e2e-hooks)"
"$CARGO" test --manifest-path "$MANIFEST" || fail 7 "cargo test failed"
"$CARGO" test --manifest-path "$MANIFEST" --features e2e-hooks || fail 7 "cargo test --features e2e-hooks failed"
if [[ "$MODULE" == "updater" ]]; then
  bunx vitest run scripts/ || fail 7 "vitest (scripts) failed"
fi

echo "check-module $MODULE: PASS"
