// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'js-yaml';

import type {
  AndroidInternalsWikiArticle,
  AndroidInternalsWikiCorpus,
} from './androidInternalsWikiCorpus';

export type AndroidInternalsWikiDisposition =
  | 'candidate_skill_match'
  | 'validated_trace_skill'
  | 'explanation_only'
  | 'non_perfetto'
  | 'deferred_missing_schema_or_fixture'
  | 'metadata_error'
  | 'duplicate_or_superseded';

export interface WikiCapabilityValidation {
  skillId: string;
  observableClaim: string;
  assertionRef: string;
  articlePaths: string[];
}

export interface WikiCapabilityDomain {
  id: string;
  terms: string[];
  skillTags: string[];
  validations?: WikiCapabilityValidation[];
  deferWithoutFixture?: boolean;
}

export interface WikiCapabilityMap {
  domains: WikiCapabilityDomain[];
  nonPerfettoTerms?: string[];
}

export interface AuditableSkill {
  skillId: string;
  tags: string[];
  triggers: string[];
}

export interface AndroidInternalsWikiDomainAssessment {
  domainId: string;
  disposition: 'validated' | 'candidate' | 'deferred';
  candidateSkillIds: string[];
  validatedAssertionRefs: string[];
}

export interface AndroidInternalsWikiAuditRow {
  relativePath: string;
  title?: string;
  status?: string;
  retrievalEligible: boolean;
  disposition: AndroidInternalsWikiDisposition;
  reason: string;
  domainId?: string;
  matchedDomainIds?: string[];
  validatedDomainIds?: string[];
  unvalidatedDomainIds?: string[];
  domainAssessments?: AndroidInternalsWikiDomainAssessment[];
  candidateSkillIds: string[];
  observableClaim?: string;
  validatedAssertionRefs: string[];
  duplicateOf?: string;
}

export interface AndroidInternalsWikiAuditReport {
  totalArticles: number;
  rows: AndroidInternalsWikiAuditRow[];
  counts: Record<AndroidInternalsWikiDisposition, number>;
}

const EXCLUDED_STATUSES = new Set(['deprecated', 'quarantined', 'superseded']);
const RETRIEVABLE_STATUSES = new Set(['finalized', 'verified']);

function searchableText(article: AndroidInternalsWikiArticle): string {
  return [article.title ?? '', article.relativePath, ...article.tags]
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

function containsTerm(text: string, terms: readonly string[]): boolean {
  return terms.some(term => {
    const normalized = term.normalize('NFKC').toLowerCase();
    if (/\p{Script=Han}/u.test(normalized)) return text.includes(normalized);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, 'u').test(text);
  });
}

function emptyCounts(): Record<AndroidInternalsWikiDisposition, number> {
  return {
    candidate_skill_match: 0,
    validated_trace_skill: 0,
    explanation_only: 0,
    non_perfetto: 0,
    deferred_missing_schema_or_fixture: 0,
    metadata_error: 0,
    duplicate_or_superseded: 0,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : [];
}

function triggerKeywords(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(stringArray);
}

export function loadWikiCapabilityMap(filePath: string): WikiCapabilityMap {
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.domains)) {
    throw new Error('Android Internals capability map must use version 1 with domains');
  }
  return {
    domains: parsed.domains.map((domain: any) => {
      if (typeof domain?.id !== 'string') throw new Error('Capability domain id is required');
      return {
        id: domain.id,
        terms: stringArray(domain.terms),
        skillTags: stringArray(domain.skill_tags),
        ...(Array.isArray(domain.validations) ? {
          validations: domain.validations.map((validation: any) => {
            if (
              typeof validation?.skill_id !== 'string' ||
              typeof validation?.observable_claim !== 'string' ||
              typeof validation?.assertion_ref !== 'string' ||
              stringArray(validation?.article_paths).length === 0
            ) {
              throw new Error(`Capability validation is incomplete for ${domain.id}`);
            }
            return {
              skillId: validation.skill_id,
              observableClaim: validation.observable_claim,
              assertionRef: validation.assertion_ref,
              articlePaths: stringArray(validation.article_paths),
            };
          }),
        } : {}),
        ...(domain.defer_without_fixture === true ? {deferWithoutFixture: true} : {}),
      };
    }),
    nonPerfettoTerms: stringArray(parsed.non_perfetto_terms),
  };
}

