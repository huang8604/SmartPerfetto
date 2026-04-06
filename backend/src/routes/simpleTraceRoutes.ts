// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getPortPool } from '../services/portPool';
import { TraceProcessorFactory } from '../services/workingTraceProcessor';

const router = Router();

// GET /api/traces/health - Health check for auto-upload feature
// This endpoint allows the frontend to quickly check if the backend is available
router.get('/health', (req, res) => {
  res.json({
    available: true,
    version: '1.0',
    timestamp: new Date().toISOString(),
  });
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, process.env.UPLOAD_DIR || './uploads');
  },
  filename: (req, file, cb) => {
    // Keep the original filename
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  },
});

// POST /api/traces/upload - Simple upload without auth
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded'
      });
    }

    const file = req.file;

    // Store trace info (in a real app, this would go to a database)
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');
    await fs.mkdir(tracesDir, { recursive: true });

    // Generate trace ID upfront for consistency
    const traceId = uuidv4();

    // Load trace into TraceProcessorService for SQL analysis
    // Use the traceId we generated so everything is consistent
    const tps = getTraceProcessorService();

    if (tps) {
      // Initialize upload in the service with our traceId
      await tps.initializeUploadWithId(traceId, file.originalname, file.size);
      console.log(`[TraceProcessor] Initialized upload with traceId: ${traceId}`);
    }

    // Move file to traces directory with proper name
    const finalPath = path.join(tracesDir, `${traceId}.trace`);
    await fs.rename(file.path, finalPath);

    console.log(`File uploaded successfully: ${file.originalname} -> ${traceId}`);

    // Create metadata JSON file for the trace
    const metadataPath = path.join(tracesDir, `${traceId}.json`);
    const metadata = {
      id: traceId,
      filename: file.originalname,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      path: finalPath,
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    console.log(`[TraceProcessor] Created metadata: ${metadataPath}`);

    // Complete the upload which will process the trace
    if (tps) {
      try {
        await tps.completeUpload(traceId);
        console.log(`[TraceProcessor] Loaded trace ${traceId}`);
      } catch (tpError: any) {
        console.error(`[TraceProcessor] Failed to load trace ${traceId}:`, tpError.message);
        // Continue anyway - file is saved
      }
    }

    // Get trace status and processor port from service
    const traceInfo = tps?.getTraceWithPort(traceId);

    res.json({
      success: true,
      trace: {
        id: traceId,
        filename: file.originalname,
        size: file.size,
        uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
        status: traceInfo?.status || 'ready',
        // Port for HTTP RPC mode - frontend can connect to trace_processor directly
        port: traceInfo?.port,
        processorStatus: traceInfo?.processor?.status,
      }
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Upload failed',
      details: error.message
    });
  }
});

// GET /api/traces - List all traces
router.get('/', async (req, res) => {
  try {
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');

    try {
      const files = await fs.readdir(tracesDir);
      const traces = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const traceData = await fs.readFile(path.join(tracesDir, file), 'utf8');
          const trace = JSON.parse(traceData);
          traces.push(trace);
        }
      }

      // Sort by upload date (newest first)
      traces.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

      res.json({ traces });
    } catch (error) {
      // Directory doesn't exist yet
      res.json({ traces: [] });
    }
  } catch (error: any) {
    console.error('List traces error:', error);
    res.status(500).json({
      error: 'Failed to list traces',
      details: error.message
    });
  }
});

