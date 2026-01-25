/**
 * While Action - Execute actions while condition is true
 */

export default {
  type: 'while',
  intent: 'while',
  description: 'Execute actions repeatedly while condition is true. Use for "until user says goodbye", "keep asking while..." → Returns: { iterations: N, results: [array], stopped_reason: "condition_false" | "max_iterations" }',
  permission: 'execute',

  schema: {
    type: 'object',
    properties: {
      condition: {
        oneOf: [
          { type: 'string', description: 'Simple condition (e.g., "${a1.output.answer} !== \'hasta luego\'")' },
          { type: 'object', description: 'LLM-evaluated condition with llm_eval: true, instruction, and data fields' }
        ]
      },
      actions: {
        type: 'array',
        description: 'Actions to execute in each iteration'
      },
      max_iterations: {
        type: 'number',
        description: 'Optional safety limit to prevent infinite loops (default: 100)'
      }
    },
    required: ['condition', 'actions']
  },

  examples: [
    {
      intent: 'while',
      condition: "${a1.output.answer} !== 'hasta luego'",
      max_iterations: 10,
      actions: [
        { id: 'a1', intent: 'prompt_user', question: '¿Qué quieres hablar? (escribe "hasta luego" para salir)' },
        { intent: 'print', message: 'Dijiste: ${a1.output.answer}' }
      ]
    }
  ],

  // Executor function
  async execute(action, agent) {
    const condition = action.condition || action.data?.condition || '';
    const actions = action.actions || action.data?.actions || [];
    const maxIterations = action.max_iterations || action.data?.max_iterations || 100;

    if (!condition) {
      throw new Error('while action requires a "condition" field');
    }

    if (!actions || actions.length === 0) {
      throw new Error('while action requires an "actions" array');
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
    let iterations = 0;
    let stoppedReason = 'condition_false';

    while (iterations < maxIterations) {
      // Evaluate condition
      let conditionResult = false;
      try {
        // Check if condition is LLM-evaluated (object with llm_eval: true)
        if (typeof condition === 'object' && condition.llm_eval === true) {
          // Use format action to evaluate condition with LLM
          const formatAction = (await import('./format.js')).default;

          // Resolve data references
          const resolvedData = agent.resolveObjectReferences(condition.data || {}, context);

          // Create format action to evaluate condition
          const formatRequest = {
            data: resolvedData,
            instruction: condition.instruction + "\n\nRESPOND WITH ONLY 'true' or 'false' (lowercase, no quotes, no explanation)."
          };

          const formatResult = await formatAction.execute(formatRequest, agent);
          const formatted = formatResult.formatted.trim().toLowerCase();

          // Parse boolean result
          conditionResult = formatted === 'true';
        } else {
          // Simple string condition - evaluate with JavaScript
          conditionResult = agent.evaluateCondition(condition, context);
        }
      } catch (error) {
        throw new Error(`Failed to evaluate while condition: ${error.message}`);
      }

      // If condition is false, stop
      if (!conditionResult) {
        stoppedReason = 'condition_false';
        break;
      }

      iterations++;

      // Create iteration context with current iteration number
      const iterationContext = {
        ...context,
        iteration: iterations,
        iterationIndex: iterations - 1
      };

      for (const nestedAction of actions) {
        // Resolve references using the iteration context
        const resolvedAction = agent.resolveActionReferences(nestedAction, iterationContext);

        // Show progress
        const intent = resolvedAction.intent || resolvedAction.type;
        cliLogger.progress(`[${agent.name}] ${intent} (iteration ${iterations})`);

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

          // Update iteration context with result (and parent context for next iteration's condition check)
          if (result && typeof result === 'object') {
            const resultForContext = JSON.parse(JSON.stringify(result));
            iterationContext.results.push(resultForContext);
            context.results.push(resultForContext);  // Also update parent for condition evaluation

            // Store with action ID if provided
            if (nestedAction.id) {
              iterationContext[nestedAction.id] = { output: resultForContext };
              context[nestedAction.id] = { output: resultForContext };  // Also update parent
            }

            // Track all results
            allResults.push(resultForContext);
          }
        } else {
          cliLogger.clear();
          throw new Error(`Action ${nestedAction.intent || nestedAction.type} not found`);
        }
      }

      // Safety check
      if (iterations >= maxIterations) {
        stoppedReason = 'max_iterations';
        break;
      }
    }

    return {
      iterations,
      results: allResults,
      stopped_reason: stoppedReason
    };
  }
};
