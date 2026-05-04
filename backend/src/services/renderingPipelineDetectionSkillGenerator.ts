// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillDefinition } from './skillEngine/types';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  type PipelineDefinition,
} from './pipelineSkillLoader';

type ScopeColumn = 'app_cnt' | 'global_cnt';

const DEFAULT_PIPELINE_ID = 'ANDROID_VIEW_STANDARD_BLAST';
const DEFAULT_DOC_PATH = 'rendering_pipelines/android_view_standard.md';
const SCORE_THRESHOLD = 0.3;
const MAX_CANDIDATES = 5;

// Pipelines that represent orthogonal features (or implementation details) and should NOT win
// the primary pipeline selection. They can still appear in the "features" list.
//
// Note: This is about *ranking*, not how we count their detection signals.
const NON_PRIMARY_PIPELINE_IDS = new Set<string>([
  'VARIABLE_REFRESH_RATE',
  'VIDEO_OVERLAY_HWC',
  'ANDROID_PIP_FREEFORM',
  'ANDROID_VIEW_MULTI_WINDOW',
  'ANGLE_GLES_VULKAN',
]);

// Pipelines whose detection signals often live outside the app processes (e.g. SurfaceFlinger/system_server),
// so we should score them using global counts instead of app-filtered counts.
const GLOBAL_SCOPE_PIPELINE_IDS = new Set<string>([
  'VARIABLE_REFRESH_RATE',
  'VIDEO_OVERLAY_HWC',
  'ANDROID_PIP_FREEFORM',
]);

// Pipelines that should be surfaced in the "features" list.
const FEATURE_PIPELINE_IDS = new Set<string>([
  'VARIABLE_REFRESH_RATE',
  'VIDEO_OVERLAY_HWC',
  'SURFACE_CONTROL_API',
  'ANDROID_PIP_FREEFORM',
  'ANDROID_VIEW_MULTI_WINDOW',
  'ANGLE_GLES_VULKAN',
]);

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizePositiveInt(value: unknown, fallback = 1): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeNonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function getScopeColumn(pipelineId: string): ScopeColumn {
  return GLOBAL_SCOPE_PIPELINE_IDS.has(pipelineId) ? 'global_cnt' : 'app_cnt';
}

function buildCountSubquery(params: {
  table: 'thread_counts' | 'slice_counts';
  nameColumn: 'thread_name' | 'slice_name';
  op: '=' | 'GLOB';
  pattern: string;
  scopeColumn: ScopeColumn;
}): string {
  return `COALESCE((SELECT SUM(${params.scopeColumn}) FROM ${params.table} WHERE ${params.nameColumn} ${params.op} ${sqlStringLiteral(params.pattern)}), 0)`;
}

function buildSignalCountExpr(
  signal: {
    thread?: string;
    thread_pattern?: string;
    slice?: string;
    slice_pattern?: string;
  },
  scopeColumn: ScopeColumn
): string | null {
  const exprs: string[] = [];

  if (signal.thread) {
    exprs.push(
      buildCountSubquery({
        table: 'thread_counts',
        nameColumn: 'thread_name',
        op: '=',
        pattern: signal.thread,
        scopeColumn,
      })
    );
  }

  if (signal.thread_pattern) {
    exprs.push(
      buildCountSubquery({
        table: 'thread_counts',
        nameColumn: 'thread_name',
        op: 'GLOB',
        pattern: signal.thread_pattern,
        scopeColumn,
      })
    );
  }

  if (signal.slice) {
    exprs.push(
      buildCountSubquery({
        table: 'slice_counts',
        nameColumn: 'slice_name',
        op: '=',
        pattern: signal.slice,
        scopeColumn,
      })
    );
  }

  if (signal.slice_pattern) {
    exprs.push(
      buildCountSubquery({
        table: 'slice_counts',
        nameColumn: 'slice_name',
        op: 'GLOB',
        pattern: signal.slice_pattern,
        scopeColumn,
      })
    );
  }

  if (exprs.length === 0) return null;
  return exprs.join(' + ');
}

function describeSignalKey(signal: {
  thread?: string;
  thread_pattern?: string;
  slice?: string;
  slice_pattern?: string;
}): string {
  if (signal.thread) return `thread:${signal.thread}`;
  if (signal.thread_pattern) return `thread_pattern:${signal.thread_pattern}`;
  if (signal.slice) return `slice:${signal.slice}`;
  if (signal.slice_pattern) return `slice_pattern:${signal.slice_pattern}`;
  return 'unknown';
}

