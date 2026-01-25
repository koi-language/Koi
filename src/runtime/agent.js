import { LLMProvider } from './llm-provider.js';
import { cliLogger } from './cli-logger.js';
import { actionRegistry } from './action-registry.js';

// Global call stack to detect infinite loops across all agents
const globalCallStack = [];

export class Agent {
  constructor(config) {
    this.name = config.name;
    this.role = config.role;
    this.skills = config.skills || [];
    this.usesTeams = config.usesTeams || []; // Teams this agent uses as a client
    this.llm = config.llm || { provider: 'openai', model: 'gpt-4', temperature: 0.2 };
    this.state = config.state || {};
    this.playbooks = config.playbooks || {};
    this.resilience = config.resilience || null;

    // Never allow peers to be null - use a proxy that throws helpful error
    if (config.peers) {
      this.peers = config.peers;
    } else {
      this.peers = this._createNoTeamProxy();
    }

    this.handlers = config.handlers || {};

    // Initialize LLM provider if needed
    this.llmProvider = null;
  }

  /**
   * Create a proxy that throws a helpful error when trying to use peers without a team
   */
  _createNoTeamProxy() {
    // Return an object that mimics a Team but throws when execute() is called
    let eventName = 'unknown';
    const noTeamQuery = {
      __isNoTeamProxy: true, // Marker for Team constructor to detect and replace
      event: (name) => {
        eventName = name;
        return noTeamQuery;
      },
      role: () => noTeamQuery,
      any: () => noTeamQuery,
      all: () => noTeamQuery,
      execute: () => {
        throw new Error(`NO_AGENT_HANDLER:${eventName}::no-team`);
      }
    };
    return noTeamQuery;
  }

  /**
   * Get a specific team by reference (for peers(TeamName) syntax)
   * @param {Team} teamRef - Team instance or constructor
   * @returns {Team} The team instance
   */
  _getTeam(teamRef) {
    // If teamRef is already a Team instance, check if we have access to it
    if (teamRef && typeof teamRef === 'object') {
      // Check if it's the same instance as peers
      if (this.peers === teamRef) {
        return this.peers;
      }

      // Search in usesTeams array for the exact same instance
      if (Array.isArray(this.usesTeams)) {
        const team = this.usesTeams.find(t => t === teamRef);
        if (team) {
          return team;
        }
      }

      // Team not found - throw helpful error
      const teamName = teamRef.name || teamRef.constructor?.name || 'Unknown';
      throw new Error(
        `Agent ${this.name} does not have access to team ${teamName}.\n` +
        `Available teams: ${this.usesTeams.map(t => t?.name || t?.constructor?.name || 'Unknown').join(', ') || 'none'}\n` +
        `Hint: Add "uses Team ${teamName}" to the agent definition.`
      );
    }

    // If teamRef is a constructor/class, search by constructor
    if (typeof teamRef === 'function') {
      if (this.peers && this.peers.constructor === teamRef) {
        return this.peers;
      }

      if (Array.isArray(this.usesTeams)) {
        const team = this.usesTeams.find(t => t && t.constructor === teamRef);
        if (team) {
          return team;
        }
      }
    }

    throw new Error(
      `Agent ${this.name} could not find team.\n` +
      `Available teams: ${this.usesTeams.map(t => t?.name || t?.constructor?.name || 'Unknown').join(', ') || 'none'}`
    );
  }

  /**
   * Check if the agent has a specific permission
   * Supports hierarchical permissions: if role has "registry", it can execute "registry:read", "registry:write", etc.
   * @param {string} permissionName - Permission to check (e.g., 'execute', 'delegate', 'registry:read')
   * @returns {boolean} True if agent has the permission
   */
  hasPermission(permissionName) {
    if (!this.role) {
      return false;
    }

    // Check exact permission match first
    if (this.role.can(permissionName)) {
      return true;
    }

    // Check hierarchical permissions (e.g., "registry" covers "registry:read")
    if (permissionName.includes(':')) {
      const [prefix] = permissionName.split(':');
      if (this.role.can(prefix)) {
        return true;
      }
    }

    return false;
  }

  async handle(eventName, args, _fromDelegation = false) {
    if (!_fromDelegation) {
      cliLogger.progress(`[🤖 ${this.name}] ${eventName}...`);
    }

    const handler = this.handlers[eventName];
    if (!handler) {
      cliLogger.clear();
      cliLogger.error(`[🤖 ${this.name}] No handler for event: ${eventName}`);
      throw new Error(`Agent ${this.name} has no handler for event: ${eventName}`);
    }

    try {
      // Check if handler is playbook-only (has __playbookOnly__ flag)
      if (handler.__playbookOnly__) {
        const result = await this.executePlaybookHandler(eventName, handler.__playbook__, args, _fromDelegation);
        cliLogger.clear();
        return result;
      }

      // Execute handler with agent context
      const result = await handler.call(this, args);
      cliLogger.clear();
      return result;
    } catch (error) {
      cliLogger.clear();
      // Don't log NO_AGENT_HANDLER errors - they'll be handled in runtime.js
      if (!error.message || !error.message.startsWith('NO_AGENT_HANDLER:')) {
        cliLogger.error(`[${this.name}] Error in ${eventName}: ${error.message}`);

        // Apply resilience if configured
        if (this.resilience?.retry_max_attempts) {
          console.log(`[Agent:${this.name}] Applying resilience policy...`);
          // TODO: Implement retry logic
        }
      }

      throw error;
    }
  }

