/**
 * 诊断滑动掉帧检测问题
 *
 * 运行: npx tsx backend/src/scripts/diagnoseJankDetection.ts [port]
 * 默认端口: 9100
 */

import http from 'http';
import { encodeQueryArgs, decodeQueryResult } from '../services/traceProcessorProtobuf';

async function executeQuery(port: number, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const requestBody = encodeQueryArgs(sql);

    const options = {
      hostname: 'localhost',
      port,
      path: '/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Content-Length': requestBody.length,
      },
      timeout: 30000,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBuffer = Buffer.concat(chunks);
        try {
          const parsed = decodeQueryResult(responseBuffer);
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            // Convert to array of objects
            const rows = parsed.rows.map((row: any[]) => {
              const obj: any = {};
              parsed.columnNames.forEach((col: string, i: number) => {
                obj[col] = row[i];
              });
              return obj;
            });
            resolve(rows);
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Query timeout')));
    req.write(requestBody);
    req.end();
  });
}

async function diagnose(port: number) {
  console.log('='.repeat(60));
  console.log(`诊断 Trace Processor (端口: ${port})`);
  console.log('='.repeat(60));

  const diagnosticQueries = [
    {
      name: '1. Frame Timeline 数据量',
      sql: `SELECT COUNT(*) as count FROM actual_frame_timeline_slice`,
      check: (r: any[]) => r[0]?.count > 0 ? `✅ ${r[0].count} 帧` : '❌ 无帧数据'
    },
    {
      name: '2. VSYNC-sf Counter',
      sql: `SELECT COUNT(*) as count FROM counter c
            JOIN counter_track t ON c.track_id = t.id
            WHERE t.name = 'VSYNC-sf'`,
      check: (r: any[]) => r[0]?.count > 0 ? `✅ ${r[0].count} 条` : '❌ 无 VSYNC-sf 信号'
    },
    {
      name: '3. BufferTX Counter',
      sql: `SELECT DISTINCT t.name, COUNT(*) as count
            FROM counter c
            JOIN counter_track t ON c.track_id = t.id
            WHERE t.name LIKE '%BufferTX%'
            GROUP BY t.name`,
      check: (r: any[]) => r.length > 0
        ? `✅ 找到 ${r.length} 个 BufferTX track`
        : '⚠️ 无 BufferTX 数据（这可能导致掉帧漏检！）'
    },
    {
      name: '4. VSYNC 周期检测',
      sql: `WITH vsync_intervals AS (
              SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
              FROM counter c
              JOIN counter_track t ON c.track_id = t.id
              WHERE t.name = 'VSYNC-sf'
            )
            SELECT
              ROUND(AVG(interval_ns) / 1e6, 2) as avg_interval_ms,
              ROUND(MIN(interval_ns) / 1e6, 2) as min_interval_ms,
              ROUND(MAX(interval_ns) / 1e6, 2) as max_interval_ms,
              COUNT(*) as sample_count
            FROM vsync_intervals
            WHERE interval_ns > 5000000 AND interval_ns < 50000000`,
      check: (r: any[]) => {
        if (!r[0]?.avg_interval_ms) return '❌ 无法计算 VSYNC 周期';
        const avg = r[0].avg_interval_ms;
        if (avg > 14 && avg < 18) return `✅ 60Hz 设备 (周期=${avg}ms)`;
        if (avg > 7 && avg < 10) return `✅ 120Hz 设备 (周期=${avg}ms)`;
        return `⚠️ 异常周期 (${avg}ms)`;
      }
    },
    {
      name: '5. App 报告的掉帧 (jank_type)',
      sql: `SELECT jank_type, COUNT(*) as count
            FROM actual_frame_timeline_slice
            WHERE jank_type != 'None' AND jank_type IS NOT NULL
            GROUP BY jank_type
            ORDER BY count DESC`,
      check: (r: any[]) => {
        if (r.length === 0) return '✅ App 未报告任何掉帧';
        const total = r.reduce((s, x) => s + (x.count || 0), 0);
        const types = r.map(x => `${x.jank_type}(${x.count})`).join(', ');
        return `⚠️ App 报告 ${total} 个掉帧: ${types}`;
      }
    },
    {
      name: '6. VSYNC-sf 间隔检测掉帧 (关键!)',
      sql: `WITH vsync_intervals AS (
              SELECT
                c.ts,
                c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
              FROM counter c
              JOIN counter_track t ON c.track_id = t.id
              WHERE t.name = 'VSYNC-sf'
            ),
            vsync_period AS (
              SELECT COALESCE(
                CAST(AVG(interval_ns) AS INTEGER),
                16666666
              ) as period_ns
              FROM vsync_intervals
              WHERE interval_ns > 5000000 AND interval_ns < 50000000
            )
            SELECT
              COUNT(*) as total_vsync,
              SUM(CASE WHEN interval_ns > (SELECT period_ns FROM vsync_period) * 1.5 THEN 1 ELSE 0 END) as jank_1_5x,
              SUM(CASE WHEN interval_ns > (SELECT period_ns FROM vsync_period) * 1.2 THEN 1 ELSE 0 END) as jank_1_2x,
              SUM(CASE WHEN interval_ns > (SELECT period_ns FROM vsync_period) * 1.0 THEN 1 ELSE 0 END) as jank_1_0x,
              ROUND((SELECT period_ns FROM vsync_period) / 1e6, 2) as vsync_period_ms,
              ROUND(MAX(interval_ns) / 1e6, 2) as max_interval_ms
            FROM vsync_intervals
            WHERE interval_ns IS NOT NULL`,
      check: (r: any[]) => {
        if (!r[0]) return '❌ 无数据';
        const jank15 = r[0].jank_1_5x || 0;
        const jank12 = r[0].jank_1_2x || 0;
        const jank10 = r[0].jank_1_0x || 0;
        const total = r[0].total_vsync || 0;
        const period = r[0].vsync_period_ms || 0;
        const maxInterval = r[0].max_interval_ms || 0;
        return `${jank15 > 0 ? '⚠️' : '✅'} 掉帧(>1.5x)=${jank15}, (>1.2x)=${jank12}, (>1.0x)=${jank10} / 总${total}个VSYNC\n    周期=${period}ms, 最大间隔=${maxInterval}ms`;
      }
    },
    {
      name: '7. display_frame_token 跳跃检测',
      sql: `WITH frames AS (
              SELECT
                display_frame_token,
                ts,
                LAG(display_frame_token) OVER (ORDER BY ts) as prev_token
              FROM actual_frame_timeline_slice
              WHERE surface_frame_token IS NOT NULL
            )
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN display_frame_token - prev_token > 1 THEN 1 ELSE 0 END) as gap_frames,
              MAX(display_frame_token - prev_token) as max_gap
            FROM frames
            WHERE prev_token IS NOT NULL`,
      check: (r: any[]) => {
        if (!r[0]) return '❌ 无数据';
        const gaps = r[0].gap_frames || 0;
        const maxGap = r[0].max_gap || 0;
        const total = r[0].total || 0;
        return `${gaps > 0 ? '⚠️' : '✅'} ${gaps}/${total} 帧有 token 跳跃 (最大跳跃=${maxGap}帧)`;
      }
    },
    {
      name: '8. 应用进程',
      sql: `SELECT DISTINCT p.name, COUNT(*) as frame_count
            FROM process p
            JOIN actual_frame_timeline_slice a ON p.upid = a.upid
            WHERE a.surface_frame_token IS NOT NULL
            GROUP BY p.name
            ORDER BY frame_count DESC
            LIMIT 5`,
      check: (r: any[]) => r.length > 0
        ? `✅ ${r.map(x => `${x.name}(${x.frame_count}帧)`).join(', ')}`
        : '❌ 未找到应用进程'
    },
    {
      name: '9. 滑动性能分析 skill 使用的完整 SQL (模拟)',
      sql: `WITH
            vsync_intervals AS (
              SELECT
                c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
              FROM counter c
              JOIN counter_track t ON c.track_id = t.id
              WHERE t.name = 'VSYNC-sf'
            ),
            vsync_config AS (
              SELECT
                COALESCE(
                  (SELECT CAST(AVG(interval_ns) AS INTEGER)
                   FROM vsync_intervals
                   WHERE interval_ns > 5000000 AND interval_ns < 15000000),
                  8333333
                ) as vsync_period_ns
            ),
            vsync_events AS (
              SELECT
                c.ts as vsync_ts,
                c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
              FROM counter c
              JOIN counter_track t ON c.track_id = t.id
              WHERE t.name = 'VSYNC-sf'
            ),
            buffer_events AS (
              SELECT c.ts, c.value as buffer_count
              FROM counter c
              JOIN counter_track t ON c.track_id = t.id
              WHERE t.name LIKE '%BufferTX%'
            ),
            vsync_with_buffer AS (
              SELECT
                v.vsync_ts,
                v.interval_ns,
                (SELECT b.buffer_count
                 FROM buffer_events b
                 WHERE b.ts <= v.vsync_ts
                 ORDER BY b.ts DESC
                 LIMIT 1
                ) as buffer_at_vsync
              FROM vsync_events v
              WHERE v.interval_ns IS NOT NULL
            ),
            jank_analysis AS (
              SELECT
                COUNT(*) as total_vsync,
                SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
                          THEN 1 ELSE 0 END) as total_jank_count
              FROM vsync_with_buffer
              WHERE buffer_at_vsync IS NOT NULL
            )
            SELECT
              (SELECT vsync_period_ns FROM vsync_config) as detected_vsync_period_ns,
              ROUND((SELECT vsync_period_ns FROM vsync_config) / 1e6, 2) as detected_vsync_period_ms,
              (SELECT COUNT(*) FROM buffer_events) as buffer_event_count,
              (SELECT COUNT(*) FROM vsync_with_buffer WHERE buffer_at_vsync IS NOT NULL) as vsync_with_buffer_count,
              (SELECT total_vsync FROM jank_analysis) as analyzed_vsync_count,
              (SELECT total_jank_count FROM jank_analysis) as detected_jank_count`,
      check: (r: any[]) => {
        if (!r[0]) return '❌ 无数据';
        const period = r[0].detected_vsync_period_ms || 0;
        const bufferCount = r[0].buffer_event_count || 0;
        const analyzedCount = r[0].analyzed_vsync_count || 0;
        const jankCount = r[0].detected_jank_count || 0;

        const issues: string[] = [];
        if (bufferCount === 0) issues.push('❌ 无 BufferTX 数据');
        if (analyzedCount === 0) issues.push('❌ 无法分析任何 VSYNC (buffer_at_vsync 全为 NULL)');
        if (period < 10) issues.push(`⚠️ 检测周期=${period}ms 可能是 120Hz 默认值`);

        if (issues.length > 0) {
          return `检测到问题:\n    ${issues.join('\n    ')}\n    周期=${period}ms, Buffer事件=${bufferCount}, 分析VSYNC=${analyzedCount}, 检测掉帧=${jankCount}`;
        }
        return `✅ 周期=${period}ms, Buffer事件=${bufferCount}, 分析VSYNC=${analyzedCount}, 检测掉帧=${jankCount}`;
      }
    }
  ];

  // 执行诊断
  for (const diag of diagnosticQueries) {
    try {
      console.log(`\n${diag.name}`);
      console.log('-'.repeat(55));
      const result = await executeQuery(port, diag.sql);
      if (diag.name.includes('关键') || diag.name.includes('模拟')) {
        console.log('原始结果:', JSON.stringify(result, null, 2));
      }
      console.log('判断:', diag.check(result));
    } catch (err: any) {
      console.log(`❌ 查询失败: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('诊断完成');
  console.log('='.repeat(60));
}

// 主入口
const port = parseInt(process.argv[2] || '9100', 10);
diagnose(port).catch(console.error);
