#!/usr/bin/env bash
# setup.sh — Catastro project setup script (consumer-owned).
# This lives at the repo root scripts/ directory (flat layout) and maps to
# brain/scripts/setup.sh when resolved to a logical name.

set -euo pipefail

echo "Setting up Catastro development environment..."

# Install Node.js dependencies
npm install

# Bootstrap brain configuration
npm run brain:env:init

echo "Setup complete."