  async executePlaybookHandler(eventName, playbook, args, _fromDelegation = false) {
    // Initialize LLM provider if not already done
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    // Prepare context with args and state
    const context = {
      args,
      state: this.state
    };

    // Get available skill functions for tool calling
    const tools = this.getSkillFunctions();

    // Extract playbook content if it's an object (transpiler stores it as {type, content})
    const playbookContent = typeof playbook === 'object' && playbook.content
      ? playbook.content
      : playbook;

    // Evaluate template string with context (interpolate ${...} expressions)
    // Create a function that evaluates the template in the context of args and state
    const evaluateTemplate = (template, context) => {
      try {
        const args = context.args || {};
        const state = context.state || {};
        // Use Function constructor to evaluate template string
        // This allows ${args.url}, ${state.foo}, etc. to be interpolated
        const fn = new Function('args', 'state', `return \`${template}\`;`);
        return fn(args, state);
      } catch (error) {
        console.warn(`[Agent:${this.name}] Failed to evaluate playbook template: ${error.message}`);
        return template; // Return original if evaluation fails
      }
    };

    const interpolatedPlaybook = evaluateTemplate(playbookContent, context);

    // Use skillSelector for semantic skill selection instead of passing all skills
    // This improves accuracy by only passing relevant tools to the LLM
    let selectedTools = tools;
    if (typeof globalThis.skillSelector !== 'undefined' && interpolatedPlaybook) {
      try {
        selectedTools = await globalThis.skillSelector.selectSkillsForTask(interpolatedPlaybook, 2);
      } catch (error) {
        console.warn(`[Agent:${this.name}] Skill selection failed, using all skills: ${error.message}`);
        selectedTools = tools; // Fallback to all skills
      }
    }

    // STREAMING OPTIMIZATION: Execute actions incrementally as they arrive
    // This reduces latency by starting execution before the full JSON is received
    const streamedActions = [];
    const actionContext = {
      state: this.state,
      results: [],
      args
    };

    // Callback for incremental action execution
    const onStreamAction = async (action) => {
      streamedActions.push(action);

      // Execute action immediately (sequential execution for proper chaining)
      try {
        const resolvedAction = this.resolveActionReferences(action, actionContext);

        // Check condition if present
        if (resolvedAction.condition !== undefined) {
          const conditionMet = this.evaluateCondition(resolvedAction.condition, actionContext);
          if (!conditionMet) {
            return; // Skip this action
          }
        }

        const intent = resolvedAction.intent || resolvedAction.type || resolvedAction.description;
        const actionTitle = resolvedAction.title || intent;
        cliLogger.progress(`[${this.name}] ${actionTitle}`);

        let result;

        // Check if this is a delegation action
        if (action.actionType === 'delegate') {
          // Delegation: route to appropriate team member
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] 🔀 Delegating action: ${action.intent}`);
          }
          result = await this.resolveAction(resolvedAction, actionContext);
        } else {
          // Direct action: check if this is a registered action with an executor
          const actionDef = actionRegistry.get(action.intent || action.type);

          if (actionDef && actionDef.execute) {
            // Fast path: execute registered action
            result = await actionDef.execute(resolvedAction, this);
          } else if (action.intent || action.description) {
            // Resolve via router (legacy fallback)
            result = await this.resolveAction(resolvedAction, actionContext);
          } else {
            // Fallback legacy
            result = await this.executeLegacyAction(resolvedAction);
          }
        }

        cliLogger.clear();

        // Update context for next action (chaining)
        if (result && typeof result === 'object') {
          const resultForContext = JSON.parse(JSON.stringify(result));
          actionContext.results.push(resultForContext);

          // Store result with action ID for explicit referencing
          if (action.id) {
            actionContext[action.id] = { output: resultForContext };

            if (process.env.KOI_DEBUG_LLM) {
              const preview = JSON.stringify(resultForContext).substring(0, 200);
              console.error(`[Agent:${this.name}] 💾 Stored ${action.id}.output = ${preview}`);
            }
          }

          // Only update previousResult for actions that produce meaningful data
          // Side-effect actions like print, log (that return metadata) should not override previousResult
          const nonDataActions = ['print', 'log', 'format'];

          if (!nonDataActions.includes(intent)) {
            actionContext.previousResult = resultForContext;
            actionContext.lastResult = resultForContext;
          }

          Object.keys(resultForContext).forEach(key => {
            if (!actionContext[key]) {
              actionContext[key] = resultForContext[key];
            }
          });
        }
      } catch (error) {
        cliLogger.clear();
        console.error(`[${this.name}] Error executing streamed action: ${error.message}`);
        throw error;
      }
    };

    // Execute playbook with streaming (onAction callback receives each action as it completes)
    const result = await this.llmProvider.executePlaybook(
      interpolatedPlaybook,
      context,
      this.name,
      selectedTools,
      this,
      _fromDelegation,
      onStreamAction  // Pass callback for incremental execution
    );

    // If streaming was used, actions were already executed
    if (streamedActions.length > 0) {
      // Actions already executed via streaming - return final result from context
      const finalResult = actionContext.results.length > 0
        ? actionContext.results[actionContext.results.length - 1]
        : {};

      if (actionContext.results.length > 1) {
        return {
          ...finalResult,
          _allResults: actionContext.results,
          _finalResult: finalResult
        };
      }

      return finalResult;
    }

    // No streaming - handle traditional execution path
    // Handle malformed responses - if LLM didn't return actions or result, try to extract
    if (result && !result.actions && !result.result) {
      // LLM returned unexpected format - try to find actions in other fields
      for (const key of Object.keys(result)) {
        if (Array.isArray(result[key]) && result[key].length > 0 && result[key][0].type) {
          // Found array of actions under different key
          console.warn(`[${this.name}] ⚠️  LLM returned actions under "${key}" instead of "actions" - fixing`);
          result.actions = result[key];
          delete result[key];
          break;
        }
      }
    }

    // Check if LLM returned actions (new action-based system)
    if (result && result.actions && Array.isArray(result.actions)) {
      // Decision: Should this agent execute actions or return them?
      //
      // Execute actions if:
      // - NOT called from delegation (orchestrators always execute)
      // - OR agent is a specialized worker (has no teams to delegate to)
      //   Workers should execute their specialized actions (registry ops, tool calls, etc.)
      //   even when called from delegation
      const canDelegateToTeams = this.usesTeams && this.usesTeams.length > 0;
      const shouldExecuteActions = !_fromDelegation || !canDelegateToTeams;

      if (shouldExecuteActions) {
        // Don't log action count - not useful information
        // console.log(`[${this.name}] → ${result.actions.length} actions`);

        // Extract any additional fields the LLM provided (plan, explanation, etc.)
        const { actions, ...additionalFields } = result;

        // Execute the actions
        const actionResults = await this.executeActions(actions);

        // If there are additional fields, merge them with the action results
        if (Object.keys(additionalFields).length > 0) {
          return {
            ...additionalFields,
            ...actionResults
          };
        }

        return actionResults;
      } else {
        // Agent is an orchestrator called from delegation - don't execute nested delegation
        // (This prevents infinite loops where orchestrators try to delegate from within delegation)
        console.log(`[${this.name}] ⚠️  Ignoring nested actions (orchestrator in delegated call)`);

        // Return the result without the actions field
        const { actions, ...actualResult } = result;

        // If there's no other data besides actions, try to extract from first action
        if (Object.keys(actualResult).length === 0 && actions.length > 0) {
          const firstAction = actions[0];
          return firstAction.data || firstAction.result || {};
        }

        return actualResult;
      }
    }

    // Legacy support: Apply state updates if returned by LLM
    if (result && typeof result === 'object') {
      // Check if LLM returned state updates
      if (result.state_updates || result.stateUpdates) {
        const updates = result.state_updates || result.stateUpdates;

        // Apply updates to agent state
        Object.keys(updates).forEach(key => {
          this.state[key] = updates[key];
        });
      }

      // If result has both state_updates and other fields, return just the result fields
      if (result.state_updates || result.stateUpdates) {
        const { state_updates, stateUpdates, ...resultData } = result;
        return resultData;
      }
    }

    return result;
  }

  async executeActions(actions) {
    let finalResult = {};
    let context = {
      state: this.state,
      results: [] // Track all results for chaining
    };

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // Resolve variable references FIRST (before condition check)
      const resolvedAction = this.resolveActionReferences(action, context);

      // Check if action has a condition - skip if condition is false
      // IMPORTANT: Evaluate condition BEFORE the action executes, using current context
      if (resolvedAction.condition !== undefined) {
        const conditionMet = this.evaluateCondition(resolvedAction.condition, context);
        if (!conditionMet) {
          // Skip this action silently
          continue;
        }
      }

      const intent = resolvedAction.intent || resolvedAction.type || resolvedAction.description;

      // Show what action is being executed
      // Use the "title" field if the LLM provided one, otherwise use intent
      const actionTitle = resolvedAction.title || intent;
      cliLogger.progress(`[${this.name}] ${actionTitle}`);

      // Check if this is a delegation action
      if (action.actionType === 'delegate') {
        // Delegation: route to appropriate team member
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Agent:${this.name}] 🔀 Delegating action: ${action.intent}`);
        }
        finalResult = await this.resolveAction(resolvedAction, context);
      } else {
        // Direct action: check if this is a registered action with an executor
        const actionDef = actionRegistry.get(action.intent || action.type);

        if (actionDef && actionDef.execute) {
          // Fast path: execute registered action
          finalResult = await actionDef.execute(resolvedAction, this);

          // Special handling for return action with conditions
          if ((action.intent === 'return' || action.type === 'return') && action.condition !== undefined) {
            context.results.push(finalResult);
            context.previousResult = finalResult;
            context.lastResult = finalResult;
            i = actions.length; // Exit loop
          }
        } else if (action.intent || action.description) {
          // Resolve via router (legacy fallback)
          finalResult = await this.resolveAction(resolvedAction, context);
        } else {
          // Fallback legacy
          finalResult = await this.executeLegacyAction(resolvedAction);
        }
      }

