/**
 * CI Type Sync Check Script
 *
 * This script verifies that the generated frontend types are in sync with
 * the backend data contract. It regenerates the types to a temp location
 * and compares with the existing generated file.
 *
 * Exit codes:
 * - 0: Types are in sync
 * - 1: Types are out of sync (regeneration needed)
 * - 2: Error occurred during check
 *
 * Usage:
 *   npm run check:types
 *   npx tsx scripts/checkTypesSync.ts
 *
 * In CI:
 *   npm run check:types || (echo "Types out of sync! Run: npm run generate:frontend-types" && exit 1)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Paths
const projectRoot = path.resolve(__dirname, '../..');
const backendContractPath = path.join(projectRoot, 'backend/src/types/dataContract.ts');
const frontendTypesPath = path.join(
  projectRoot,
  'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts'
);

/**
 * Extract string values from a const array definition
 * (Same logic as generateFrontendTypes.ts)
 */
function extractConstArrayValues(content: string, constName: string): string[] {
  const regex = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`, 'm');
  const match = content.match(regex);
  if (!match) return [];

  const arrayContent = match[1];
  const values: string[] = [];

  const withoutComments = arrayContent
    .split('\n')
    .map(line => line.split('//')[0])
    .join(' ');

  const stringRegex = /'([^']+)'/g;
  let stringMatch;
  while ((stringMatch = stringRegex.exec(withoutComments)) !== null) {
    const value = stringMatch[1].trim();
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }

  return values;
}

/**
 * Normalize content for comparison by removing:
 * - Timestamp lines (@generated)
 * - Trailing whitespace
 * - Multiple blank lines
 */
function normalizeForComparison(content: string): string {
  return content
    // Remove @generated timestamp line
    .replace(/@generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '@generated TIMESTAMP')
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Remove trailing whitespace
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Generate the expected frontend types content
 * (Same logic as generateFrontendTypes.ts, but with fixed timestamp)
 */
function generateExpectedContent(backendContent: string): string {
  const columnTypes = extractConstArrayValues(backendContent, 'VALID_COLUMN_TYPES');
  const columnFormats = extractConstArrayValues(backendContent, 'VALID_COLUMN_FORMATS');
  const clickActions = extractConstArrayValues(backendContent, 'VALID_CLICK_ACTIONS');
  const displayLayers = extractConstArrayValues(backendContent, 'VALID_DISPLAY_LAYERS');
  const displayLevels = extractConstArrayValues(backendContent, 'VALID_DISPLAY_LEVELS');
  const displayFormats = extractConstArrayValues(backendContent, 'VALID_DISPLAY_FORMATS');

  // This should generate the same structure as generateFrontendTypes.ts
  // For CI checking, we only need to verify the type definitions match
  const parts: string[] = [];

  parts.push(`/**
 * SmartPerfetto Data Contract Types (Frontend)
 *
 * AUTO-GENERATED from backend/src/types/dataContract.ts
 * DO NOT EDIT MANUALLY - Changes will be overwritten
 *
 * To regenerate: npm run generate:frontend-types
 *
 * @module dataContract.types
 * @version 2.0.0 - DataEnvelope refactoring
 * @generated TIMESTAMP
 */
`);

  // Extract type union strings for comparison
  const expectedTypes = {
    columnTypes: columnTypes.map(t => `'${t}'`).join(' | '),
    columnFormats: columnFormats.map(t => `'${t}'`).join(' | '),
    clickActions: clickActions.map(t => `'${t}'`).join(' | '),
    displayLayers: displayLayers.map(t => `'${t}'`).join(' | '),
    displayLevels: displayLevels.map(t => `'${t}'`).join(' | '),
    displayFormats: displayFormats.map(t => `'${t}'`).join(' | '),
  };

  return JSON.stringify(expectedTypes);
}

/**
 * Extract type definitions from frontend file for comparison
 */
function extractTypeDefinitions(content: string): string {
  // Extract union type values
  const typePatterns = [
    { name: 'columnTypes', regex: /export type ColumnType =\s*([\s\S]*?);/ },
    { name: 'columnFormats', regex: /export type ColumnFormat =\s*([\s\S]*?);/ },
    { name: 'clickActions', regex: /export type ClickAction =\s*([\s\S]*?);/ },
    { name: 'displayLayers', regex: /export type DisplayLayer =\s*([\s\S]*?);/ },
    { name: 'displayLevels', regex: /export type DisplayLevel =\s*([\s\S]*?);/ },
    { name: 'displayFormats', regex: /export type DisplayFormat =\s*([\s\S]*?);/ },
  ];

  const extractedTypes: Record<string, string> = {};

  for (const { name, regex } of typePatterns) {
    const match = content.match(regex);
    if (match) {
      // Normalize the type union
      const typeUnion = match[1]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith("| '"))
        .map(line => line.replace(/^\| /, '').trim())
        .join(' | ');
      extractedTypes[name] = typeUnion;
    }
  }

  return JSON.stringify(extractedTypes);
}

/**
 * Main check function
 */
async function checkTypesSync(): Promise<boolean> {
  console.log('🔍 Checking frontend types sync with backend...\n');

  // Check if files exist
  if (!fs.existsSync(backendContractPath)) {
    console.error(`❌ Backend contract file not found: ${backendContractPath}`);
    process.exit(2);
  }

  if (!fs.existsSync(frontendTypesPath)) {
    console.error(`❌ Frontend types file not found: ${frontendTypesPath}`);
    console.error('\n👉 Run: npm run generate:frontend-types');
    process.exit(1);
  }

  // Read files
  const backendContent = fs.readFileSync(backendContractPath, 'utf-8');
  const frontendContent = fs.readFileSync(frontendTypesPath, 'utf-8');

  // Extract and compare type definitions
  const expectedTypes = generateExpectedContent(backendContent);
  const actualTypes = extractTypeDefinitions(frontendContent);

  if (expectedTypes !== actualTypes) {
    console.log('❌ Types are OUT OF SYNC!\n');

    // Show differences
    const expected = JSON.parse(expectedTypes);
    const actual = JSON.parse(actualTypes);

    console.log('Differences found:');
    for (const key of Object.keys(expected)) {
      if (expected[key] !== actual[key]) {
        console.log(`\n  ${key}:`);
        console.log(`    Expected: ${expected[key]}`);
        console.log(`    Actual:   ${actual[key] || '(missing)'}`);
      }
    }

    console.log('\n👉 Run: npm run generate:frontend-types');
    return false;
  }

  // Additional check: verify file was generated (not manually edited)
  const hasAutoGenComment = frontendContent.includes('AUTO-GENERATED from backend/src/types/dataContract.ts');
  if (!hasAutoGenComment) {
    console.log('⚠️  Warning: Frontend types file may have been manually edited.');
    console.log('   The file should contain the AUTO-GENERATED comment.\n');
  }

  console.log('✅ Frontend types are in sync with backend!\n');

  // Print summary
  const types = JSON.parse(expectedTypes);
  console.log('Type summary:');
  console.log(`  ColumnType: ${types.columnTypes.split(' | ').length} values`);
  console.log(`  ColumnFormat: ${types.columnFormats.split(' | ').length} values`);
  console.log(`  ClickAction: ${types.clickActions.split(' | ').length} values`);
  console.log(`  DisplayLayer: ${types.displayLayers.split(' | ').length} values`);
  console.log(`  DisplayLevel: ${types.displayLevels.split(' | ').length} values`);
  console.log(`  DisplayFormat: ${types.displayFormats.split(' | ').length} values`);

  return true;
}

// Run check
checkTypesSync()
  .then(inSync => {
    process.exit(inSync ? 0 : 1);
  })
  .catch(err => {
    console.error('❌ Error during type check:', err);
    process.exit(2);
  });
