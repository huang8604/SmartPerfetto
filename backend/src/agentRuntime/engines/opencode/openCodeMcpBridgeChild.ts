// The OpenCode subprocess must start without a TypeScript loader. Keep the
// transport implementation in the copied CommonJS runtime asset.
require('./openCodeMcpBridgeChild.cjs');