function buildPipelineListSql(pipelines: PipelineDefinition[]): string {
  if (pipelines.length === 0) {
    return `SELECT ${sqlStringLiteral(DEFAULT_PIPELINE_ID)} as pipeline_id`;
  }
  return pipelines
    .map((p) => `SELECT ${sqlStringLiteral(p.meta.pipeline_id)} as pipeline_id`)
    .join('\n        UNION ALL\n        ');
}

function buildPipelineDocsSql(pipelines: PipelineDefinition[]): string {
  if (pipelines.length === 0) {
    return `SELECT ${sqlStringLiteral(DEFAULT_PIPELINE_ID)} as pipeline_id, ${sqlStringLiteral(DEFAULT_DOC_PATH)} as doc_path`;
  }
  return pipelines
    .map((p) => {
      const docPath = p.meta.doc_path ? sqlStringLiteral(p.meta.doc_path) : 'NULL';
      return `SELECT ${sqlStringLiteral(p.meta.pipeline_id)} as pipeline_id, ${docPath} as doc_path`;
    })
    .join('\n        UNION ALL\n        ');
}

function buildSignalsRowsSql(pipelines: PipelineDefinition[]): string {
  const rows: string[] = [];

  for (const pipeline of pipelines) {
    const pipelineId = pipeline.meta.pipeline_id;
    const detection = pipeline.detection;
    if (!detection) continue;

    const scopeColumn = getScopeColumn(pipelineId);

    for (const req of detection.required_signals || []) {
      const minCount = normalizePositiveInt(req.min_count, 1);
      const cntExpr = buildSignalCountExpr(req, scopeColumn);
      if (!cntExpr) {
        console.warn(`[rendering_pipeline_detection] Invalid required_signals entry for ${pipelineId}:`, req);
        continue;
      }
      rows.push(
        `SELECT ${sqlStringLiteral(pipelineId)} as pipeline_id, 'required' as signal_type, ${sqlStringLiteral(describeSignalKey(req))} as signal_name, 0 as weight, ${minCount} as min_count, (${cntExpr}) as cnt`
      );
    }

    for (const sc of detection.scoring_signals || []) {
      const minCount = normalizePositiveInt(sc.min_count, 1);
      const weight = normalizeNonNegativeInt(sc.weight, 0);
      const cntExpr = buildSignalCountExpr(sc, scopeColumn);
      if (!cntExpr) {
        console.warn(`[rendering_pipeline_detection] Invalid scoring_signals entry for ${pipelineId} (${sc.signal}):`, sc);
        continue;
      }
      rows.push(
        `SELECT ${sqlStringLiteral(pipelineId)} as pipeline_id, 'score' as signal_type, ${sqlStringLiteral(sc.signal)} as signal_name, ${weight} as weight, ${minCount} as min_count, (${cntExpr}) as cnt`
      );
    }

    for (const ex of detection.exclude_if || []) {
      const cntExpr = buildSignalCountExpr(ex, scopeColumn);
      if (!cntExpr) {
        console.warn(`[rendering_pipeline_detection] Invalid exclude_if entry for ${pipelineId}:`, ex);
        continue;
      }
      rows.push(
        `SELECT ${sqlStringLiteral(pipelineId)} as pipeline_id, 'exclude' as signal_type, ${sqlStringLiteral(describeSignalKey(ex))} as signal_name, 0 as weight, 1 as min_count, (${cntExpr}) as cnt`
      );
    }
  }

  if (rows.length === 0) {
    return `SELECT ${sqlStringLiteral(DEFAULT_PIPELINE_ID)} as pipeline_id, 'score' as signal_type, 'noop' as signal_name, 0 as weight, 1 as min_count, 0 as cnt`;
  }

  return rows.join('\n        UNION ALL\n        ');
}

