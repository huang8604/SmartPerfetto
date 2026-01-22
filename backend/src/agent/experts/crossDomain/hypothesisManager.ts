/**
 * Hypothesis Manager
 *
 * Manages root cause hypotheses during cross-domain analysis.
 * Handles:
 * - Hypothesis creation and tracking
 * - Evidence accumulation
 * - Confidence scoring
 * - Hypothesis ranking and selection
 */

import {
  Hypothesis,
  HypothesisEvidence,
} from './types';

/**
 * Configuration for hypothesis management
 */
export interface HypothesisManagerConfig {
  /** Maximum number of hypotheses to track */
  maxHypotheses: number;
  /** Confidence threshold for confirmation */
  confidenceThreshold: number;
  /** Decay factor for old evidence */
  evidenceDecayFactor?: number;
  /** Minimum supporting evidence for confirmation */
  minSupportingEvidence?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<HypothesisManagerConfig> = {
  maxHypotheses: 5,
  confidenceThreshold: 0.85,
  evidenceDecayFactor: 0.95,
  minSupportingEvidence: 2,
};

/**
 * HypothesisManager - Manages hypothesis lifecycle
 */
export class HypothesisManager {
  private hypotheses: Map<string, Hypothesis> = new Map();
  private config: Required<HypothesisManagerConfig>;

