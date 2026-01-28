/**
 * Repeat Action - Execute actions N times
 */

export default {
  type: 'repeat',
  intent: 'repeat',
  description: 'Execute actions a fixed number of times. Use for "ask 3 times", "do X times" → Returns: { iterations: N, results: [array of results] }',
  permission: 'execute',

  schema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of times to repeat (e.g., 3)'
      },
      actions: {
        type: 'array',
        description: 'Actions to execute in each iteration'
      }
    },
    required: ['count', 'actions']
  },

  examples: [
    {
      intent: 'repeat',
      count: 3,
      actions: [
        { id: 'a1', intent: 'prompt_user', question: '¿Cuántos años tienes?' },
        { intent: 'print', message: 'Respuesta ${iteration}: ${a1.output.answer}' }
      ]
    }
  ],

  // Executor function
  async execute(action, agent) {
    const count = action.count || action.data?.count || 1;
    const actions = action.actions || action.data?.actions || [];

    if (!actions || actions.length === 0) {
      throw new Error('repeat action requires an "actions" array');
    }

    if (typeof count !== 'number' || count < 1) {
      throw new Error('repeat action requires a positive number for "count"');
    }

    // Get the current action context from the agent
    const context = agent._currentActionContext || {
      state: agent.state,
      results: []
    };

    // Execute actions with inherited context
    const actionRegistry = (await import('../action-registry.js')).actionRegistry;
    const cliLogger = (await import('../cli-logger.js')).cliLogger;

    const allResults = [];

    for (let i = 0; i < count; i++) {
      // Create iteration context with current iteration number
      const iterationContext = {
        ...context,
        iteration: i + 1,  // 1-based for user-friendly display
        iterationIndex: i  // 0-based for array access
      };

      for (const nestedAction of actions) {
        // Resolve references using the iteration context
        const resolvedAction = agent.resolveActionReferences(nestedAction, iterationContext);

        // Show progress
        const intent = resolvedAction.intent || resolvedAction.type;
        const displayText = resolvedAction.desc ? resolvedAction.desc.replace(/\.\.\.$/, '') : 'Thinking';
        cliLogger.planning(`[🤖 ${agent.name}] ${displayText}`);

        let result;

        // Check if this is a delegation action
        if (resolvedAction.actionType === 'delegate') {
          // Delegation: route to appropriate team member
          result = await agent.resolveAction(resolvedAction, iterationContext);
        } else {
          // Direct action: Get action definition from registry
          const actionDef = actionRegistry.get(nestedAction.intent || nestedAction.type);

          if (actionDef && actionDef.execute) {
            // Update agent's current context for nested action
            const previousContext = agent._currentActionContext;
            agent._currentActionContext = iterationContext;

            // Execute with agent
            result = await actionDef.execute(resolvedAction, agent);

            // Restore previous context
            agent._currentActionContext = previousContext;
          } else {
            cliLogger.clear();
            throw new Error(`Action ${nestedAction.intent || nestedAction.type} not found`);
          }
        }

        cliLogger.clear();

        // Update iteration context with result
        if (result && typeof result === 'object') {
          // Unwrap double-encoded results (LLM sometimes returns { "result": "{...json...}" })
          if (result.result && typeof result.result === 'string' && Object.keys(result).length === 1) {
            try {
              const parsed = JSON.parse(result.result);
              if (typeof parsed === 'object') {
                result = parsed;
              }
            } catch (e) {
              // Not JSON, keep as-is
            }
          }

          const resultForContext = JSON.parse(JSON.stringify(result));
          iterationContext.results.push(resultForContext);

          // Store with action ID if provided
          if (nestedAction.id) {
            iterationContext[nestedAction.id] = { output: resultForContext };

            // CRITICAL: Propagate action ID results back to parent context
            // so template variables like ${right_turn.output.answer} work outside the repeat
            context[nestedAction.id] = { output: resultForContext };

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[repeat] Stored result for ID "${nestedAction.id}":`, JSON.stringify(resultForContext));
            }
          }

          // Track all results
          allResults.push(resultForContext);
        }
      }
    }

    return {
      iterations: count,
      results: allResults
    };
  }
};