      // Clear progress after action completes
      cliLogger.clear();

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Agent:${this.name}] 🔍 Action ${intent} returned:`, JSON.stringify(finalResult).substring(0, 150));
      }

      // Update context with result for next action (chaining)
      if (finalResult && typeof finalResult === 'object') {
        // Unwrap double-encoded results (LLM sometimes returns { "result": "{...json...}" })
        if (finalResult.result && typeof finalResult.result === 'string' &&
            Object.keys(finalResult).length === 1) {
          try {
            const parsed = JSON.parse(finalResult.result);
            if (typeof parsed === 'object') {
              finalResult = parsed;
            }
          } catch (e) {
            // Not JSON, keep as-is
          }
        }

        // Deep clone result to avoid reference issues with conditions
        const resultForContext = JSON.parse(JSON.stringify(finalResult));

        context.results.push(resultForContext);

        // Store result with action ID for explicit referencing
        if (action.id) {
          context[action.id] = { output: resultForContext };

          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] 💾 Stored ${action.id}.output`);
          }
        }

        // Only update previousResult for actions that produce meaningful data
        // Side-effect actions like print, format (that return metadata) should not override previousResult
        const nonDataActions = ['print', 'log', 'format'];

        if (!nonDataActions.includes(intent)) {
          context.previousResult = resultForContext; // Last meaningful result
          context.lastResult = resultForContext; // Alias

          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] 📌 Updated previousResult from ${intent}:`, JSON.stringify(context.previousResult).substring(0, 100));
          }
        } else {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] 🚫 NOT updating previousResult for ${intent} (side-effect action)`);
          }
        }

        // Make result fields directly accessible
        Object.keys(resultForContext).forEach(key => {
          if (!context[key]) { // Don't override system fields
            context[key] = resultForContext[key];
          }
        });
      }
    }

    // If multiple actions were executed, return complete context with all results
    if (context.results.length > 1) {
      return {
        ...finalResult, // Include final result fields at top level for backward compatibility
        _allResults: context.results, // Full chain of results
        _finalResult: finalResult // Explicit final result
      };
    }

    // Single action - just return the result
    return finalResult;
  }


  /**
   * Resolve variable references in action data
   * Supports: ${a1.output.field}, ${previousResult.field}, ${results[0].field}, ${field}
   */
  resolveActionReferences(action, context) {
    // Deep clone to avoid mutating original
    const resolved = JSON.parse(JSON.stringify(action));

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent:${this.name}] 🔄 Resolving references for action: ${action.intent || action.type}`);
    }

    // DON'T resolve condition here - it will be evaluated directly in evaluateCondition()
    // (Conditions need special handling to preserve boolean expressions)

    // Resolve references in data field
    if (resolved.data) {
      resolved.data = this.resolveObjectReferences(resolved.data, context);
    }

    // Resolve references in input field
    if (resolved.input) {
      resolved.input = this.resolveObjectReferences(resolved.input, context);
    }

    // Resolve references in key, value, query, prefix fields (for registry operations)
    if (resolved.key) {
      resolved.key = this.resolveObjectReferences(resolved.key, context);
    }
    if (resolved.value !== undefined) {
      resolved.value = this.resolveObjectReferences(resolved.value, context);
    }
    if (resolved.query) {
      resolved.query = this.resolveObjectReferences(resolved.query, context);
    }
    if (resolved.prefix !== undefined) {
      resolved.prefix = this.resolveObjectReferences(resolved.prefix, context);
    }

    // Resolve references in message/text fields (for print action)
    if (resolved.message !== undefined) {
      resolved.message = this.resolveObjectReferences(resolved.message, context);
    }
    if (resolved.text !== undefined) {
      resolved.text = this.resolveObjectReferences(resolved.text, context);
    }

    return resolved;
  }

  /**
   * Build evaluation context with all available variables including action IDs
   */
  buildEvalContext(context) {
    const evalContext = {
      previousResult: context.previousResult,
      lastResult: context.lastResult,
      results: context.results,
      state: context.state,
      args: context.args,
      Date, // Allow Date constructor
      JSON, // Allow JSON methods
      Math  // Allow Math methods
    };
    // Add all action IDs from context (a1, a2, a3, etc.)
    for (const key in context) {
      if (key.match(/^a\d+$/)) { // Match action IDs like a1, a2, a3...
        evalContext[key] = context[key];
      }
    }
    return evalContext;
  }

  /**
   * Recursively resolve references in an object
   */
  resolveObjectReferences(obj, context) {
    if (typeof obj === 'string') {
      // Check if the ENTIRE string is a single ${...} reference (not a template)
      const singleRefMatch = obj.match(/^\$\{([^}]+)\}$/);
      if (singleRefMatch) {
        const expr = singleRefMatch[1].trim();

        // Try to get it as a direct path from context
        const directValue = this.getNestedValue(context, expr);
        if (directValue !== undefined) {
          // Return the value directly (could be object, array, number, etc.)
          return directValue;
        }

        // Try to evaluate as JavaScript expression
        try {
          const evalContext = this.buildEvalContext(context);
          const fn = new Function(...Object.keys(evalContext), `return ${expr};`);
          const result = fn(...Object.values(evalContext));
          return result !== undefined ? result : obj;
        } catch (error) {
          return obj;
        }
      }

      // Multiple references in a template string - resolve to a string
      return obj.replace(/\$\{([^}]+)\}/g, (match, expr) => {
        const trimmedExpr = expr.trim();

        // First try to get it as a direct path from context
        const directValue = this.getNestedValue(context, trimmedExpr);
        if (directValue !== undefined) {
          // Convert to string for template interpolation
          return typeof directValue === 'object' ? JSON.stringify(directValue) : String(directValue);
        }

        // Log only unresolved placeholders in debug mode
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Agent:${this.name}] ⚠️  Could not resolve placeholder: ${trimmedExpr}`);
        }

        // If not found in context, try to evaluate as JavaScript expression
        try {
          const evalContext = this.buildEvalContext(context);
          const fn = new Function(...Object.keys(evalContext), `return ${trimmedExpr};`);
          const result = fn(...Object.values(evalContext));
          return result !== undefined ? (typeof result === 'object' ? JSON.stringify(result) : String(result)) : match;
        } catch (error) {
          // If evaluation fails, return the original match
          return match;
        }
      });
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveObjectReferences(item, context));
    }

    if (obj && typeof obj === 'object') {
      const resolved = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveObjectReferences(value, context);
      }
      return resolved;
    }

    return obj;
  }

  /**
   * Get nested value from object using dot notation
   * Examples: "previousResult.translated", "results[0].count"
   */
  getNestedValue(obj, path) {
    // Handle array access: results[0].field
    path = path.replace(/\[(\d+)\]/g, '.$1');

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Evaluate a condition expression
   * Supports: boolean values, comparison expressions with context variables
   * Examples: true, false, "${previousResult.found}", "${previousResult.count > 0}"
   */
  evaluateCondition(condition, context) {
    // If already a boolean, return it
    if (typeof condition === 'boolean') {
      return condition;
    }

    // If it's an object, convert to string first (LLM sometimes sends objects)
    if (typeof condition === 'object' && condition !== null) {
      console.warn(`[Agent:${this.name}] Condition is an object, converting to string: ${JSON.stringify(condition)}`);
      return false; // Skip actions with malformed conditions
    }

    // If it's a string, evaluate it as JavaScript expression
    if (typeof condition === 'string') {
      // Check if the entire condition is a single ${...} expression
      const singleExprMatch = condition.match(/^\$\{([^}]+)\}$/);
      if (singleExprMatch) {
        // Evaluate the expression directly and return its boolean value
        try {
          const expr = singleExprMatch[1].trim();
          const evalContext = { ...this.buildEvalContext(context), ...context };
          // Evaluate the expression and convert to boolean
          // Don't use !! here because the expression itself might contain negations
          const fn = new Function(...Object.keys(evalContext), `return ${expr};`);
          const rawResult = fn(...Object.values(evalContext));
          return !!rawResult;
        } catch (error) {
          console.warn(`[Agent:${this.name}] Failed to evaluate condition expression "${condition}": ${error.message}`);
          return false;
        }
      }

      // Multiple ${...} expressions or mixed content - resolve then evaluate
      let resolved = condition.replace(/\$\{([^}]+)\}/g, (match, expr) => {
        try {
          const evalContext = { ...this.buildEvalContext(context), ...context };
          const fn = new Function(...Object.keys(evalContext), `return ${expr};`);
          const result = fn(...Object.values(evalContext));
          // Convert to string for template interpolation
          return typeof result === 'object' ? JSON.stringify(result) : String(result);
        } catch (error) {
          console.warn(`[Agent:${this.name}] Failed to evaluate condition sub-expression "${expr}": ${error.message}`);
          return match;
        }
      });

      // Try to evaluate the resolved string as a boolean
      if (resolved === 'true') return true;
      if (resolved === 'false') return false;

      try {
        const evalContext = { ...this.buildEvalContext(context), ...context };
        const fn = new Function(...Object.keys(evalContext), `return !!(${resolved});`);
        return fn(...Object.values(evalContext));
      } catch (error) {
        console.warn(`[Agent:${this.name}] Failed to evaluate resolved condition "${resolved}": ${error.message}`);
        return false;
      }
    }

    // Default to false for unknown types
    return false;
  }

  /**
   * Resolve an action using cascading strategy:
   * 1️⃣ Can I handle it myself (do I have a handler)?
   * 2️⃣ Do I have a skill that can do it?
   * 3️⃣ Can I delegate to another agent via router?
   * 4️⃣ Can I execute directly with a simple prompt?
   */
  async resolveAction(action, context = {}) {
    const intent = action.intent || action.type || action.description;

    // Check for infinite loops before proceeding
    const callSignature = `${this.name}:${intent}`;
    if (globalCallStack.includes(callSignature)) {
      throw new Error(
        `[Agent:${this.name}] Infinite loop detected!\n` +
        `  Call stack: ${globalCallStack.join(' → ')} → ${callSignature}\n` +
        `  Preventing recursion for intent: "${intent}"`
      );
    }

    // Push to call stack
    globalCallStack.push(callSignature);

    try {
      // 1️⃣ Do I have a handler for this? (check my own event handlers)
      const matchingHandler = this.findMatchingHandler(intent);
      if (matchingHandler) {
        // Self-delegation (same agent handles it)
        const result = await this.handle(matchingHandler, action.data || action.input || {}, false);
        globalCallStack.pop();
        return result;
      }

      // 2️⃣ Do I have a matching skill?
      const matchingSkill = this.findMatchingSkill(intent);
      if (matchingSkill) {
        cliLogger.progress(`  → [${this.name}] skill:${matchingSkill}...`);
        const result = await this.callSkill(matchingSkill, action.data || action.input || {});
        cliLogger.clear();
        globalCallStack.pop();
        return result;
      }

      // 3️⃣ Can someone in my teams handle it? (check peers + usesTeams)
      if (this.peers || this.usesTeams.length > 0) {
        // Search within team members - team defines communication boundaries
        const teamMember = await this.findTeamMemberForIntent(intent);

        if (teamMember) {
          // Show delegation with indentation
          const actionTitle = action.title || intent;
          cliLogger.pushIndent(`[${teamMember.agent.name}] ${actionTitle}`);

          const result = await teamMember.agent.handle(teamMember.event, action.data || action.input || {}, true);

          // Pop indentation when delegation returns
          cliLogger.popIndent();

          globalCallStack.pop();
          return result;
        }
      } else if (intent && typeof intent === 'string' && intent.trim() !== '') {
        // No teams defined - fall back to global router (rare case)
        const { agentRouter } = await import('./router.js');
        let matches = await agentRouter.findMatches(intent, 5);

        // Filter out self-delegation
        matches = matches.filter(match => match.agent !== this);

        if (matches.length > 0) {
          const best = matches[0];
          const actionTitle = action.title || intent;
          cliLogger.pushIndent(`[${best.agent.name}] ${actionTitle}`);

          const result = await best.agent.handle(best.event, action.data || action.input || {}, true);
          cliLogger.popIndent();

          globalCallStack.pop();
          return result;
        }
      }

      // 4️⃣ Can I execute directly with LLM? (simple tasks, only if no one else can do it)
      if (this.canExecuteDirectly(action)) {
        const result = await this.executeDirectly(action, context);
        globalCallStack.pop();
        return result;
      }

      // ❌ Cannot resolve
      globalCallStack.pop();
      throw new Error(
        `[Agent:${this.name}] Cannot resolve: "${intent}"\n` +
        `  - I don't have a handler for this\n` +
        `  - I don't have a matching skill\n` +
        `  - No team member available via router\n` +
        `  - Too complex for direct execution`
      );
    } catch (error) {
      // Clean up call stack on error
      globalCallStack.pop();
      throw error;
    }
  }

  /**
   * Find a team member that can handle the intent
   * Searches in peers (if member of a team) and usesTeams (teams this agent uses)
   */
  async findTeamMemberForIntent(intent) {
    if (!intent || typeof intent !== 'string' || intent.trim() === '') {
      return null;
    }

    const { agentRouter } = await import('./router.js');

    // Get all potential matches from the global router
    let matches = await agentRouter.findMatches(intent, 10);

    // Collect all teams this agent can access
    const accessibleTeams = [];

    // Add peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      accessibleTeams.push(this.peers);
    }

    // Add usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        accessibleTeams.push(team);
      }
    }

    if (accessibleTeams.length === 0) {
      return null;
    }

    // Filter to only include agents that are in accessible teams
    matches = matches.filter(match => {
      // Check if this agent is in any accessible team
      const isAccessible = accessibleTeams.some(team => {
        const teamMemberNames = Object.keys(team.members);
        return teamMemberNames.some(name => {
          const member = team.members[name];
          return member === match.agent || member.name === match.agent.name;
        });
      });

      // Also exclude self
      return isAccessible && match.agent !== this;
    });

    if (matches.length > 0) {
      return matches[0];
    }

    // Fallback: Try direct handler matching in accessible team members
    for (const team of accessibleTeams) {
      const memberNames = Object.keys(team.members);
      for (const memberName of memberNames) {
        const member = team.members[memberName];
        if (member === this) continue; // Skip self

        const matchingEvent = member.findMatchingHandler(intent);
        if (matchingEvent) {
          return { agent: member, event: matchingEvent };
        }
      }
    }

    return null;
  }

  /**
   * Find a handler in this agent that matches the intent
   */
  findMatchingHandler(intent) {
    if (!this.handlers || Object.keys(this.handlers).length === 0) {
      return null;
    }

    if (!intent || typeof intent !== 'string') {
      return null;
    }

    const intentLower = intent.toLowerCase().replace(/[^a-z0-9]/g, ''); // Remove non-alphanumeric

    // Try exact match first (case insensitive, ignoring separators)
    for (const eventName of Object.keys(this.handlers)) {
      const eventNormalized = eventName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (eventNormalized === intentLower) {
        return eventName;
      }
    }

    // Try partial match
    for (const eventName of Object.keys(this.handlers)) {
      const eventLower = eventName.toLowerCase();
      const intentOriginal = intent.toLowerCase();

      if (intentOriginal.includes(eventLower) || eventLower.includes(intentOriginal)) {
        return eventName;
      }
    }

    // Try keyword matching (split by spaces and camelCase)
    const keywords = intent
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .toLowerCase()
      .split(/\s+/)
      .filter(k => k.length > 2);

    for (const eventName of Object.keys(this.handlers)) {
      const eventLower = eventName.toLowerCase();

      for (const keyword of keywords) {
        if (eventLower.includes(keyword)) {
          return eventName;
        }
      }
    }

    return null;
  }

  /**
   * Generate documentation of peer capabilities for LLM prompts
   * Returns a string describing what intents can be delegated to which peers
   */
  getPeerCapabilitiesDocumentation() {
    const capabilities = [];
    const processedAgents = new Set();

    // Helper function to collect handlers from an agent
    const collectHandlers = (agent, teamName = null) => {
      if (!agent || processedAgents.has(agent.name)) {
        return;
      }
      processedAgents.add(agent.name);

      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        const handlers = Object.keys(agent.handlers);
        const agentInfo = teamName ? `${agent.name} (${teamName})` : agent.name;

        // Collect handler details with descriptions
        const handlerDetails = [];
        for (const handler of handlers) {
          const handlerFn = agent.handlers[handler];
          let description = '';

          if (handlerFn && handlerFn.__playbook__) {
            const playbook = handlerFn.__playbook__;
            const firstLine = playbook.split('\n')[0].trim();
            description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 60);
            if (description.length < firstLine.length) {
              description += '...';
            }
          }

          handlerDetails.push({
            name: handler,
            description: description || `Handle ${handler}`
          });
        }

        capabilities.push({
          agent: agentInfo,
          role: agent.role ? agent.role.name : 'Unknown',
          handlers: handlerDetails
        });
      }
    };

    // Collect from peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      const memberNames = Object.keys(this.peers.members);
      for (const memberName of memberNames) {
        const member = this.peers.members[memberName];
        if (member !== this) {
          collectHandlers(member, this.peers.name);
        }
      }
    }

    // Collect from usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        const memberNames = Object.keys(team.members);
        for (const memberName of memberNames) {
          const member = team.members[memberName];
          collectHandlers(member, team.name);
        }
      }
    }

    if (capabilities.length === 0) {
      return '';
    }

    let doc = '\nAvailable team member capabilities:\n';
    for (const cap of capabilities) {
      doc += `\n${cap.agent} [${cap.role}]:\n`;
      for (const handler of cap.handlers) {
        doc += `  - ${handler.name}: ${handler.description}\n`;
      }
    }
    doc += '\nTo delegate, use: { "intent": "handler_name", "data": {...} }\n';

    return doc;
  }

  /**
   * Generate peer capabilities formatted as available actions
   * Returns a string listing delegation actions in the same format as action registry
   */
  getPeerCapabilitiesAsActions() {
    const capabilities = [];
    const processedAgents = new Set();

    // Helper function to collect handlers from an agent
    const collectHandlers = (agent, teamName = null) => {
      if (!agent || processedAgents.has(agent.name)) {
        return;
      }
      processedAgents.add(agent.name);

      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        const handlers = Object.keys(agent.handlers);
        for (const handler of handlers) {
          const agentInfo = teamName ? `${agent.name} (${teamName})` : agent.name;

          // Extract affordance/description from handler
          let description = '';
          const handlerFn = agent.handlers[handler];

          if (handlerFn && handlerFn.__playbook__) {
            // Extract first line or first sentence from playbook as description
            const playbook = handlerFn.__playbook__;
            const lines = playbook.split('\n');
            const firstLine = lines[0].trim();

            // Remove template variables for cleaner description
            description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 80);
            if (description.length < firstLine.length) {
              description += '...';
            }

            // Try to extract return structure from playbook
            // Look for patterns like "return: { ... }" or "2. Return: { ... }"
            for (const line of lines) {
              const returnMatch = line.match(/(?:return|Return):\s*\{([^}]+)\}/i);
              if (returnMatch) {
                // Found a return statement - extract key structure
                const returnContent = returnMatch[1];
                // Extract field names (simple parsing)
                const fields = returnContent.match(/"([^"]+)":/g);
                if (fields) {
                  const fieldNames = fields.map(f => f.replace(/[":]/g, '')).join(', ');
                  description += ` → Returns: {${fieldNames}}`;
                }
                break;
              }
            }
          } else if (handlerFn && typeof handlerFn === 'function') {
            // For regular functions, generate description from name
            description = `Handle ${handler} event`;
          }

          capabilities.push({
            intent: handler,
            agent: agentInfo,
            role: agent.role ? agent.role.name : 'Unknown',
            description: description || `Execute ${handler}`
          });
        }
      }
    };

    // Collect from peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      const memberNames = Object.keys(this.peers.members);
      for (const memberName of memberNames) {
        const member = this.peers.members[memberName];
        if (member !== this) {
          collectHandlers(member, this.peers.name);
        }
      }
    }

    // Collect from usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        const memberNames = Object.keys(team.members);
        for (const memberName of memberNames) {
          const member = team.members[memberName];
          collectHandlers(member, team.name);
        }
      }
    }

    if (capabilities.length === 0) {
      return '';
    }

    let doc = '\n\nDelegation actions (to team members):\n';
    for (const cap of capabilities) {
      doc += `- { "actionType": "delegate", "intent": "${cap.intent}", "data": ... } - ${cap.description} (Delegate to ${cap.agent} [${cap.role}])\n`;
    }

    return doc;
  }

  /**
   * Check if action can be executed directly with LLM
   */
  canExecuteDirectly(action) {
    // Has inline playbook
    if (action.playbook) return true;

    // Explicit LLM task
    if (action.type === 'llm_task') return true;

    // Simple state operations
    if (action.type === 'update_state' || action.type === 'return') return true;

    // If it's a very simple task description, LLM can handle it
    const intent = action.intent || action.description || '';
    if (intent.length < 100 && !action.requiresExternalAgent) {
      return true;
    }

    return false;
  }

  /**
   * Execute action directly with LLM
   */
  async executeDirectly(action, context) {
    // Check if this is a registered action with an executor
    const actionDef = actionRegistry.get(action.type);

    if (actionDef && actionDef.execute) {
      // Use the registered executor
      return await actionDef.execute(action, this);
    }

    // Execute with LLM
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    let prompt;

    if (action.playbook) {
      prompt = action.playbook;
    } else {
      // Generate simple prompt
      const intent = action.intent || action.description;
      const data = action.data || action.input || {};

      prompt = `
Task: ${intent}

Input data:
${JSON.stringify(data, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

Execute this task and return the result as JSON.
`;
    }

    return await this.llmProvider.executePlaybook(prompt, context, this.name, [], this, false);
  }

  /**
   * Find a skill that matches the given intent
   */
  findMatchingSkill(intent) {
    if (!this.skills || this.skills.length === 0) {
      return null;
    }

    if (!intent || typeof intent !== 'string') {
      return null;
    }

    const intentLower = intent.toLowerCase();

    // Try exact or partial match
    for (const skill of this.skills) {
      const skillLower = skill.toLowerCase();

      if (intentLower.includes(skillLower) || skillLower.includes(intentLower)) {
        return skill;
      }
    }

    // Try keyword matching
    const keywords = intentLower.split(/\s+/);

    for (const skill of this.skills) {
      const skillLower = skill.toLowerCase();

      for (const keyword of keywords) {
        if (keyword.length > 3 && skillLower.includes(keyword)) {
          return skill;
        }
      }
    }

    return null;
  }

  /**
   * Execute legacy action (fallback for actions without executors)
   * This should rarely be used now - most actions have executors
   */
  async executeLegacyAction(action) {
    throw new Error(`Action type "${action.type}" has no executor registered and no legacy handler`);
  }


  async callSkill(skillName, functionNameOrInput, inputOrUndefined) {
    if (!this.skills.includes(skillName)) {
      throw new Error(`Agent ${this.name} does not have skill: ${skillName}`);
    }

    // Support two calling conventions:
    // 1. callSkill(skillName, functionName, input) - call specific function
    // 2. callSkill(skillName, input) - legacy: find matching function by intent
    let functionName, input;

    if (inputOrUndefined !== undefined) {
      // Convention 1: explicit function name
      functionName = functionNameOrInput;
      input = inputOrUndefined;
    } else {
      // Convention 2: auto-select function (legacy)
      input = functionNameOrInput;

      // Try to find a matching function using skill selector
      // For now, we'll just use the first available function
      const skillFunctions = globalThis.SkillRegistry?.getAll(skillName);
      if (!skillFunctions || Object.keys(skillFunctions).length === 0) {
        throw new Error(`No functions found in skill: ${skillName}`);
      }

      functionName = Object.keys(skillFunctions)[0];
    }

    // Get the function from SkillRegistry
    const skillFunction = globalThis.SkillRegistry?.get(skillName, functionName);

    if (!skillFunction) {
      throw new Error(`Function ${functionName} not found in skill ${skillName}`);
    }

    // Execute the skill function
    try {
      const result = await skillFunction.fn(input);
      return result;
    } catch (error) {
      throw new Error(`Skill ${skillName}.${functionName} failed: ${error.message}`);
    }
  }

  /**
   * Get available skill functions for tool calling
   * Returns an array of { name, fn, description } for each available function
   */
  getSkillFunctions() {
    const functions = [];

    // Access SkillRegistry from global scope (set by transpiled code)
    if (typeof globalThis.SkillRegistry !== 'undefined') {
      for (const skillName of this.skills) {
        const skillFunctions = globalThis.SkillRegistry.getAll(skillName);
        for (const [funcName, { fn, metadata }] of Object.entries(skillFunctions)) {
          functions.push({
            name: funcName,
            fn,
            description: metadata.affordance || `Function from ${skillName} skill`
          });
        }
      }
    }

    return functions;
  }


  toString() {
    return `Agent(${this.name}:${this.role.name})`;
  }
}
