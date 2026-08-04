// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Port Pool Manager
 *
 * Manages a pool of ports for trace_processor_shell HTTP servers.
 * Ensures ports are properly allocated and released.
 */

import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import { traceProcessorConfig } from '../config';

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

export interface PortAllocation {
  port: number;
  traceId: string;
  allocatedAt: Date;
}

export type PortBindProbe = (port: number) => boolean;

const LOOPBACK_PORT_PROBE = [
  "const net = require('net');",
  'const port = Number(process.argv[1]);',
  "const server = net.createServer();",
  "server.once('error', () => process.exit(2));",
  "server.listen({host: '127.0.0.1', port, exclusive: true}, () => server.close(() => process.exit(0)));",
  'setTimeout(() => process.exit(3), 1500).unref();',
].join('');

/**
 * Probe port ownership in a short-lived Node process so allocation remains
 * synchronous for existing callers while still observing listeners owned by
 * other SmartPerfetto, CLI, or test processes.
 */
export function canBindLoopbackPort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  const result = spawnSync(
    process.execPath,
    ['-e', LOOPBACK_PORT_PROBE, String(port)],
    {stdio: 'ignore', timeout: 2_000},
  );
  return result.status === 0;
}

export class PortPool extends EventEmitter {
  private readonly minPort: number;
  private readonly maxPort: number;
  private availablePorts: Set<number>;
  private blockedPorts: Set<number>; // ports known to be unusable (e.g. already in use by another process)
  private allocations: Map<string, PortAllocation>; // traceId -> allocation
  private portToTraceId: Map<number, string>; // port -> traceId (reverse lookup)

  constructor(
    minPort: number = traceProcessorConfig.portRange.min,
    maxPort: number = traceProcessorConfig.portRange.max,
    private readonly isPortBindable: PortBindProbe = canBindLoopbackPort,
  ) {
    super();
    this.minPort = minPort;
    this.maxPort = maxPort;
    this.availablePorts = new Set();
    this.blockedPorts = new Set();
    this.allocations = new Map();
    this.portToTraceId = new Map();

    // Initialize all ports as available
    for (let port = minPort; port <= maxPort; port++) {
      this.availablePorts.add(port);
    }

    if (!IS_TEST_ENV) {
      console.log(`[PortPool] Initialized with ${this.availablePorts.size} ports (${minPort}-${maxPort})`);
    }
  }

  /**
   * Allocate a port for a trace
   * @param traceId The trace ID requesting a port
   * @returns The allocated port number
   * @throws Error if no ports are available
   */
  allocate(traceId: string): number {
    // Check if this trace already has a port
    const existing = this.allocations.get(traceId);
    if (existing) {
      if (!IS_TEST_ENV) {
        console.log(`[PortPool] Trace ${traceId} already has port ${existing.port}`);
      }
      return existing.port;
    }

    // Select the first locally free port that the OS also reports as bindable.
    // Each process has its own in-memory pool, so the OS probe is the authority
    // for ports currently owned by another backend or CLI instance.
    const port = this.getNextBindablePort();
    if (port === null) {
      throw new Error(`No available ports in pool (${this.minPort}-${this.maxPort}). Active allocations: ${this.allocations.size}`);
    }

    // Mark port as allocated
    this.availablePorts.delete(port);
    const allocation: PortAllocation = {
      port,
      traceId,
      allocatedAt: new Date(),
    };
    this.allocations.set(traceId, allocation);
    this.portToTraceId.set(port, traceId);

    if (!IS_TEST_ENV) {
      console.log(`[PortPool] Allocated port ${port} to trace ${traceId} (${this.availablePorts.size} available)`);
    }
    this.emit('allocated', { port, traceId });

    return port;
  }

  /**
   * Release a port back to the pool
   * @param traceId The trace ID releasing the port
   * @returns true if port was released, false if trace had no port
   */
  release(traceId: string): boolean {
    const allocation = this.allocations.get(traceId);
    if (!allocation) {
      if (!IS_TEST_ENV) {
        console.log(`[PortPool] Trace ${traceId} has no port to release`);
      }
      return false;
    }

    const port = allocation.port;

    // Return port to available pool
    this.allocations.delete(traceId);
    this.portToTraceId.delete(port);
    // If a port is known-bad, keep it blocked even after release.
    if (!this.blockedPorts.has(port)) {
      this.availablePorts.add(port);
    }

    if (!IS_TEST_ENV) {
      console.log(`[PortPool] Released port ${port} from trace ${traceId} (${this.availablePorts.size} available)`);
    }
    this.emit('released', { port, traceId });

    return true;
  }

