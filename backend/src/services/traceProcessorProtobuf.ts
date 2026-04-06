// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Protobuf encoder/decoder for trace_processor HTTP API
 *
 * This module provides utilities for encoding QueryArgs and decoding QueryResult
 * protobuf messages used by trace_processor_shell HTTP API.
 */

/**
 * Encode a varint (variable-length integer)
 */
export function encodeVarint(value: number): Buffer {
  const result: number[] = [];
  while (value > 127) {
    result.push((value & 0x7f) | 0x80);
    value = value >>> 7;
  }
  result.push(value);
  return Buffer.from(result);
}

/**
 * Decode a varint from buffer at given offset
 * Returns [value, bytesRead]
 */
export function decodeVarint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const b = buf[offset + bytesRead];
    bytesRead++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  return [value, bytesRead];
}

/**
 * Encode a string field
 */
export function encodeStringField(fieldNum: number, str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  const tag = (fieldNum << 3) | 2; // wire type 2 = length-delimited
  return Buffer.concat([
    Buffer.from([tag]),
    encodeVarint(strBuf.length),
    strBuf
  ]);
}

/**
 * Encode QueryArgs protobuf message
 */
export function encodeQueryArgs(sql: string): Buffer {
  // QueryArgs message:
  //   optional string sql_query = 1;
  //   optional string tag = 3;
  return encodeStringField(1, sql);
}

/**
 * Cell types in QueryResult
 */
export enum CellType {
  CELL_INVALID = 0,
  CELL_NULL = 1,
  CELL_VARINT = 2,
  CELL_FLOAT64 = 3,
  CELL_STRING = 4,
  CELL_BLOB = 5,
}

/**
 * Parsed QueryResult
 */
export interface ParsedQueryResult {
  columnNames: string[];
  rows: any[][];
  error?: string;
  statementCount?: number;
  lastStatementSql?: string;
}

/**
 * Parse a packed varint array
 */
function parsePackedVarints(buf: Buffer, offset: number, length: number): number[] {
  const result: number[] = [];
  const end = offset + length;

  while (offset < end) {
    const [value, bytesRead] = decodeVarint(buf, offset);
    result.push(value);
    offset += bytesRead;
  }

  return result;
}

/**
 * Parse a packed double array
 */
function parsePackedDoubles(buf: Buffer, offset: number, length: number): number[] {
  const result: number[] = [];
  const end = offset + length;

  while (offset < end) {
    if (offset + 8 <= end) {
      result.push(buf.readDoubleLE(offset));
      offset += 8;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Parse CellsBatch message
 */
function parseCellsBatch(buf: Buffer, offset: number, length: number): {
  cells: CellType[];
  varintCells: number[];
  float64Cells: number[];
  stringCells: string[];
  blobCells: Buffer[];
  isLastBatch: boolean;
} {
  const end = offset + length;
  let cells: CellType[] = [];
  let varintCells: number[] = [];
  let float64Cells: number[] = [];
  let stringCellsRaw = '';
  const blobCells: Buffer[] = [];
  let isLastBatch = false;

  while (offset < end) {
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) { // length-delimited
      const [len, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;

      if (fieldNum === 1) { // cells (packed)
        cells = parsePackedVarints(buf, offset, len).map(v => v as CellType);
      } else if (fieldNum === 2) { // varint_cells (packed)
        varintCells = parsePackedVarints(buf, offset, len);
      } else if (fieldNum === 3) { // float64_cells (packed)
        float64Cells = parsePackedDoubles(buf, offset, len);
      } else if (fieldNum === 4) { // blob_cells
        blobCells.push(buf.slice(offset, offset + len));
      } else if (fieldNum === 5) { // string_cells
        stringCellsRaw = buf.slice(offset, offset + len).toString('utf8');
      }

      offset += len;
    } else if (wireType === 0) { // varint
      const [value, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;

      if (fieldNum === 6) { // is_last_batch
        isLastBatch = value === 1;
      }
    }
  }

  // Split string cells by NUL terminator.
  // Each string is NUL-terminated, so split produces a trailing empty element which we remove.
  // IMPORTANT: Do NOT filter out empty strings — they are valid cell values (e.g. COALESCE(x, '')).
  // Filtering empties would shift all subsequent string indices.
  const stringCells = stringCellsRaw
    ? stringCellsRaw.split('\0').slice(0, -1)  // remove only the trailing empty from final NUL
    : [];

  return { cells, varintCells, float64Cells, stringCells, blobCells, isLastBatch };
}

/**
 * Decode QueryResult protobuf message
 */
export function decodeQueryResult(buf: Buffer): ParsedQueryResult {
  const columnNames: string[] = [];
  let error: string | undefined;
  const batches: ReturnType<typeof parseCellsBatch>[] = [];
  let statementCount: number | undefined;
  let lastStatementSql: string | undefined;

  let offset = 0;

  while (offset < buf.length) {
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) { // length-delimited
      const [len, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;

      if (fieldNum === 1) { // column_names (repeated string)
        columnNames.push(buf.slice(offset, offset + len).toString('utf8'));
      } else if (fieldNum === 2) { // error
        error = buf.slice(offset, offset + len).toString('utf8');
      } else if (fieldNum === 3) { // batch (repeated CellsBatch)
        const batch = parseCellsBatch(buf, offset, len);
        batches.push(batch);
      } else if (fieldNum === 6) { // last_statement_sql
        lastStatementSql = buf.slice(offset, offset + len).toString('utf8');
      }

      offset += len;
    } else if (wireType === 0) { // varint
      const [value, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;

      if (fieldNum === 4) { // statement_count
        statementCount = value;
      }
    }
  }

  // Build rows from batches
  const rows: any[][] = [];
  const numColumns = columnNames.length;

  if (numColumns > 0) {
    for (const batch of batches) {
      let varintIdx = 0;
      let float64Idx = 0;
      let stringIdx = 0;
      let blobIdx = 0;

      let currentRow: any[] = [];
      let colIdx = 0;

      for (const cellType of batch.cells) {
        let value: any = null;

        switch (cellType) {
          case CellType.CELL_NULL:
            value = null;
            break;
          case CellType.CELL_VARINT:
            value = batch.varintCells[varintIdx++] ?? null;
            break;
          case CellType.CELL_FLOAT64:
            value = batch.float64Cells[float64Idx++] ?? null;
            break;
          case CellType.CELL_STRING:
            value = batch.stringCells[stringIdx++] ?? null;
            break;
          case CellType.CELL_BLOB:
            value = batch.blobCells[blobIdx++] ?? null;
            break;
          default:
            value = null;
        }

        currentRow.push(value);
        colIdx++;

        if (colIdx >= numColumns) {
          rows.push(currentRow);
          currentRow = [];
          colIdx = 0;
        }
      }

      // Handle incomplete row (shouldn't happen normally)
      if (currentRow.length > 0) {
        while (currentRow.length < numColumns) {
          currentRow.push(null);
        }
        rows.push(currentRow);
      }
    }
  }

  return {
    columnNames,
    rows,
    error,
    statementCount,
    lastStatementSql,
  };
}