function buildDeterminePipelineSql(pipelines: PipelineDefinition[]): string {
  const pipelineListSql = buildPipelineListSql(pipelines);
  const pipelineDocsSql = buildPipelineDocsSql(pipelines);
  const signalsRowsSql = buildSignalsRowsSql(pipelines);

  const primaryExcludeSql = Array.from(NON_PRIMARY_PIPELINE_IDS)
    .map((id) => sqlStringLiteral(id))
    .join(', ');

  const featureIdsSql = Array.from(FEATURE_PIPELINE_IDS)
    .map((id) => sqlStringLiteral(id))
    .join(', ');

  // NOTE: We intentionally avoid `${stepId}`-as-table substitution because SkillExecutor stores
  // step results as JS objects, not temp tables. This SQL is self-contained.
  return `
      WITH
      -- Identify a dominant app (when package is not provided) by looking for rendering-related slices,
      -- then include *all* processes that share the same package prefix. This reduces false positives
      -- from multi-app traces while still supporting multi-process apps (e.g. WebView renderers).
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
      thread_counts AS (
        SELECT
          t.name as thread_name,
          SUM(CASE WHEN t.upid IN (SELECT upid FROM app_filter_upids) THEN 1 ELSE 0 END) as app_cnt,
          COUNT(*) as global_cnt
        FROM thread t
        WHERE t.name IS NOT NULL
        GROUP BY t.name
      ),
      slice_counts AS (
        SELECT
          s.name as slice_name,
          SUM(CASE WHEN p.upid IN (SELECT upid FROM app_filter_upids) THEN 1 ELSE 0 END) as app_cnt,
          COUNT(*) as global_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
        GROUP BY s.name
      ),
      pipeline_list AS (
        ${pipelineListSql}
      ),
      pipeline_docs AS (
        ${pipelineDocsSql}
      ),
      signals AS (
        ${signalsRowsSql}
      ),
      signal_agg AS (
        SELECT
          pipeline_id,
          MIN(
            CASE
              WHEN signal_type = 'required' THEN CASE WHEN cnt >= min_count THEN 1 ELSE 0 END
              ELSE 1
            END
          ) as required_ok,
          MAX(
            CASE
              WHEN signal_type = 'exclude' THEN CASE WHEN cnt > 0 THEN 1 ELSE 0 END
              ELSE 0
            END
          ) as excluded,
          SUM(CASE WHEN signal_type = 'score' THEN weight ELSE 0 END) as total_weight,
          SUM(CASE WHEN signal_type = 'score' AND cnt >= min_count THEN weight ELSE 0 END) as matched_weight
        FROM signals
        GROUP BY pipeline_id
      ),
      pipeline_scores AS (
        SELECT
          pl.pipeline_id,
          COALESCE(sa.required_ok, 1) as required_ok,
          COALESCE(sa.excluded, 0) as excluded,
          COALESCE(sa.total_weight, 0) as total_weight,
          COALESCE(sa.matched_weight, 0) as matched_weight
        FROM pipeline_list pl
        LEFT JOIN signal_agg sa ON sa.pipeline_id = pl.pipeline_id
      ),
      scores AS (
        SELECT
          pipeline_id,
          CASE
            WHEN required_ok = 1 AND excluded = 0 AND total_weight > 0
            THEN matched_weight * 1.0 / total_weight
            ELSE 0
          END as score
        FROM pipeline_scores
      ),
      ranked AS (
        SELECT
          pipeline_id,
          score,
          ROW_NUMBER() OVER (ORDER BY score DESC, pipeline_id ASC) as rank
        FROM scores
        WHERE score >= ${SCORE_THRESHOLD}
          ${primaryExcludeSql ? `AND pipeline_id NOT IN (${primaryExcludeSql})` : ''}
      ),
      primary_pipeline AS (
        SELECT pipeline_id, score FROM ranked WHERE rank = 1
      ),
      candidates AS (
        SELECT pipeline_id, score FROM ranked WHERE rank <= ${MAX_CANDIDATES}
      ),
      features AS (
        SELECT pipeline_id, score FROM scores
        WHERE pipeline_id IN (${featureIdsSql})
          AND score >= ${SCORE_THRESHOLD}
      ),
      candidate_list AS (
        SELECT GROUP_CONCAT(pipeline_id || ':' || ROUND(score, 2), ',') as candidates_list
        FROM candidates
        GROUP BY 'all_candidates'
      ),
      feature_list AS (
        SELECT GROUP_CONCAT(pipeline_id || ':' || ROUND(score, 2), ',') as features_list
        FROM features
        GROUP BY 'all_features'
      ),
      result AS (
        SELECT
          COALESCE((SELECT pipeline_id FROM primary_pipeline), ${sqlStringLiteral(DEFAULT_PIPELINE_ID)}) as primary_pipeline_id,
          COALESCE((SELECT score FROM primary_pipeline), 0.50) as primary_confidence,
          COALESCE((SELECT candidates_list FROM candidate_list), '') as candidates_list,
          COALESCE((SELECT features_list FROM feature_list), '') as features_list
      )
      SELECT
        r.primary_pipeline_id,
        r.primary_confidence,
        r.candidates_list,
        r.features_list,
        COALESCE((SELECT doc_path FROM pipeline_docs WHERE pipeline_id = r.primary_pipeline_id), ${sqlStringLiteral(DEFAULT_DOC_PATH)}) as doc_path
      FROM result r
    `;
}

function buildSubvariantsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
      thread_counts AS (
        SELECT
          t.name as thread_name,
          COUNT(*) as cnt
        FROM thread t
        WHERE t.name IS NOT NULL
          AND t.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY t.name
      ),
      slice_counts AS (
        SELECT
          s.name as slice_name,
          COUNT(*) as cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
          AND p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY s.name
      )
      SELECT
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) > 0 THEN 'BLAST'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*queueBuffer*'), 0) > 0 THEN 'LEGACY'
          ELSE 'UNKNOWN'
        END as buffer_mode,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name IN ('ui', '1.ui')), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*Impeller*' OR slice_name GLOB '*EntityPass*'), 0) > 0
          THEN 'IMPELLER'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name IN ('ui', '1.ui')), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*SkGpu*' OR slice_name GLOB '*SkiaGpu*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*EntityPass*'), 0) = 0
          THEN 'SKIA'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name IN ('ui', '1.ui')), 0) > 0
          THEN 'UNKNOWN'
          ELSE 'N/A'
        END as flutter_engine,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts
                         WHERE thread_name = 'VizCompositorThread'
                            OR thread_name GLOB 'VizCompositorThread*'
                            OR thread_name = 'VizCompositor'
                            OR thread_name GLOB 'VizCompositor*'), 0) > 0
          THEN 'SURFACE_CONTROL'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*DrawGL*' OR slice_name GLOB '*DrawFunctor*'), 0) > 0
          THEN 'GL_FUNCTOR'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*TBS*' OR slice_name GLOB '*X5*' OR slice_name GLOB '*UCCore*'), 0) > 0
          THEN 'TEXTUREVIEW_CUSTOM'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*WebView*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*SurfaceView*'), 0) > 0
          THEN 'SURFACEVIEW_WRAPPER'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB '*Chrome*' OR thread_name GLOB 'CrRendererMain*'), 0) > 0
          THEN 'UNKNOWN'
          ELSE 'N/A'
        END as webview_mode,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB 'UnityMain*'), 0) > 0 THEN 'UNITY'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB 'GameThread*' OR thread_name GLOB 'RHIThread*'), 0) > 0 THEN 'UNREAL'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB 'GodotMain*'), 0) > 0 THEN 'GODOT'
          ELSE 'N/A'
        END as game_engine
    `;
}

function buildTraceRequirementsSql(): string {
  // Keep hints conservative and app-scoped where possible.
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      )
      SELECT
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE p.upid IN (SELECT upid FROM app_filter_upids)
              AND t.name = 'RenderThread'
              AND s.name GLOB 'DrawFrame*'
            LIMIT 1
          )
          THEN 'gfx: RenderThread/DrawFrame slices missing (enable atrace: gfx)'
          ELSE NULL
        END as hint_gfx,
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE p.upid IN (SELECT upid FROM app_filter_upids)
              AND s.name GLOB '*Choreographer#doFrame*'
            LIMIT 1
          )
          THEN 'input: Choreographer#doFrame missing (enable atrace: input/view)'
          ELSE NULL
        END as hint_input,
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE p.upid IN (SELECT upid FROM app_filter_upids)
              AND (
                s.name GLOB '*BLASTBufferQueue*'
                OR s.name GLOB '*applyTransaction*'
                OR s.name GLOB '*queueBuffer*'
                OR s.name GLOB '*dequeueBuffer*'
              )
            LIMIT 1
          )
          THEN 'BufferQueue/Transaction slices missing (enable atrace: gfx/sf)'
          ELSE NULL
        END as hint_buffer,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM process p WHERE p.name = 'surfaceflinger' LIMIT 1)
          THEN 'SurfaceFlinger process missing (need system tracing / root on some devices)'
          ELSE NULL
        END as hint_sf,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM slice s WHERE s.name GLOB '*FrameTimeline*' LIMIT 1)
          THEN 'FrameTimeline missing (enable SurfaceFlinger FrameTimeline / Android 12+)'
          ELSE NULL
        END as hint_timeline
    `;
}

function buildActiveRenderingProcessesSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*unlockCanvasAndPost*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FramePacing*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
            OR (s.name GLOB '*Rasterizer::DrawToSurfaces*')
            OR (s.name GLOB '*Engine::BeginFrame*')
            OR (s.name GLOB '*EntityPass*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
      marker_slices AS (
        SELECT
          p.upid,
          p.name as process_name,
          t.tid,
          t.name as thread_name
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.upid IN (SELECT upid FROM app_filter_upids)
          AND p.name IS NOT NULL
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FramePacing*')
            OR (s.name GLOB '*updateTexImage*')
            OR (s.name GLOB '*Rasterizer::DrawToSurfaces*')
            OR (s.name GLOB '*Engine::BeginFrame*')
            OR (s.name GLOB '*EntityPass*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*unlockCanvasAndPost*')
          )
      )
      SELECT
        upid,
        process_name,
        COUNT(*) as frame_count,
        MAX(CASE WHEN thread_name = 'RenderThread' THEN tid ELSE NULL END) as render_thread_tid
      FROM marker_slices
      GROUP BY upid
      HAVING frame_count > 5
      ORDER BY frame_count DESC
      LIMIT 10
    `;
}

// =============================================================================
// Phase B: Article-grounded 4-feature signal extractors
// =============================================================================
// Adds three orthogonal output channels that the LLM Agent and downstream skills
// can consume for article-grounded diagnosis (S01 §4 特征分型 + 12 锚点).
// These SQL builders are PURELY ADDITIVE — they don't modify the primary scoring
// in buildDeterminePipelineSql, so existing canonical regression remains stable.
// =============================================================================

/**
 * S01 §4 特征分型 [feature 2: layer count]
 * Queries SurfaceFlinger-side layer information for the dominant App.
 *
 * Layer count is the article's decisive signal:
 * - Standard HWUI / Compose / TextureView: 1 layer (host window only)
 * - SurfaceView / Mixed (with SV) / Multi-window: ≥2 layers
 * - WebView Functor / TextureView Custom: 0 independent layer (回宿主)
 * - WebView SurfaceControl: N overlay candidates
 */
function buildLayerSignalsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*FrameTimeline*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_layers AS (
        -- FrameTimeline 提供 layer_name 维度（Android 12+）
        SELECT DISTINCT layer_name
        FROM android_frames_layers
        WHERE layer_name IS NOT NULL
          AND (
            ('\${package}' <> '' AND layer_name GLOB '*' || '\${package}' || '*')
            OR ('\${package}' = '' AND layer_name GLOB '*' || (SELECT pkg FROM dominant_pkg) || '*')
          )
      )
      SELECT
        COALESCE((SELECT COUNT(*) FROM app_layers), 0) as app_layer_count,
        COALESCE((SELECT GROUP_CONCAT(layer_name, '; ') FROM app_layers), '') as app_layer_names,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*SurfaceView*' OR layer_name GLOB 'SurfaceView*') > 0 THEN 1
          ELSE 0
        END as has_surfaceview_layer,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*video*' OR layer_name GLOB '*Video*' OR layer_name GLOB '*MediaCodec*') > 0 THEN 1
          ELSE 0
        END as has_video_layer,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*io.flutter*' OR layer_name GLOB '*Flutter*') > 0 THEN 1
          ELSE 0
        END as has_flutter_layer,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*Camera*' OR layer_name GLOB '*camera*') > 0 THEN 1
          ELSE 0
        END as has_camera_layer
    `;
}

/**
 * S01 §4 特征分型 [feature 4: extra rhythm sources]
 * Detects non-vsync-app rhythm sources in the App scope:
 * - Swappy/SwappyVk frame pacing
 * - AChoreographer (NDK Choreographer)
 * - setFrameRate / setFrameRateCategory APIs
 * - Camera HAL sensor trigger
 * - MediaCodec codec pacing
 * - Game engine main loop
 *
 * Used by LLM Agent to know whether the App relies on vsync-app or has its own rhythm.
 */
function buildExtraRhythmSignalsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
      app_slices AS (
        SELECT s.name as slice_name, COUNT(*) as cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
          AND p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY s.name
      )
      SELECT
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*Swappy*'), 0) as swappy_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*SwappyVk_*'), 0) as swappy_vk_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*AChoreographer*'), 0) as achoreographer_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*setFrameRate*'), 0) as set_frame_rate_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*setFrameRateCategory*'), 0) as set_frame_rate_category_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*PlayerLoop*' OR slice_name GLOB '*FEngineLoop*' OR slice_name GLOB '*MainLoop*'), 0) as engine_main_loop_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*processCaptureRequest*' OR slice_name GLOB '*processCaptureResult*'), 0) as camera_capture_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*releaseOutputBuffer*' OR slice_name GLOB '*MediaCodec*'), 0) as mediacodec_pacing_count,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*Swappy*' OR slice_name GLOB '*SwappyVk_*'), 0) > 0 THEN 'swappy_pacing'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*AChoreographer*'), 0) > 0 THEN 'achoreographer'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*PlayerLoop*' OR slice_name GLOB '*FEngineLoop*' OR slice_name GLOB '*MainLoop*'), 0) > 0 THEN 'engine_main_loop'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*processCaptureRequest*'), 0) > 0 THEN 'camera_sensor_trigger'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*releaseOutputBuffer*'), 0) > 0 THEN 'video_codec_pacing'
          ELSE 'vsync_app_only'
        END as primary_rhythm_source
    `;
}

/**
 * S01 §4 特征分型 [feature 3: queueBuffer path]
 * Distinguishes the BufferQueue path:
 * - BBQ_TRANSACTION_INPROC (BLAST: applyTransaction + BLASTBufferQueue both present)
 * - BUFFERQUEUE_INPROC (Legacy: queueBuffer present BUT no BLAST signals)
 * - HOST_RESAMPLE (TextureView: updateTexImage on RenderThread + SurfaceTexture)
 * - ACQUIRE_FENCE_NONE_INPROC (Software: lockCanvas/unlockCanvasAndPost)
 * - SURFACECONTROL_TRANSACTION_DIRECT (NDK: ASurfaceTransaction without BLAST)
 *
 * Used by LLM Agent to know which buffer path the trace exhibits, regardless of
 * which primary pipeline got selected by detection scoring.
 */
function buildBufferqueuePathSignalsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
      app_slices AS (
        SELECT s.name as slice_name, COUNT(*) as cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
          AND p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY s.name
      )
      SELECT
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) as blast_bq_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) as apply_transaction_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*queueBuffer*'), 0) as queue_buffer_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*updateTexImage*'), 0) as update_tex_image_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*lockCanvas*'), 0) as lock_canvas_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*unlockCanvasAndPost*'), 0) as unlock_canvas_post_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*ASurfaceTransaction*'), 0) as asurface_transaction_count,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) > 0
            THEN 'BBQ_TRANSACTION_INPROC'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*ASurfaceTransaction*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
            THEN 'SURFACECONTROL_TRANSACTION_DIRECT'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*updateTexImage*'), 0) > 0
            THEN 'HOST_RESAMPLE'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*lockCanvas*' OR slice_name GLOB '*unlockCanvasAndPost*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
            THEN 'ACQUIRE_FENCE_NONE_INPROC'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*queueBuffer*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) = 0
            THEN 'BUFFERQUEUE_INPROC'
          ELSE 'UNKNOWN'
        END as bufferqueue_path
    `;
}

