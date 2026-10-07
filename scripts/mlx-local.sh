#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "MLX inference requires an Apple Silicon Mac." >&2
  exit 1
fi

venv=.local/mlx-venv
if [[ ! -x "$venv/bin/python" ]]; then
  python_bin="${MLX_PYTHON:-}"
  if [[ -z "$python_bin" ]]; then
    for candidate in python3.13 python3.12 python3.11 python3; do
      if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; assert sys.version_info >= (3, 11)' 2>/dev/null; then
        python_bin="$(command -v "$candidate")"
        break
      fi
    done
  fi
  if [[ -z "$python_bin" ]]; then
    echo "Python 3.11+ is required. Set MLX_PYTHON to its executable path." >&2
    exit 1
  fi
  "$python_bin" -m venv "$venv"
fi

# Reinstall only when the pinned requirements change or setup was interrupted.
if ! cmp -s scripts/requirements-mlx.txt "$venv/requirements-installed.txt"; then
  "$venv/bin/python" -m pip install -r scripts/requirements-mlx.txt
  cp scripts/requirements-mlx.txt "$venv/requirements-installed.txt"
fi
exec "$venv/bin/python" scripts/mlx_embedding_server.py "$@"
