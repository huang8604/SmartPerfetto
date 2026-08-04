// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {
  BackgroundKnowledgeReference,
  RagSourceKind,
} from '../../types/sparkContracts';
import type {CodeLookupOutcome} from '../codebase/codeLookupLedger';
import type {SanitizedRagResult} from './lookupResponseFilter';

export interface ProjectedPayload {
  toolName: string;
  chunkRefs: Array<{
    chunkId: string;
    codebaseId?: string;
    knowledgeSourceId?: string;
    kind: RagSourceKind;
    title?: string;
    uri?: string;
    license?: string;
    attribution?: string;
    sourceStatus?: string;
    sourceConfidence?: string;
    articleId?: string;
    sectionId?: string;
    sectionHeading?: string;
    chunkHash?: string;
    knowledgePackVersion?: string;
    knowledgePackFingerprint?: string;
    lastVerifiedAgainst?: string;
    commitHash?: string;
    sourceDirty?: boolean;
    commitProvenance?: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
    snippetHash?: string;
    snippetLength?: number;
    redactedCount?: number;
  }>;
  outcome: CodeLookupOutcome;
  legacyPath: boolean;
  backgroundKnowledgeReferences?: BackgroundKnowledgeReference[];
}

const SENSITIVE_RAG_TOOL_NAMES = new Set([
  'lookup_blog_knowledge',
  'lookup_app_source',
  'lookup_kernel_source',
  'lookup_aosp_source',
  'lookup_oem_sdk',
]);

export function isSensitiveRagToolName(toolName: string): boolean {
  return SENSITIVE_RAG_TOOL_NAMES.has(toolName);
}

function rejectedProjection(toolName: string): ProjectedPayload {
  return {toolName, chunkRefs: [], outcome: 'rejected', legacyPath: false};
}

function hashSnippet(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex').slice(0, 12);
}

export function projectRagResultForSseAndLog(toolName: string, result: SanitizedRagResult): ProjectedPayload {
  let outcome: CodeLookupOutcome = 'success';
  const chunkRefs = result.hits.map(hit => {
    if (hit.unsupportedReason) outcome = hit.unsupportedReason === 'budget_exceeded'
      ? 'budget_exceeded'
      : 'rejected';
    const privateWiki = hit.metadata?.kind === 'android_internals_wiki';
    return {
      chunkId: hit.chunkId,
      ...(hit.metadata?.codebaseId ? {codebaseId: hit.metadata.codebaseId} : {}),
      ...(hit.metadata?.knowledgeSourceId
        ? {knowledgeSourceId: hit.metadata.knowledgeSourceId}
        : {}),
      kind: hit.metadata?.kind ?? 'androidperformance.com',
      ...(!privateWiki && hit.metadata?.title ? {title: hit.metadata.title} : {}),
      ...(!privateWiki && hit.metadata?.uri ? {uri: hit.metadata.uri} : {}),
      ...(hit.metadata?.license ? {license: hit.metadata.license} : {}),
      ...(hit.metadata?.attribution ? {attribution: hit.metadata.attribution} : {}),
      ...(!privateWiki && hit.metadata?.sourceStatus ? {sourceStatus: hit.metadata.sourceStatus} : {}),
      ...(!privateWiki && hit.metadata?.sourceConfidence
        ? {sourceConfidence: hit.metadata.sourceConfidence}
        : {}),
      ...(hit.metadata?.articleId ? {articleId: hit.metadata.articleId} : {}),
      ...(hit.metadata?.sectionId ? {sectionId: hit.metadata.sectionId} : {}),
      ...(hit.metadata?.sectionHeading
        ? {sectionHeading: hit.metadata.sectionHeading}
        : {}),
      ...(hit.metadata?.chunkHash ? {chunkHash: hit.metadata.chunkHash} : {}),
      ...(hit.metadata?.knowledgePackVersion
        ? {knowledgePackVersion: hit.metadata.knowledgePackVersion}
        : {}),
      ...(hit.metadata?.knowledgePackFingerprint
        ? {knowledgePackFingerprint: hit.metadata.knowledgePackFingerprint}
        : {}),
      ...(!privateWiki && hit.metadata?.lastVerifiedAgainst
        ? {lastVerifiedAgainst: hit.metadata.lastVerifiedAgainst}
        : {}),
      ...(hit.metadata?.commitHash ? {commitHash: hit.metadata.commitHash} : {}),
      ...(hit.metadata?.sourceDirty !== undefined ? {sourceDirty: hit.metadata.sourceDirty} : {}),
      ...(hit.metadata?.commitProvenance ? {commitProvenance: hit.metadata.commitProvenance} : {}),
      ...(hit.snippet ? {snippetHash: hashSnippet(hit.snippet), snippetLength: hit.snippet.length} : {}),
      ...(hit.redactedCount !== undefined ? {redactedCount: hit.redactedCount} : {}),
    };
  });
  return {
    toolName,
    chunkRefs,
    outcome,
    legacyPath: result.legacyPath,
    ...(result.backgroundKnowledgeReferences
      ? {backgroundKnowledgeReferences: result.backgroundKnowledgeReferences.map(item => ({...item}))}
      : {}),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseTextPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const block = value as {type?: unknown; text?: unknown};
  if (
    (block.type === 'text' || block.type === 'input_text') &&
    typeof block.text === 'string'
  ) {
    return parseJson(block.text);
  }
  return undefined;
}

function unwrapMcpPayload(raw: unknown): unknown {
  const direct = parseJson(raw);
  if (Array.isArray(direct)) {
    for (const block of direct) {
      const parsed = parseTextPayload(block);
      if (parsed !== undefined) return parsed;
    }
    return direct;
  }
  if (!direct || typeof direct !== 'object') return direct;
  const content = (direct as {content?: unknown}).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const parsed = parseTextPayload(block);
      if (parsed !== undefined) return parsed;
    }
  }
  const parsedDirect = parseTextPayload(direct);
  return parsedDirect === undefined ? direct : parsedDirect;
}