export async function generateRenderingPipelineDetectionSkill(): Promise<SkillDefinition> {
  await ensurePipelineSkillsInitialized();

  const pipelines = pipelineSkillLoader
    .getAllPipelines()
    .filter((p) => p?.meta?.pipeline_id)
    .sort((a, b) => a.meta.pipeline_id.localeCompare(b.meta.pipeline_id));

  const determinePipelineSql = buildDeterminePipelineSql(pipelines);
  const subvariantsSql = buildSubvariantsSql();
  const traceRequirementsSql = buildTraceRequirementsSql();
  const activeProcessesSql = buildActiveRenderingProcessesSql();
  // Phase B: 4-feature 分型新增 SQL（layer 数 / 额外节奏 / bufferqueue 路径）
  const layerSignalsSql = buildLayerSignalsSql();
  const extraRhythmSignalsSql = buildExtraRhythmSignalsSql();
  const bufferqueuePathSignalsSql = buildBufferqueuePathSignalsSql();

  return {
    name: 'rendering_pipeline_detection',
    version: '3.2',
    type: 'composite',
    category: 'rendering',
    meta: {
      display_name: '渲染管线检测 (YAML 驱动)',
      description: '从 pipeline YAML detection 配置生成打分规则，输出主管线/候选/特性',
      icon: 'layers',
      tags: ['rendering', 'pipeline', 'detection', 'teaching', 'yaml'],
    },
    prerequisites: {
      required_tables: ['slice', 'thread_track', 'thread', 'process'],
      optional_tables: ['counter', 'counter_track'],
      modules: ['slices.with_context', 'android.frames.timeline'],
    },
    inputs: [
      {
        name: 'package',
        type: 'string',
        required: false,
        description: '应用包名 (可选，用于过滤)',
      },
    ],
    steps: [
      {
        id: 'determine_pipeline',
        type: 'atomic',
        name: '确定主管线 (YAML 驱动)',
        display: {
          level: 'summary',
          title: '渲染管线识别结果',
        },
        sql: determinePipelineSql,
        save_as: 'pipeline_result',
      },
      {
        id: 'subvariants',
        type: 'atomic',
        name: '确定子变体',
        display: {
          level: 'detail',
          title: '子变体检测',
        },
        sql: subvariantsSql,
        save_as: 'subvariants',
      },
      {
        id: 'trace_requirements',
        type: 'atomic',
        name: '检查采集完整性',
        display: {
          level: 'detail',
          title: '采集建议',
        },
        sql: traceRequirementsSql,
        save_as: 'trace_requirements',
      },
      {
        id: 'active_rendering_processes',
        type: 'atomic',
        name: '识别活跃渲染进程',
        display: {
          level: 'detail',
          title: '活跃渲染进程',
        },
        sql: activeProcessesSql,
        save_as: 'active_rendering_processes',
      },
      // ----- Phase B: Article-grounded 4 特征分型扩展 -----
      {
        id: 'layer_signals',
        type: 'atomic',
        name: 'SF Layer 数与名字模式 (S01 §4 特征分型 - feature 2)',
        display: {
          level: 'detail',
          title: 'Layer 信号',
        },
        sql: layerSignalsSql,
        save_as: 'layer_signals',
      },
      {
        id: 'extra_rhythm_signals',
        type: 'atomic',
        name: '额外节奏源 (S01 §4 特征分型 - feature 4)',
        display: {
          level: 'detail',
          title: '额外节奏源',
        },
        sql: extraRhythmSignalsSql,
        save_as: 'extra_rhythm_signals',
      },
      {
        id: 'bufferqueue_path_signals',
        type: 'atomic',
        name: 'BufferQueue 路径分型 (S01 §4 特征分型 - feature 3)',
        display: {
          level: 'detail',
          title: 'BufferQueue 路径',
        },
        sql: bufferqueuePathSignalsSql,
        save_as: 'bufferqueue_path_signals',
      },
      {
        id: 'pipeline_bundle',
        type: 'pipeline',
        name: '聚合渲染管线教学结果',
        pipeline_source: 'pipeline_result',
        active_processes_source: 'active_rendering_processes',
        trace_requirements_source: 'trace_requirements',
        display: {
          level: 'summary',
          title: '渲染管线教学聚合结果',
          format: 'summary',
        },
        save_as: 'pipeline_bundle',
      },
    ],
    output: {
      fields: [
        { name: 'pipeline_result', label: '主管线识别结果' },
        { name: 'subvariants', label: '子变体信息' },
        { name: 'trace_requirements', label: '采集完整性检查' },
        { name: 'active_rendering_processes', label: '活跃渲染进程列表 (用于智能 Pin)' },
        // Phase B: 4 特征分型扩展（用于 LLM Agent 与下游 skill 引用）
        { name: 'layer_signals', label: 'Layer 信号 (SF 侧 layer 数与命名模式)' },
        { name: 'extra_rhythm_signals', label: '额外节奏源 (Swappy/AChoreographer/Camera/Codec)' },
        { name: 'bufferqueue_path_signals', label: 'BufferQueue 路径分型' },
        { name: 'pipeline_bundle', label: '渲染管线教学聚合结果' },
      ],
    },
  };
}
