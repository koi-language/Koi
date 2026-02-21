import { MCPStdioClient } from './mcp-stdio-client.js';

/**
 * MCP Registry - Global registry of MCP client instances.
 * Similar to SkillRegistry but for MCP stdio servers.
 */
class MCPRegistry {
  constructor() {
    this.clients = new Map();
  }

  /**
   * Register an MCP server configuration.
   * Does NOT connect immediately (lazy connection on first use).
   * @param {string} name - MCP server name (e.g., "mobileMCP")
   * @param {object} config - { command, args, env }
   */
  register(name, config) {
    if (this.clients.has(name)) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCPRegistry] Re-registering MCP: ${name}`);
      }
    }

    const client = new MCPStdioClient(name, config);
    this.clients.set(name, client);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[MCPRegistry] Registered MCP: ${name} (${config.command} ${(config.args || []).join(' ')})`);
    }
  }

  /**
   * Get a client by name.
   * @param {string} name - MCP server name
   * @returns {MCPStdioClient|undefined}
   */
  get(name) {
    return this.clients.get(name);
  }

  /**
   * Connect a specific MCP client (lazy initialization).
   * @param {string} name - MCP server name
   */
  async connect(name) {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`MCP '${name}' not registered`);
    }
    if (!client.initialized) {
      await client.connect();
    }
  }

  /**
   * Connect all registered MCP clients.
   */
  async connectAll() {
    const promises = [];
    for (const [name, client] of this.clients) {
      if (!client.initialized) {
        promises.push(client.connect().catch(err => {
          console.error(`[MCPRegistry] Failed to connect ${name}: ${err.message}`);
        }));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Call a tool on a specific MCP server.
   * Connects lazily if not already connected.
   * @param {string} mcpName - MCP server name
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   * @returns {object} Tool result
   */
  async callTool(mcpName, toolName, args = {}) {
    const client = this.clients.get(mcpName);
    if (!client) {
      throw new Error(`MCP '${mcpName}' not registered`);
    }

    if (!client.initialized) {
      await client.connect();
    }

    return await client.callTool(toolName, args);
  }

  /**
   * Get tool summaries for all registered MCPs.
   * Used for building system prompts.
   * @returns {Array<{name: string, tools: Array}>}
   */
  getToolSummaries() {
    const summaries = [];
    for (const [name, client] of this.clients) {
      if (client.tools.length > 0) {
        summaries.push({
          name,
          tools: client.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema
          }))
        });
      }
    }
    return summaries;
  }

  /**
   * Disconnect all MCP clients gracefully.
   */
  async disconnectAll() {
    const promises = [];
    for (const [name, client] of this.clients) {
      if (client.initialized) {
        promises.push(client.disconnect().catch(err => {
          console.error(`[MCPRegistry] Failed to disconnect ${name}: ${err.message}`);
        }));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Check if any MCP servers are registered.
   */
  hasRegistered() {
    return this.clients.size > 0;
  }
}

// Singleton instance
export const mcpRegistry = new MCPRegistry();

// Make available globally for transpiled code
globalThis.mcpRegistry = mcpRegistry;
