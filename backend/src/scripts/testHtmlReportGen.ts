
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import { AnalysisSession } from '../types/analysis';
import * as fs from 'fs';
import * as path from 'path';

// Mock Data
const mockSession: any = {
    id: 'session-12345',
    traceId: 'trace-abc-789',
    question: 'Analyze the scrolling jank in com.example.app',
    currentIteration: 3,
    createdAt: new Date(),
    collectedResults: [
        {
            sql: 'SELECT * FROM slice WHERE name LIKE "%jank%" LIMIT 5',
            result: {
                rowCount: 5,
                durationMs: 42,
                columns: ['name', 'ts', 'dur', 'cpu'],
                rows: [
                    ['frame_draw', 100000, 16000000, 1],
                    ['frame_draw', 116000, 22000000, 1],
                    ['frame_draw', 138000, 16000000, 2],
                    ['frame_draw', 154000, 15000000, 1],
                    ['frame_draw', 170000, 33000000, 3],
                ],
            },
            insight: 'Found multiple janky frames > 16ms',
            timestamp: Date.now() - 5000,
            stepNumber: 1,
        }
    ],
    skillEngineResult: {
        skillId: 'scrolling_analysis',
        skillName: 'Scrolling Analysis',
        executionTimeMs: 1250,
        diagnostics: [
            { severity: 'critical', message: 'Severe jank detected due to long main thread processing', suggestions: ['Check view measurement', 'Optimize layouts'] },
            { severity: 'warning', message: 'Binder transactions on main thread', suggestions: ['Move IPC to background'] }
        ],
        layeredResult: {
            metadata: { skillName: 'Scrolling Analysis', version: '1.0', executedAt: new Date().toISOString() },
            layers: {
                overview: {
                    'jank_rate': 0.15,
                    'avg_fps': 55.4,
                    'max_frame_duration': 42.5
                },
                list: {
                    'janky_frames': [
                        { frame_id: 1, duration: 22.0, type: 'Jank', ts: 116000 },
                        { frame_id: 2, duration: 33.0, type: 'Big Jank', ts: 170000 }
                    ]
                },
                deep: {
                    'frame_details': [
                        {
                            title: 'Frame #1 (22.0ms)',
                            severity: 'medium',
                            jank_type: 'Main Thread',
                            root_cause: {
                                primary: 'View Inflation',
                                method: 'inflate',
                                duration: 12.5
                            },
                            breakdown: {
                                measure: 5.0,
                                layout: 4.0,
                                draw: 3.5
                            }
                        },
                        {
                            title: 'Frame #2 (33.0ms)',
                            severity: 'high',
                            jank_type: 'Binder',
                            binder_tx: {
                                service: 'activity_manager',
                                duration: 18.2,
                                count: 3
                            },
                            cpu_state: {
                                freq: 'low',
                                core: 'little'
                            }
                        }
                    ]
                }
            }
        }
    }
};

const mockFinalAnswer = `
## Analysis Conclusion
The trace analysis confirms **significant jank** during the scrolling session.

1. **Jank Rate**: 15% of frames missed the deadline.
2. **Main Cause**: Expensive view inflation on the main thread and blocking Binder calls.

### Recommendations
- Optimize \`RecyclerView\` item layouts.
- Move \`activity_manager\` IPC calls to a background thread.
`;

async function run() {
    console.log('Generating test HTML report...');
    const generator = getHTMLReportGenerator();
    const html = generator.generateFromSession(mockSession, mockFinalAnswer);

    const outputPath = path.join(process.cwd(), 'test_report_optimized.html');
    fs.writeFileSync(outputPath, html);
    console.log(`Report generated at: ${outputPath}`);
}

run().catch(console.error);