// GET /api/traces/stats - Get resource usage statistics
// IMPORTANT: Must be before /:id to avoid matching "stats" as an id
router.get('/stats', (req, res) => {
  try {
    const portPoolStats = getPortPool().getStats();
    const processorStats = TraceProcessorFactory.getStats();
    const traceService = getTraceProcessorService();
    const traces = traceService.getAllTraces();

    res.json({
      success: true,
      stats: {
        portPool: {
          total: portPoolStats.total,
          available: portPoolStats.available,
          allocated: portPoolStats.allocated,
          allocations: portPoolStats.allocations.map(a => ({
            port: a.port,
            traceId: a.traceId,
            allocatedAt: a.allocatedAt,
          })),
        },
        processors: {
          count: processorStats.count,
          traceIds: processorStats.traceIds,
        },
        traces: {
          count: traces.length,
          items: traces.map(t => ({
            id: t.id,
            filename: t.filename,
            status: t.status,
            uploadTime: t.uploadTime,
          })),
        },
      },
    });
  } catch (error: any) {
    console.error('[Traces] Stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/cleanup - Cleanup all resources
// IMPORTANT: Must be before /:id to avoid matching "cleanup" as an id
router.post('/cleanup', async (req, res) => {
  try {
    console.log('[Traces] Starting full cleanup...');

    // Cleanup all trace processors
    TraceProcessorFactory.cleanup();

    // Cleanup stale port allocations
    const portPool = getPortPool();
    const staleCount = portPool.cleanupStale(0); // Cleanup all

    console.log(`[Traces] Cleanup complete. Released ${staleCount} stale allocations.`);

    res.json({
      success: true,
      message: `Cleanup complete. Released ${staleCount} port allocations.`,
      stats: portPool.getStats(),
    });
  } catch (error: any) {
    console.error('[Traces] Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/register-rpc - Register an existing HTTP RPC connection
// This is used when frontend is already connected to a trace_processor via HTTP RPC
// and wants to enable AI analysis without re-uploading the trace
router.post('/register-rpc', async (req, res) => {
  try {
    const { port, traceName } = req.body;

    if (!port) {
      return res.status(400).json({
        success: false,
        error: 'Port is required',
      });
    }

    console.log(`[Traces] Registering external RPC connection on port ${port}, name: ${traceName || 'External Trace'}`);

    // Generate a trace ID for this external connection
    const traceId = `external-rpc-${port}-${Date.now()}`;

    // Get the trace processor service
    const tps = getTraceProcessorService();

    if (tps) {
      // Register the external RPC connection
      await tps.registerExternalRpc(traceId, port, traceName || 'External RPC Trace');
      console.log(`[Traces] Registered external RPC as traceId: ${traceId}`);
    }

    res.json({
      success: true,
      traceId,
      port,
      message: `External RPC connection registered successfully`,
    });

  } catch (error: any) {
    console.error('[Traces] Register RPC error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/traces/:id - Get a single trace info (for verifying trace exists)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');
    const metadataPath = path.join(tracesDir, `${id}.json`);

    try {
      const metadataContent = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataContent);

      // Also check TraceProcessorService for processor status
      const tps = getTraceProcessorService();
      const traceInfo = tps?.getTraceWithPort(id);

      res.json({
        success: true,
        trace: {
          ...metadata,
          processorStatus: traceInfo?.status || 'unknown',
          hasProcessor: !!traceInfo?.processor,
          port: traceInfo?.port,
        }
      });
    } catch (error) {
      res.status(404).json({
        error: 'Trace not found',
        id
      });
    }
  } catch (error: any) {
    console.error('[Traces] Get trace error:', error);
    res.status(500).json({
      error: 'Failed to get trace',
      details: error.message
    });
  }
});

// DELETE /api/traces/:id - Delete a trace and cleanup all resources
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');

    console.log(`[Traces] Deleting trace ${id} and cleaning up resources...`);

    // First, cleanup the trace processor (this will release the port)
    try {
      const traceService = getTraceProcessorService();
      await traceService.deleteTrace(id);
      console.log(`[Traces] Trace processor cleaned up for ${id}`);
    } catch (error: any) {
      console.log(`[Traces] Trace processor cleanup skipped: ${error.message}`);
    }

    // Delete trace file
    const tracePath = path.join(tracesDir, `${id}.trace`);
    try {
      await fs.unlink(tracePath);
      console.log(`[Traces] Trace file deleted: ${tracePath}`);
    } catch (error) {
      // File might not exist, continue
    }

    // Delete metadata file
    const infoPath = path.join(tracesDir, `${id}.json`);
    try {
      await fs.unlink(infoPath);
      console.log(`[Traces] Metadata file deleted: ${infoPath}`);
    } catch (error) {
      // File might not exist, continue
    }

    console.log(`[Traces] Trace ${id} fully deleted`);
    res.json({ success: true, message: 'Trace deleted successfully' });

  } catch (error: any) {
    console.error('[Traces] Delete trace error:', error);
    res.status(500).json({
      error: 'Failed to delete trace',
      details: error.message
    });
  }
});

// GET /api/traces/:id/file - Download trace file
router.get('/:id/file', async (req, res) => {
  try {
    const { id } = req.params;
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');
    const tracePath = path.join(tracesDir, `${id}.trace`);

    try {
      await fs.access(tracePath);
      res.sendFile(tracePath, { root: '.' });
    } catch (error) {
      res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }
  } catch (error: any) {
    console.error('Download trace error:', error);
    res.status(500).json({
      error: 'Failed to download trace',
      details: error.message
    });
  }
});

export default router;