function projectRawRetrievalResult(toolName: string, candidate: Record<string, unknown>): ProjectedPayload | undefined {
  if (!Array.isArray(candidate.results)) return undefined;
  const hits = candidate.results.flatMap(rawHit => {
    if (!rawHit || typeof rawHit !== 'object') return [];
    const hit = rawHit as {chunk?: unknown; score?: unknown};
    if (!hit.chunk || typeof hit.chunk !== 'object') return [];
    const chunk = hit.chunk as Record<string, unknown>;
    if (typeof chunk.chunkId !== 'string' || typeof chunk.kind !== 'string') return [];
    return [{
      chunkId: chunk.chunkId,
      score: typeof hit.score === 'number' ? hit.score : 0,
      metadata: {
        kind: chunk.kind as RagSourceKind,
        ...(typeof chunk.codebaseId === 'string' ? {codebaseId: chunk.codebaseId} : {}),
        ...(typeof chunk.knowledgeSourceId === 'string' ? {knowledgeSourceId: chunk.knowledgeSourceId} : {}),
        ...(typeof chunk.title === 'string' ? {title: chunk.title} : {}),
        ...(typeof chunk.uri === 'string' ? {uri: chunk.uri} : {}),
        ...(typeof chunk.license === 'string' ? {license: chunk.license} : {}),
        ...(typeof chunk.attribution === 'string' ? {attribution: chunk.attribution} : {}),
        ...(typeof chunk.sourceStatus === 'string' ? {sourceStatus: chunk.sourceStatus} : {}),
        ...(typeof chunk.sourceConfidence === 'string' ? {sourceConfidence: chunk.sourceConfidence} : {}),
        ...(typeof chunk.lastVerifiedAgainst === 'string'
          ? {lastVerifiedAgainst: chunk.lastVerifiedAgainst}
          : {}),
        ...(typeof chunk.articleId === 'string' ? {articleId: chunk.articleId} : {}),
        ...(typeof chunk.sectionId === 'string' ? {sectionId: chunk.sectionId} : {}),
        ...(typeof chunk.sectionHeading === 'string'
          ? {sectionHeading: chunk.sectionHeading}
          : {}),
        ...(typeof chunk.chunkHash === 'string' ? {chunkHash: chunk.chunkHash} : {}),
        ...(typeof chunk.knowledgePackVersion === 'string'
          ? {knowledgePackVersion: chunk.knowledgePackVersion}
          : {}),
        ...(typeof chunk.knowledgePackFingerprint === 'string'
          ? {knowledgePackFingerprint: chunk.knowledgePackFingerprint}
          : {}),
        ...(typeof chunk.commitHash === 'string' ? {commitHash: chunk.commitHash} : {}),
        ...(typeof chunk.sourceDirty === 'boolean' ? {sourceDirty: chunk.sourceDirty} : {}),
        ...((chunk.commitProvenance === 'clean_git_revision' ||
          chunk.commitProvenance === 'dirty_git_worktree' ||
          chunk.commitProvenance === 'content_only')
          ? {commitProvenance: chunk.commitProvenance}
          : {}),
      } as SanitizedRagResult['hits'][number]['metadata'],
      ...(typeof chunk.snippet === 'string' ? {snippet: chunk.snippet} : {}),
    }];
  });
  const result: SanitizedRagResult = {
    query: typeof candidate.query === 'string' ? candidate.query : '',
    probed: Array.isArray(candidate.probed) ? candidate.probed as RagSourceKind[] : [],
    retrievedAt: typeof candidate.retrievedAt === 'number' ? candidate.retrievedAt : Date.now(),
    legacyPath: false,
    hits,
  };
  const projected = projectRagResultForSseAndLog(toolName, result);
  if (typeof candidate.unsupportedReason === 'string') projected.outcome = 'rejected';
  return projected;
}