  /**
   * Release a port by port number (useful when trace ID is unknown)
   * @param port The port number to release
   * @returns true if port was released
   */
  releaseByPort(port: number): boolean {
    const traceId = this.portToTraceId.get(port);
    if (!traceId) {
      // Port might not be tracked, just add it back to available
      if (port >= this.minPort && port <= this.maxPort && !this.availablePorts.has(port) && !this.blockedPorts.has(port)) {
        this.availablePorts.add(port);
        if (!IS_TEST_ENV) {
          console.log(`[PortPool] Force-released untracked port ${port}`);
        }
        return true;
      }
      return false;
    }
    return this.release(traceId);
  }

  /**
   * Mark a port as unusable for the remainder of this process.
   * This is used when trace_processor_shell reports "Address already in use".
   */
  blockPort(port: number): void {
    if (port < this.minPort || port > this.maxPort) return;

    // If the port is currently allocated, release it first (will try to add back, but we will keep it blocked).
    const traceId = this.portToTraceId.get(port);
    if (traceId) {
      this.release(traceId);
    }

    this.availablePorts.delete(port);
    this.blockedPorts.add(port);
    console.log(`[PortPool] Blocked port ${port} (marked unusable)`);
    this.emit('blocked', { port });
  }

  /**
   * Get the port allocated to a trace
   * @param traceId The trace ID
   * @returns The port number or null if not allocated
   */
  getPort(traceId: string): number | null {
    const allocation = this.allocations.get(traceId);
    return allocation ? allocation.port : null;
  }

  /**
   * Check if a port is available
   * @param port The port to check
   * @returns true if the port is available
   */
  isAvailable(port: number): boolean {
    return this.availablePorts.has(port);
  }

  /**
   * Get the next available port
   * @returns The next available port or null if none available
   */
  private getNextAvailablePort(): number | null {
    if (this.availablePorts.size === 0) {
      return null;
    }
    // Get the smallest available port for predictability
    return Math.min(...this.availablePorts);
  }

  private getNextBindablePort(): number | null {
    while (this.availablePorts.size > 0) {
      const port = this.getNextAvailablePort();
      if (port === null) return null;
      if (this.isPortBindable(port)) return port;

      this.availablePorts.delete(port);
      this.blockedPorts.add(port);
      if (!IS_TEST_ENV) {
        console.log(`[PortPool] Skipping externally occupied port ${port}`);
      }
      this.emit('blocked', { port, reason: 'external_listener' });
    }
    return null;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    total: number;
    available: number;
    allocated: number;
    blocked: number;
    allocations: PortAllocation[];
  } {
    return {
      total: this.maxPort - this.minPort + 1,
      available: this.availablePorts.size,
      allocated: this.allocations.size,
      blocked: this.blockedPorts.size,
      allocations: Array.from(this.allocations.values()),
    };
  }

  /**
   * Release all ports (cleanup)
   */
  releaseAll(): void {
    const traceIds = Array.from(this.allocations.keys());
    for (const traceId of traceIds) {
      this.release(traceId);
    }
    console.log(`[PortPool] Released all ports`);
  }

  /**
   * Force cleanup stale allocations (ports allocated more than maxAge ago)
   * @param maxAgeMs Maximum age in milliseconds
   * @returns Number of stale allocations cleaned
   */
  cleanupStale(maxAgeMs: number = traceProcessorConfig.staleAllocationMaxAgeMs): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [traceId, allocation] of this.allocations) {
      const age = now - allocation.allocatedAt.getTime();
      if (age > maxAgeMs) {
        console.log(`[PortPool] Cleaning stale allocation: port ${allocation.port} for trace ${traceId} (age: ${Math.round(age / 1000)}s)`);
        this.release(traceId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[PortPool] Cleaned ${cleaned} stale allocations`);
    }

    return cleaned;
  }
}

// Singleton instance
let portPoolInstance: PortPool | null = null;

export function getPortPool(): PortPool {
  if (!portPoolInstance) {
    portPoolInstance = new PortPool();
  }
  return portPoolInstance;
}

export function resetPortPool(): void {
  if (portPoolInstance) {
    portPoolInstance.releaseAll();
  }
  portPoolInstance = new PortPool();
}
