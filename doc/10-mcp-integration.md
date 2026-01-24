# MCP Protocol

Model Context Protocol (MCP) enables connecting to remote agents and services.

## Overview

Koi provides complete MCP implementation with:
- WebSocket and HTTP/2 support
- Authentication & authorization
- Connection pooling
- Load balancing
- Retry logic & failover
- Streaming responses

## Basic Usage

```koi
Team HybridTeam {
  local = LocalAgent
  remote = mcp://agent.local/processor
}

Agent Orchestrator : Worker {
  uses Team HybridTeam

  on start(args: Json) {
    const result = await send peers.event("process").role(Worker).any()(args)
    return result
  }
}
```

## MCP Address Format

```
mcp://server/path
```

Examples:
- `mcp://agent.local/processor` (local simulation)
- `mcp://production.example.com/agent` (HTTP/2)
- `mcp://ws://realtime.com/streaming` (WebSocket)

## Authentication

Set environment variables:

```bash
export MCP_AUTH_PRODUCTION_EXAMPLE_COM="your-token"
```

## Connection Modes

1. **Local Simulation** (`.local`) - for testing
2. **WebSocket** - for real-time streaming
3. **HTTP/2** - for request-response

For complete details, see [MCP_GUIDE.md](../MCP_GUIDE.md) in the root directory.

---

**Next**: [TypeScript Imports](11-typescript-imports.md) →
