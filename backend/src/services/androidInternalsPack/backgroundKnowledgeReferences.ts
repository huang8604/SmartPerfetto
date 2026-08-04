// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  BackgroundKnowledgeReference,
  RagChunk,
} from '../../types/sparkContracts';

export function backgroundKnowledgeReferenceFromChunk(
  chunk: RagChunk,
): BackgroundKnowledgeReference | undefined {
  if (
    chunk.kind !== 'android_internals_pack' ||
    !chunk.knowledgePackVersion ||
    !chunk.knowledgePackFingerprint ||
    !chunk.commitHash ||
    !chunk.articleId ||
    !chunk.title ||
    !chunk.sectionId ||
    !chunk.sectionHeading ||
    !chunk.chunkHash ||
    !chunk.license
  ) {
    return undefined;
  }
  return {
    sourceKind: 'android_internals_pack',
    packVersion: chunk.knowledgePackVersion,
    packFingerprint: chunk.knowledgePackFingerprint,
    sourceRevision: chunk.commitHash,
    articleId: chunk.articleId,
    articleTitle: chunk.title,
    sectionId: chunk.sectionId,
    sectionHeading: chunk.sectionHeading,
    chunkId: chunk.chunkId,
    chunkHash: chunk.chunkHash,
    license: chunk.license,
    ...(chunk.sourceConfidence ? {confidence: chunk.sourceConfidence} : {}),
    ...(chunk.verifiedAt
      ? {lastVerified: new Date(chunk.verifiedAt).toISOString()}
      : {}),
    ...(chunk.lastVerifiedAgainst
      ? {lastVerifiedAgainst: chunk.lastVerifiedAgainst}
      : {}),
  };
}