  constructor(config: Partial<HypothesisManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Hypothesis CRUD
  // ===========================================================================

  /**
   * Add a new hypothesis
   */
  add(hypothesis: Hypothesis): void {
    // Check capacity
    if (this.hypotheses.size >= this.config.maxHypotheses) {
      this.pruneLowestConfidence();
    }

    this.hypotheses.set(hypothesis.id, hypothesis);
  }

  /**
   * Get a hypothesis by ID
   */
  get(id: string): Hypothesis | undefined {
    return this.hypotheses.get(id);
  }

  /**
   * Update a hypothesis
   */
  update(id: string, updates: Partial<Hypothesis>): Hypothesis | null {
    const hypothesis = this.hypotheses.get(id);
    if (!hypothesis) return null;

    const updated: Hypothesis = {
      ...hypothesis,
      ...updates,
      updatedAt: Date.now(),
    };

    this.hypotheses.set(id, updated);
    return updated;
  }

  /**
   * Remove a hypothesis
   */
  remove(id: string): boolean {
    return this.hypotheses.delete(id);
  }

  /**
   * Get all hypotheses
   */
  getAll(): Hypothesis[] {
    return Array.from(this.hypotheses.values());
  }

  /**
   * Get active (non-rejected) hypotheses
   */
  getActive(): Hypothesis[] {
    return this.getAll().filter(h => h.status !== 'rejected');
  }

  // ===========================================================================
  // Evidence Management
  // ===========================================================================

  /**
   * Add evidence to a hypothesis
   */
  addEvidence(
    hypothesisId: string,
    evidence: HypothesisEvidence
  ): Hypothesis | null {
    const hypothesis = this.hypotheses.get(hypothesisId);
    if (!hypothesis) return null;

    if (evidence.weight >= 0) {
      hypothesis.supportingEvidence.push(evidence);
    } else {
      hypothesis.contradictingEvidence.push(evidence);
    }

    // Recalculate confidence
    hypothesis.confidence = this.calculateConfidence(hypothesis);
    hypothesis.updatedAt = Date.now();

    // Check for status change
    this.updateStatus(hypothesis);

    this.hypotheses.set(hypothesisId, hypothesis);
    return hypothesis;
  }

  /**
   * Calculate confidence score for a hypothesis
   */
  calculateConfidence(hypothesis: Hypothesis): number {
    const supporting = hypothesis.supportingEvidence;
    const contradicting = hypothesis.contradictingEvidence;

    if (supporting.length === 0 && contradicting.length === 0) {
      return 0.3; // Base confidence for new hypothesis
    }

    // Calculate weighted sum of supporting evidence
    let supportScore = 0;
    for (const evidence of supporting) {
      supportScore += Math.abs(evidence.weight);
    }

    // Calculate weighted sum of contradicting evidence
    let contradictScore = 0;
    for (const evidence of contradicting) {
      contradictScore += Math.abs(evidence.weight);
    }

    // Normalize to 0-1 range
    const totalWeight = supportScore + contradictScore;
    if (totalWeight === 0) return 0.3;

    // Base confidence from evidence ratio
    let confidence = supportScore / totalWeight;

    // Boost for multiple supporting sources
    const uniqueSources = new Set(supporting.map(e => e.sourceModule));
    if (uniqueSources.size >= 2) {
      confidence = Math.min(1, confidence * 1.1);
    }
    if (uniqueSources.size >= 3) {
      confidence = Math.min(1, confidence * 1.1);
    }

    // Penalty for strong contradiction
    if (contradicting.some(e => Math.abs(e.weight) > 0.7)) {
      confidence *= 0.8;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  // ===========================================================================
  // Ranking and Selection
  // ===========================================================================

  /**
   * Get the top hypothesis by confidence
   */
  getTop(): Hypothesis | null {
    const active = this.getActive();
    if (active.length === 0) return null;

    return active.reduce((best, current) =>
      current.confidence > best.confidence ? current : best
    );
  }

  /**
   * Get hypotheses sorted by confidence (descending)
   */
  getRanked(): Hypothesis[] {
    return this.getActive().sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Check if any hypothesis meets confidence threshold
   */
  hasConfirmed(): boolean {
    return this.getActive().some(h =>
      h.status === 'confirmed' ||
      h.confidence >= this.config.confidenceThreshold
    );
  }

  /**
   * Get confirmed hypotheses
   */
  getConfirmed(): Hypothesis[] {
    return this.getAll().filter(h =>
      h.status === 'confirmed' ||
      (h.status !== 'rejected' && h.confidence >= this.config.confidenceThreshold)
    );
  }

  // ===========================================================================
  // Hypothesis Merging
  // ===========================================================================

  /**
   * Check if two hypotheses should be merged
   */
  shouldMerge(h1: Hypothesis, h2: Hypothesis): boolean {
    // Same component
    if (h1.component.toLowerCase() === h2.component.toLowerCase()) {
      return true;
    }

    // Same category and similar components
    if (h1.category === h2.category) {
      const similarity = this.componentSimilarity(h1.component, h2.component);
      return similarity > 0.7;
    }

    return false;
  }

  /**
   * Merge two hypotheses
   */
  merge(h1Id: string, h2Id: string): Hypothesis | null {
    const h1 = this.hypotheses.get(h1Id);
    const h2 = this.hypotheses.get(h2Id);

    if (!h1 || !h2) return null;

    // Keep the one with higher confidence
    const [keep, merge] = h1.confidence >= h2.confidence ? [h1, h2] : [h2, h1];

    // Combine evidence
    keep.supportingEvidence.push(...merge.supportingEvidence);
    keep.contradictingEvidence.push(...merge.contradictingEvidence);

    // Recalculate
    keep.confidence = this.calculateConfidence(keep);
    keep.updatedAt = Date.now();

    // Update description to mention merged hypothesis
    keep.description = `${keep.description}\n[Merged with: ${merge.title}]`;

    // Remove merged hypothesis
    this.hypotheses.delete(merge.id);

    return keep;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Update hypothesis status based on evidence
   */
  private updateStatus(hypothesis: Hypothesis): void {
    const { confidence, supportingEvidence, contradictingEvidence } = hypothesis;

    // Check for confirmation
    if (confidence >= this.config.confidenceThreshold &&
        supportingEvidence.length >= this.config.minSupportingEvidence) {
      hypothesis.status = 'confirmed';
      return;
    }

    // Check for rejection
    if (confidence < 0.2 && contradictingEvidence.length >= 2) {
      hypothesis.status = 'rejected';
      return;
    }

    // Mark as uncertain if low confidence with mixed evidence
    if (confidence < 0.5 &&
        supportingEvidence.length > 0 &&
        contradictingEvidence.length > 0) {
      hypothesis.status = 'uncertain';
      return;
    }

    // Default to exploring
    hypothesis.status = 'exploring';
  }

  /**
   * Remove the lowest confidence hypothesis to make room
   */
  private pruneLowestConfidence(): void {
    let lowest: Hypothesis | null = null;
    let lowestConfidence = Infinity;

    for (const hypothesis of this.hypotheses.values()) {
      if (hypothesis.status !== 'confirmed' && hypothesis.confidence < lowestConfidence) {
        lowest = hypothesis;
        lowestConfidence = hypothesis.confidence;
      }
    }

    if (lowest) {
      this.hypotheses.delete(lowest.id);
    }
  }

  /**
   * Calculate component name similarity (0-1)
   */
  private componentSimilarity(c1: string, c2: string): number {
    const s1 = c1.toLowerCase();
    const s2 = c2.toLowerCase();

    // Exact match
    if (s1 === s2) return 1;

    // One contains the other
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Word overlap
    const words1 = new Set(s1.split(/[_\s-]+/));
    const words2 = new Set(s2.split(/[_\s-]+/));
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Clear all hypotheses
   */
  clear(): void {
    this.hypotheses.clear();
  }
}
