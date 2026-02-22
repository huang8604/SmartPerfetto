import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { PreparedRuntimeContext } from './runtimeContextBuilder';

export type RuntimeMode = PreparedRuntimeContext['decisionContext']['mode'];

export interface RuntimeModeExecutionRequest {
  runtimeContext: PreparedRuntimeContext;
  query: string;
  sessionId: string;
  traceId: string;
}

export interface RuntimeModeHandler {
  supports(mode: RuntimeMode): boolean;
  execute(request: RuntimeModeExecutionRequest): Promise<AnalysisResult>;
}

export interface RuntimeModeHandlerRegistrationOptions {
  prepend?: boolean;
}
