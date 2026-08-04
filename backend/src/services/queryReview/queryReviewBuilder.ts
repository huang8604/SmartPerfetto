// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../agentv3/outputLanguage';
import { analyzeSqlGuardrails } from '../sqlGuardrailAnalyzer';
import type { TraceProcessorQueryProvenance } from '../traceProcessorConnectionModel';
import {
  QUERY_REVIEW_SCHEMA_VERSION,
  sanitizeQueryReview,
  type QueryReviewProducerKind,
  type QueryReviewV1,
} from '../../types/queryReviewContract';
import {
  introspectSqlForQueryReview,
  type SqlReviewOutputColumn,
} from './sqlReviewIntrospector';

export interface QueryReviewProducerInput {
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  planPhaseTitle?: string;
  producerReason?: string;
}

export interface BuildSqlQueryReviewInput {
  producerKind: Extract<QueryReviewProducerKind, 'execute_sql' | 'execute_sql_on'>;
  executableSql?: string;
  outputColumns?: SqlReviewOutputColumn[];
  traceProvenance?: TraceProcessorQueryProvenance;
  producer?: QueryReviewProducerInput;
  evidenceRefId?: string;
  queryHash?: string;
  artifactId?: string;
  durationMs?: number;
  rowCount?: number;
  truncated?: boolean;
  sqlRewrites?: string[];
  stdlibInjectedModules?: string[];
  processIdentityWarning?: string;
  outputLanguage?: OutputLanguage;
  title?: string;
  purpose?: string;
}

export function queryReviewStableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function buildSqlQueryReview(input: BuildSqlQueryReviewInput): QueryReviewV1 | undefined {
  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const introspection = introspectSqlForQueryReview({
    sql: input.executableSql,
    outputColumns: input.outputColumns,
    outputLanguage,
  });
  const guardrails = input.executableSql
    ? analyzeSqlGuardrails(input.executableSql).map(issue => ({
        ruleId: issue.ruleId,
        message: issue.message,
        line: issue.line,
        severity: 'warning' as const,
      }))
    : [];
  const limitations = [
    ...introspection.limitations,
    ...(input.processIdentityWarning ? [input.processIdentityWarning] : []),
  ];
  const reviewId = `qr:${input.producerKind}:${queryReviewStableHash({
    tool: input.producer?.sourceToolCallId,
    paramsHash: input.producer?.paramsHash,
    evidenceRefId: input.evidenceRefId,
    queryHash: input.queryHash,
    artifactId: input.artifactId,
    sql: input.executableSql,
  })}`;

  return sanitizeQueryReview({
    schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
    id: reviewId,
    producer: {
      kind: input.producerKind,
      sourceToolCallId: input.producer?.sourceToolCallId,
      paramsHash: input.producer?.paramsHash,
      planPhaseId: input.producer?.planPhaseId,
      planPhaseTitle: input.producer?.planPhaseTitle,
      traceSide: input.traceProvenance?.traceSide,
      paneSide: input.traceProvenance?.paneSide,
      traceId: input.traceProvenance?.traceId,
    },
    title: input.title || localize(outputLanguage, '已执行 SQL review', 'Executed SQL review'),
    purpose: input.purpose || input.producer?.producerReason || localize(
      outputLanguage,
      'Review 已执行 SQL 的来源表、过滤条件、输出形状和 guardrail 告警。',
      'Review the executed SQL source tables, filters, output shape, and guardrail warnings.',
    ),
    source: {
      artifactId: input.artifactId,
      evidenceRefId: input.evidenceRefId,
      queryHash: input.queryHash,
    },
    reads: introspection.reads,
    filters: introspection.filters,
    outputShape: introspection.outputShape,
    guardrails,
    limitations,
    observedExecution: {
      executed: true,
      executableSql: input.executableSql,
      sqlRewrites: input.sqlRewrites,
      stdlibInjectedModules: input.stdlibInjectedModules,
      durationMs: input.durationMs,
      rowCount: input.rowCount,
      truncated: input.truncated,
    },
    allowedUse: 'review_metadata_only',
  });
}
