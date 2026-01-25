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
        cliLogger.progress(`[${agent.name}] ${intent} (iteration ${i + 1}/${count})`);

        // Get action definition
        const actionDef = actionRegistry.get(nestedAction.intent || nestedAction.type);

        if (actionDef && actionDef.execute) {
          // Update agent's current context for nested action
          const previousContext = agent._currentActionContext;
          agent._currentActionContext = iterationContext;

          // Execute with agent
          const result = await actionDef.execute(resolvedAction, agent);

          // Restore previous context
          agent._currentActionContext = previousContext;

          cliLogger.clear();

          // Update iteration context with result
          if (result && typeof result === 'object') {
            const resultForContext = JSON.parse(JSON.stringify(result));
            iterationContext.results.push(resultForContext);

            // Store with action ID if provided
            if (nestedAction.id) {
              iterationContext[nestedAction.id] = { output: resultForContext };
            }

            // Track all results
            allResults.push(resultForContext);
          }
        } else {
          cliLogger.clear();
          throw new Error(`Action ${nestedAction.intent || nestedAction.type} not found`);
        }
      }
    }

    return {
      iterations: count,
      results: allResults
    };
  }
};
