#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Start backend only with logging

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$PROJECT_ROOT/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$LOGS_DIR"
BACKEND_LOG="$LOGS_DIR/backend_${TIMESTAMP}.log"

echo "Starting backend with logging to: $BACKEND_LOG"

# Kill existing process on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

cd "$PROJECT_ROOT/backend"

# Build backend
echo "Building backend..."
npm run build
if [ $? -ne 0 ]; then
  echo "Backend build failed!"
  exit 1
fi
npm run dev 2>&1 | tee "$BACKEND_LOG" &

# Create symlink to latest
ln -sf "$BACKEND_LOG" "$LOGS_DIR/backend_latest.log"

echo ""
echo "Backend started! Log: $BACKEND_LOG"
echo "tail -f $LOGS_DIR/backend_latest.log"