/**
 * Extract a sanitized source-backed RAG result from provider-specific tool
 * output envelopes. Both user code and external private knowledge may contain
 * raw text that is valid model input but must never be copied into SSE, logs,
 * or replay artifacts.
 */
export function projectSensitiveRagToolResult(
  toolName: string,
  raw: unknown,
): ProjectedPayload | undefined {
  const payload = unwrapMcpPayload(raw);
  if (!payload || typeof payload !== 'object') return undefined;
  const candidate = (payload as {result?: unknown}).result ?? payload;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const result = candidate as SanitizedRagResult;
  if (!Array.isArray(result.hits)) return undefined;
  if (!result.hits.some(hit =>
    hit.metadata?.kind === 'android_internals_wiki' ||
    hit.metadata?.kind === 'android_internals_pack' ||
    hit.metadata?.kind === 'app_source' ||
    hit.metadata?.kind === 'kernel_source' ||
    (hit.metadata?.kind === 'aosp' && Boolean(hit.metadata?.codebaseId)) ||
    (hit.metadata?.kind === 'oem_sdk' && Boolean(hit.metadata?.codebaseId)))) {
    return undefined;
  }
  return projectRagResultForSseAndLog(toolName, result);
}

/** Fail closed for sensitive tool results copied to logs, SSE, or replay. */
export function projectToolResultForExternalSurface(toolName: string, raw: unknown): unknown {
  const projected = projectSensitiveRagToolResult(toolName, raw);
  if (projected) return projected;
  const payload = unwrapMcpPayload(raw);
  const candidate = payload && typeof payload === 'object'
    ? ((payload as {result?: unknown}).result ?? payload)
    : undefined;
  if (toolName === 'lookup_blog_knowledge' && candidate && typeof candidate === 'object') {
    const publicProjection = projectRawRetrievalResult(toolName, candidate as Record<string, unknown>);
    if (publicProjection) return publicProjection;
  }
  return isSensitiveRagToolName(toolName) ? rejectedProjection(toolName) : raw;
}

/** @deprecated Use projectSensitiveRagToolResult. */
export const projectPrivateKnowledgeToolResult = projectSensitiveRagToolResult;
