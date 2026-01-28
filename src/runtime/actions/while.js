/**
 * While Action - Execute actions at least once, then repeat while condition is true (do-while semantics)
 */

export default {
  type: 'while',
  intent: 'while',
  description: 'Execute actions at least once, then repeat while condition is true. CONDITION: Use string "${a1.output} !== \'stop\'" for exact match, OR object with llm_eval for semantic: { "llm_eval": true, "instruction": "¿Continuar? (false si despide)", "data": "${a1.output.answer}" } → Returns: { iterations: N, results: [array], stopped_reason: "condition_false" | "max_iterations" }',
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

    // Do-while loop: execute at least once, then check condition
    while (iterations < maxIterations) {
      iterations++;

      // Create iteration context with current iteration number
      const iterationContext = {
        ...context,
        iteration: iterations,
        iterationIndex: iterations - 1
      };

      // Execute actions first
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
      }

      // After executing actions, evaluate condition to decide if we should continue
      let conditionResult = false;
      try {
        // Check if condition is LLM-evaluated (object with llm_eval: true)
        if (typeof condition === 'object' && condition.llm_eval === true) {
          // Show progress while evaluating condition
          const displayText = condition.desc ? condition.desc.replace(/\.\.\.$/, '') : 'Evaluating condition';
          cliLogger.planning(`[🤖 ${agent.name}] ${displayText}`);

          // Use call_llm action to evaluate condition with LLM
          const callLlmAction = (await import('./call-llm.js')).default;

          // Resolve data references
          const resolvedData = agent.resolveObjectReferences(condition.data || {}, context);

          // Create call_llm action to evaluate condition
          const callLlmRequest = {
            data: resolvedData,
            instruction: condition.instruction + "\n\nRESPOND WITH ONLY 'true' or 'false' (lowercase, no quotes, no explanation)."
          };

          const llmResult = await callLlmAction.execute(callLlmRequest, agent);
          const resultText = llmResult.result.trim().toLowerCase();

          // Clear progress
          cliLogger.clear();

          // Parse boolean result
          conditionResult = resultText === 'true';
        } else {
          // Simple string condition - evaluate with JavaScript
          conditionResult = agent.evaluateCondition(condition, context);
        }
      } catch (error) {
        throw new Error(`Failed to evaluate while condition: ${error.message}`);
      }

      // If condition is false, stop (don't continue to next iteration)
      if (!conditionResult) {
        stoppedReason = 'condition_false';
        break;
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
