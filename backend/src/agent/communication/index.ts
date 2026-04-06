// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Agent Communication Module
 *
 * Phase 4: Inter-agent communication system
 */

export {
  AgentMessageBus,
  createAgentMessageBus,
  type MessageBusConfig,
  type MessageHandler,
  type QueryHandler,
} from './agentMessageBus';