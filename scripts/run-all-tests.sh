#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

#
# SmartPerfetto One-Click Test Runner
# ====================================
# Runs all automated tests and reports results.
#
# Usage:
#   ./scripts/run-all-tests.sh          # Run all tests
#   ./scripts/run-all-tests.sh --quick  # Skip slow tests
#   ./scripts/run-all-tests.sh --e2e    # Include E2E tests (requires Playwright)
#

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$ROOT_DIR/backend"
UI_DIR="$ROOT_DIR/perfetto/ui"

# Parse arguments
QUICK_MODE=false
RUN_E2E=false
VERBOSE=false

for arg in "$@"; do
  case $arg in
    --quick)
      QUICK_MODE=true
      ;;
    --e2e)
      RUN_E2E=true
      ;;
    --verbose|-v)
      VERBOSE=true
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --quick    Skip slow tests (skill-eval)"
      echo "  --e2e      Include E2E tests (requires Playwright and running servers)"
      echo "  --verbose  Show detailed output"
      echo "  --help     Show this help message"
      exit 0
      ;;
  esac
done

# Results tracking (simple arrays for compatibility)
TEST_NAMES=""
TEST_STATUSES=""
TEST_DURATIONS=""
TOTAL_PASSED=0
TOTAL_FAILED=0
START_TIME=$(date +%s)

# Helper functions
print_header() {
  echo ""
  echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
}

record_result() {
  local name=$1
  local status=$2
  local duration=$3

  TEST_NAMES="$TEST_NAMES|$name"
  TEST_STATUSES="$TEST_STATUSES|$status"
  TEST_DURATIONS="$TEST_DURATIONS|$duration"

  if [ "$status" = "PASS" ]; then
    echo -e "  ${GREEN}✓${NC} $name ${YELLOW}(${duration}s)${NC}"
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    echo -e "  ${RED}✗${NC} $name ${YELLOW}(${duration}s)${NC}"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
}

run_test() {
  local name=$1
  local cmd=$2
  local dir=$3

  echo -e "\n${YELLOW}Running: $name...${NC}"

  local test_start=$(date +%s)
  local log_file="/tmp/test_output_$$.log"

  if [ "$VERBOSE" = true ]; then
    if (cd "$dir" && eval "$cmd"); then
      local test_end=$(date +%s)
      record_result "$name" "PASS" $((test_end - test_start))
      return 0
    else
      local test_end=$(date +%s)
      record_result "$name" "FAIL" $((test_end - test_start))
      return 1
    fi
  else
    if (cd "$dir" && eval "$cmd" > "$log_file" 2>&1); then
      local test_end=$(date +%s)
      record_result "$name" "PASS" $((test_end - test_start))
      rm -f "$log_file"
      return 0
    else
      local test_end=$(date +%s)
      record_result "$name" "FAIL" $((test_end - test_start))
      echo -e "  ${RED}Last 20 lines of output:${NC}"
      tail -20 "$log_file" 2>/dev/null | sed 's/^/    /'
      rm -f "$log_file"
      return 1
    fi
  fi
}

# Print banner
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          SmartPerfetto Automated Test Suite                   ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Mode: ${YELLOW}$([ "$QUICK_MODE" = true ] && echo "Quick" || echo "Full")${NC}"
echo -e "E2E:  ${YELLOW}$([ "$RUN_E2E" = true ] && echo "Enabled" || echo "Disabled")${NC}"
echo -e "Time: ${YELLOW}$(date '+%Y-%m-%d %H:%M:%S')${NC}"

# Check prerequisites
print_header "Checking Prerequisites"

# Check if backend directory exists
if [ ! -d "$BACKEND_DIR" ]; then
  echo -e "${RED}Error: Backend directory not found at $BACKEND_DIR${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Backend directory found"

# Check if node_modules exists
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo -e "${YELLOW}  Installing backend dependencies...${NC}"
  (cd "$BACKEND_DIR" && npm install)
fi
echo -e "  ${GREEN}✓${NC} Backend dependencies installed"

# Check for test traces
if [ ! -d "$ROOT_DIR/test-traces" ]; then
  echo -e "${YELLOW}  Warning: test-traces directory not found${NC}"
else
  TRACE_COUNT=$(ls -1 "$ROOT_DIR/test-traces"/*.pftrace 2>/dev/null | wc -l | tr -d ' ')
  echo -e "  ${GREEN}✓${NC} Test traces found: $TRACE_COUNT files"
fi

# Run tests
print_header "Running Tests"

# 1. Integration Tests (fast, always run first)
run_test "Integration Tests" "npm run test:integration" "$BACKEND_DIR" || true

# 2. Skill SQL Evaluation Tests (slower, skip in quick mode)
if [ "$QUICK_MODE" = false ]; then
  run_test "Skill SQL Evaluation" "npm run test:skill-eval" "$BACKEND_DIR" || true
else
  echo -e "\n${YELLOW}Skipping: Skill SQL Evaluation (quick mode)${NC}"
fi

# 3. E2E Tests (optional, requires servers running)
if [ "$RUN_E2E" = true ]; then
  echo -e "\n${YELLOW}Checking E2E prerequisites...${NC}"

  # Check if backend is running
  if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Backend server running"

    # Check if UI is running
    if curl -s http://localhost:10000 > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} UI server running"

      # Check if Playwright is installed
      if [ -d "$UI_DIR/node_modules/@playwright" ]; then
        run_test "E2E: AI Panel" "npx playwright test src/test/ai_panel.test.ts --reporter=line" "$UI_DIR" || true
      else
        echo -e "  ${YELLOW}Warning: Playwright not installed, skipping E2E tests${NC}"
      fi
    else
      echo -e "  ${YELLOW}Warning: UI server not running at localhost:10000${NC}"
      echo -e "  ${YELLOW}Start with: cd perfetto/ui && ./run-dev-server${NC}"
    fi
  else
    echo -e "  ${YELLOW}Warning: Backend server not running at localhost:3000${NC}"
    echo -e "  ${YELLOW}Start with: cd backend && npm run dev${NC}"
  fi
fi

# Print summary
END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

print_header "Test Summary"

echo ""
echo -e "Results:"

# Parse and display results
IFS='|' read -ra NAMES <<< "$TEST_NAMES"
IFS='|' read -ra STATUSES <<< "$TEST_STATUSES"
IFS='|' read -ra DURATIONS <<< "$TEST_DURATIONS"

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  status="${STATUSES[$i]}"
  duration="${DURATIONS[$i]}"

  if [ -n "$name" ]; then
    if [ "$status" = "PASS" ]; then
      echo -e "  ${GREEN}✓${NC} $name (${duration}s)"
    else
      echo -e "  ${RED}✗${NC} $name (${duration}s)"
    fi
  fi
done

echo ""
echo -e "────────────────────────────────────────────────────────────"
echo -e "  ${GREEN}Passed:${NC} $TOTAL_PASSED"
echo -e "  ${RED}Failed:${NC} $TOTAL_FAILED"
echo -e "  ${YELLOW}Total time:${NC} ${TOTAL_TIME}s"
echo -e "────────────────────────────────────────────────────────────"

# Exit with error if any tests failed
if [ $TOTAL_FAILED -gt 0 ]; then
  echo ""
  echo -e "${RED}Some tests failed! Please check the output above.${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}All tests passed! ✓${NC}"
  exit 0
fi