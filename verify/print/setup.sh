#!/usr/bin/env bash
# Installs the independent checking tools on Ubuntu 24.04 (the CI image, and Claude's cloud container).
# ADMesh and PrusaSlicer come from Ubuntu; the Python tools go into verify/print/.venv.
set -euo pipefail
cd "$(dirname "$0")"
sudo_if() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
sudo_if apt-get update -q
sudo_if env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends admesh prusa-slicer libopengl0 libglu1-mesa python3-venv
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
echo "Tools ready. Run: npm run verify:print"