function listSkillFiles(rootPath: string): string[] {
  const files: string[] = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== '_template') stack.push(fullPath);
      if (entry.isFile() && entry.name.endsWith('.skill.yaml') && !entry.name.startsWith('_')) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

export function loadAuditableSkills(rootPath: string): AuditableSkill[] {
  return listSkillFiles(rootPath).map(filePath => {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
    if (!parsed || typeof parsed.name !== 'string') {
      throw new Error(`Skill name missing in ${filePath}`);
    }
    const triggers = parsed.triggers;
    const triggerValues = Array.isArray(triggers)
      ? triggers.flatMap((trigger: unknown) => typeof trigger === 'string' ? [trigger] : [])
      : triggers && typeof triggers === 'object'
        ? [...triggerKeywords(triggers.keywords), ...stringArray(triggers.patterns)]
        : [];
    return {
      skillId: parsed.name,
      tags: stringArray(parsed.meta?.tags ?? parsed.tags),
      triggers: triggerValues,
    };
  }).sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export function loadValidatedAssertionRefs(
  manifestPath: string,
  logicalPath = 'backend/skills/public-fixtures.yaml',
): Set<string> {
  const parsed = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as any;
  const refs = new Set<string>();
  for (const fixture of Array.isArray(parsed?.fixtures) ? parsed.fixtures : []) {
    if (typeof fixture?.id !== 'string') continue;
    for (const assertion of Array.isArray(fixture.assertions) ? fixture.assertions : []) {
      if (typeof assertion?.query_id === 'string') {
        refs.add(`${logicalPath}#${fixture.id}:${assertion.query_id}`);
      }
    }
  }
  return refs;
}

export function auditAndroidInternalsWiki(
  corpus: AndroidInternalsWikiCorpus,
  capabilityMap: WikiCapabilityMap,
  skills: readonly AuditableSkill[],
  validatedAssertionRefs: ReadonlySet<string>,
): AndroidInternalsWikiAuditReport {
  const seenContent = new Map<string, string>();
  const rows: AndroidInternalsWikiAuditRow[] = [];

  for (const article of corpus.articles) {
    const base = {
      relativePath: article.relativePath,
      ...(article.title ? {title: article.title} : {}),
      ...(article.status ? {status: article.status} : {}),
      retrievalEligible: article.metadataValid &&
        RETRIEVABLE_STATUSES.has(article.status?.toLowerCase() ?? ''),
      candidateSkillIds: [] as string[],
      validatedAssertionRefs: [] as string[],
    };
    if (!article.metadataValid) {
      rows.push({
        ...base,
        retrievalEligible: false,
        disposition: 'metadata_error',
        reason: article.metadataError ?? 'frontmatter is invalid',
      });
      continue;
    }
    const status = article.status?.toLowerCase() ?? '';
    if (EXCLUDED_STATUSES.has(status)) {
      rows.push({
        ...base,
        retrievalEligible: false,
        disposition: 'duplicate_or_superseded',
        reason: `source status is ${status}`,
      });
      continue;
    }
    const duplicateOf = seenContent.get(article.contentHash);
    if (duplicateOf) {
      rows.push({
        ...base,
        retrievalEligible: false,
        disposition: 'duplicate_or_superseded',
        reason: `content duplicates ${duplicateOf}`,
        duplicateOf,
      });
      continue;
    }
    seenContent.set(article.contentHash, article.relativePath);

    const text = searchableText(article);
    if (containsTerm(text, capabilityMap.nonPerfettoTerms ?? [])) {
      rows.push({...base, disposition: 'non_perfetto', reason: 'matched non-Perfetto topic policy'});
      continue;
    }
    const matchedDomains = capabilityMap.domains.filter(candidate =>
      containsTerm(text, candidate.terms));
    if (matchedDomains.length === 0) {
      rows.push({...base, disposition: 'explanation_only', reason: 'no trace-observable capability domain matched'});
      continue;
    }
    const candidatesByDomain = new Map(matchedDomains.map(domain => {
      const wantedTags = new Set(domain.skillTags.map(tag => tag.toLowerCase()));
      return [domain.id, skills.filter(skill => {
        const signals = [...skill.tags, ...skill.triggers].map(signal => signal.toLowerCase());
        return signals.some(signal => wantedTags.has(signal));
      }).map(skill => skill.skillId)];
    }));
    const candidates = Array.from(new Set(
      Array.from(candidatesByDomain.values()).flat(),
    )).sort();
    const validationsByDomain = new Map(matchedDomains.map(domain => [
      domain.id,
      (domain.validations ?? []).filter(candidate =>
        candidate.articlePaths.includes(article.relativePath) &&
        (candidatesByDomain.get(domain.id) ?? []).includes(candidate.skillId) &&
        validatedAssertionRefs.has(candidate.assertionRef)),
    ]));
    const validations = Array.from(validationsByDomain.values()).flat();
    const matchedDomainIds = matchedDomains.map(domain => domain.id);
    const primaryDomainId = matchedDomainIds[0]!;
    const domainAssessments: AndroidInternalsWikiDomainAssessment[] = matchedDomains.map(domain => {
      const domainCandidates = (candidatesByDomain.get(domain.id) ?? []).sort();
      const domainValidations = validationsByDomain.get(domain.id) ?? [];
      return {
        domainId: domain.id,
        disposition: domainValidations.length > 0
          ? 'validated'
          : domainCandidates.length > 0
            ? 'candidate'
            : 'deferred',
        candidateSkillIds: domainCandidates,
        validatedAssertionRefs: Array.from(new Set(
          domainValidations.map(item => item.assertionRef),
        )).sort(),
      };
    });
    const validatedDomainIds = domainAssessments
      .filter(assessment => assessment.disposition === 'validated')
      .map(assessment => assessment.domainId);
    const unvalidatedDomainIds = domainAssessments
      .filter(assessment => assessment.disposition !== 'validated')
      .map(assessment => assessment.domainId);
    const disposition: AndroidInternalsWikiDisposition = unvalidatedDomainIds.length === 0
      ? 'validated_trace_skill'
      : domainAssessments.some(assessment => assessment.disposition === 'candidate')
        ? 'candidate_skill_match'
        : 'deferred_missing_schema_or_fixture';
    const validatedRefs = Array.from(new Set(
      validations.map(item => item.assertionRef),
    )).sort();
    rows.push({
      ...base,
      disposition,
      reason: disposition === 'validated_trace_skill'
        ? `every matched domain is validated by ${validatedRefs.join(', ')}`
        : disposition === 'candidate_skill_match'
          ? `unvalidated domains have live Skill candidates: ${unvalidatedDomainIds.join(', ')}`
          : `unvalidated domains require schema or fixtures: ${unvalidatedDomainIds.join(', ')}`,
      domainId: primaryDomainId,
      matchedDomainIds,
      validatedDomainIds,
      unvalidatedDomainIds,
      domainAssessments,
      candidateSkillIds: candidates,
      ...(validations.length > 0
        ? {observableClaim: validations.map(item => item.observableClaim).join(' ')}
        : {}),
      validatedAssertionRefs: validatedRefs,
    });
  }

  if (rows.length !== corpus.totalArticles) {
    throw new Error(`Article accounting mismatch: ${rows.length} != ${corpus.totalArticles}`);
  }
  const counts = emptyCounts();
  for (const row of rows) counts[row.disposition]++;
  return {totalArticles: corpus.totalArticles, rows, counts};
}
