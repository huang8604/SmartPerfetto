import type { DataEnvelope } from '../../types/dataContract';

export interface AssistantDiagnostic {
  id: string;
  category?: string;
  severity: 'critical' | 'high' | 'warning' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  confidence?: number;
  evidence?: unknown;
  timestampsNs?: unknown;
}

export interface AssistantAction {
  id: string;
  label: string;
  priority: 'high' | 'medium' | 'low';
  rationale?: string;
  sourceDiagnosticId?: string;
}

export interface AssistantResultContract {
  version: '1.0.0';
  dataEnvelopes: DataEnvelope[];
  diagnostics: AssistantDiagnostic[];
  actions: AssistantAction[];
}

export interface AssistantResultFinding {
  id?: string;
  category?: string;
  severity?: string;
  title?: string;
  description?: string;
  confidence?: number;
  evidence?: unknown;
  timestampsNs?: unknown;
  recommendations?: unknown;
}

export interface BuildAssistantResultContractParams {
  dataEnvelopes?: unknown[];
  findings?: AssistantResultFinding[];
}

interface NormalizedRecommendation {
  id?: string;
  label: string;
  priority?: number;
}

export function buildAssistantResultContract(
  params: BuildAssistantResultContractParams
): AssistantResultContract {
  const safeEnvelopes = normalizeEnvelopes(params.dataEnvelopes);
  const diagnostics = normalizeDiagnostics(params.findings);
  const actions = buildActions(params.findings || [], diagnostics);

  return {
    version: '1.0.0',
    dataEnvelopes: safeEnvelopes,
    diagnostics,
    actions,
  };
}

function normalizeEnvelopes(dataEnvelopes: unknown[] | undefined): DataEnvelope[] {
  if (!Array.isArray(dataEnvelopes)) return [];
  return dataEnvelopes.filter((item): item is DataEnvelope => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Record<string, unknown>;
    return !!candidate.meta && !!candidate.data && !!candidate.display;
  });
}

function normalizeDiagnostics(findings: AssistantResultFinding[] | undefined): AssistantDiagnostic[] {
  if (!Array.isArray(findings)) return [];

  return findings.map((finding, index) => {
    const title = toTrimmedString(finding.title) || `Finding ${index + 1}`;
    const description = toTrimmedString(finding.description) || title;
    return {
      id: toTrimmedString(finding.id) || `diag_${index + 1}`,
      category: toTrimmedString(finding.category) || undefined,
      severity: normalizeSeverity(finding.severity),
      title,
      description,
      confidence: typeof finding.confidence === 'number' ? finding.confidence : undefined,
      evidence: finding.evidence,
      timestampsNs: finding.timestampsNs,
    };
  });
}

function buildActions(
  findings: AssistantResultFinding[],
  diagnostics: AssistantDiagnostic[]
): AssistantAction[] {
  const dedupe = new Map<string, AssistantAction>();

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    const diagnostic = diagnostics[i];
    const recommendations = extractRecommendations(finding.recommendations);

    if (recommendations.length > 0) {
      for (let recIndex = 0; recIndex < recommendations.length; recIndex++) {
        const rec = recommendations[recIndex];
        const action: AssistantAction = {
          id: rec.id || `act_${diagnostic.id}_${recIndex + 1}`,
          label: rec.label,
          priority: normalizeActionPriority(rec.priority, diagnostic.severity),
          rationale: diagnostic.title,
          sourceDiagnosticId: diagnostic.id,
        };
        dedupeByLabel(dedupe, action);
      }
      continue;
    }

    if (diagnostic.severity === 'critical' || diagnostic.severity === 'high' || diagnostic.severity === 'warning') {
      const fallbackAction: AssistantAction = {
        id: `act_${diagnostic.id}_investigate`,
        label: `Investigate: ${diagnostic.title}`,
        priority: normalizeActionPriority(undefined, diagnostic.severity),
        rationale: diagnostic.description,
        sourceDiagnosticId: diagnostic.id,
      };
      dedupeByLabel(dedupe, fallbackAction);
    }
  }

  return Array.from(dedupe.values()).slice(0, 12);
}

function dedupeByLabel(target: Map<string, AssistantAction>, action: AssistantAction): void {
  const key = action.label.trim().toLowerCase();
  if (!key) return;
  if (!target.has(key)) {
    target.set(key, action);
  }
}

function extractRecommendations(recommendations: unknown): NormalizedRecommendation[] {
  if (!Array.isArray(recommendations)) return [];

  const out: NormalizedRecommendation[] = [];
  for (const recommendation of recommendations) {
    const normalized = normalizeRecommendation(recommendation);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizeRecommendation(value: unknown): NormalizedRecommendation | null {
  if (typeof value === 'string') {
    const label = value.trim();
    if (!label) return null;
    return { label };
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const label = toTrimmedString(record.text) || toTrimmedString(record.label);
  if (!label) return null;

  return {
    id: toTrimmedString(record.id) || undefined,
    label,
    priority: typeof record.priority === 'number' ? record.priority : undefined,
  };
}

function normalizeSeverity(value: unknown): AssistantDiagnostic['severity'] {
  const text = toTrimmedString(value).toLowerCase();
  if (text === 'critical' || text === 'high' || text === 'warning' || text === 'medium' || text === 'low' || text === 'info') {
    return text;
  }
  if (text === 'error') return 'high';
  if (text === 'warn') return 'warning';
  return 'info';
}

function normalizeActionPriority(
  numericPriority: number | undefined,
  severity: AssistantDiagnostic['severity']
): AssistantAction['priority'] {
  if (typeof numericPriority === 'number') {
    if (numericPriority <= 1) return 'high';
    if (numericPriority <= 2) return 'medium';
    return 'low';
  }
  if (severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'warning' || severity === 'medium') return 'medium';
  return 'low';
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
