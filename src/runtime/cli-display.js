/**
 * CLI Display helpers for progress spinner text.
 * Separated from agent.js to avoid circular dependencies with action files.
 */

/**
 * Build display text for progress spinner based on action type.
 * For MCP calls: "[🤖 Agent 🔌 mcp] tool(summary)"
 * For others: "[🤖 Agent] Thinking" (or desc if provided)
 */
export function buildActionDisplay(agentName, action) {
  const intent = action.intent || action.type;

  if (intent === 'call_mcp' && action.mcp && action.tool) {
    let inputSummary = '';
    if (action.input && typeof action.input === 'object' && Object.keys(action.input).length > 0) {
      const raw = JSON.stringify(action.input);
      inputSummary = raw.length > 80 ? raw.substring(0, 77) + '...' : raw;
    }
    const toolCall = inputSummary ? `${action.tool}(${inputSummary})` : action.tool;
    return `[🤖 ${agentName} 🔌 ${action.mcp}] ${toolCall}`;
  }

  const displayText = action.desc ? action.desc.replace(/\.\.\.$/, '') : 'Thinking';
  return `[🤖 ${agentName}] ${displayText}`;
}
