#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="$project_root/.local/qdrant"
version="v1.19.2"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Use docker compose up -d on Linux/Windows, or run your own Qdrant." >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) archive="qdrant-aarch64-apple-darwin.tar.gz"; checksum="d24dfd25f4584684b337dd30ee016472cd25f53fc2501f1cd058ab3d7ee0b019" ;;
  x86_64) archive="qdrant-x86_64-apple-darwin.tar.gz"; checksum="e095b682ad7460baff43827eaa13647b5ec97c48edcb676646ae2f4108395044" ;;
  *) echo "Unsupported macOS architecture" >&2; exit 1 ;;
esac
mkdir -p "$runtime_dir"
if [[ ! -x "$runtime_dir/qdrant" ]]; then
  if [[ ! -f "$runtime_dir/$archive" ]]; then
    curl --fail --location --retry 3 --output "$runtime_dir/$archive" "https://github.com/qdrant/qdrant/releases/download/$version/$archive"
  fi
  echo "$checksum  $runtime_dir/$archive" | shasum -a 256 -c -
  tar -xzf "$runtime_dir/$archive" -C "$runtime_dir"
fi
cd "$runtime_dir"
exec env QDRANT__SERVICE__HOST=127.0.0.1 QDRANT__STORAGE__STORAGE_PATH="$project_root/storage/qdrant" QDRANT__TELEMETRY_DISABLED=true ./qdrant
