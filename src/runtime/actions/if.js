/**
 * If Action - Conditional execution
 */

export default {
  type: 'if',
  intent: 'if',
  description: 'Execute actions conditionally. CONDITION: Use string "${a1.output} === \'yes\'" for exact match, OR object with llm_eval for semantic: { "llm_eval": true, "instruction": "Return true if user agrees", "data": "${a1.output.answer}" } → Returns: { executed: "then"|"else", result: ... }',
  permission: 'execute',

  schema: {
    type: 'object',
    properties: {
      condition: {
        type: 'string',
        description: 'Condition to evaluate (e.g., "${a1.output.answer} === \'Yes\'")'
      },
      then: {
        type: 'array',
        description: 'Actions to execute if condition is true'
      },
      else: {
        type: 'array',
        description: 'Actions to execute if condition is false (optional)'
      }
    },
    required: ['condition', 'then']
  },

  examples: [
    {
      id: 'a1',
      intent: 'prompt_user',
      question: 'Do you want to continue?',
      options: ['Yes', 'No']
    },
    {
      intent: 'if',
      condition: "${a1.output.answer} === 'Yes'",
      then: [
        { id: 'a2', intent: 'prompt_user', question: 'What is your age?' },
        { intent: 'print', message: 'Your age is: ${a2.output.answer}' }
      ],
      else: [
        { intent: 'print', message: 'Goodbye!' }
      ]
    }
  ],

  // Executor function
  async execute(action, agent) {
    const condition = action.condition || action.data?.condition || '';
    const thenActions = action.then || action.data?.then || [];
    const elseActions = action.else || action.data?.else || [];

    if (!condition) {
      throw new Error('if action requires a "condition" field');
    }

    // Get the current action context from the agent
    const context = agent._currentActionContext || {
      state: agent.state,
      results: []
    };

    // Evaluate condition
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
      throw new Error(`Failed to evaluate condition: ${error.message}`);
    }

    // Execute appropriate branch
    const actionsToExecute = conditionResult ? thenActions : elseActions;

    if (!actionsToExecute || actionsToExecute.length === 0) {
      return { executed: conditionResult ? 'then' : 'else', result: null };
    }

    // Execute actions with inherited context (so nested actions can access a1, a2, etc.)
    // We need to execute them manually to preserve the parent context
    const actionRegistry = (await import('../action-registry.js')).actionRegistry;
    const cliLogger = (await import('../cli-logger.js')).cliLogger;

    let result = null;
    for (const nestedAction of actionsToExecute) {
      // Resolve references using the parent context
      const resolvedAction = agent.resolveActionReferences(nestedAction, context);

      // Show progress
      const intent = resolvedAction.intent || resolvedAction.type;
      const displayText = resolvedAction.desc ? resolvedAction.desc.replace(/\.\.\.$/, '') : 'Thinking';
      cliLogger.planning(`[🤖 ${agent.name}] ${displayText}`);

      // Check if this is a delegation action
      if (resolvedAction.actionType === 'delegate') {
        // Delegation: route to appropriate team member
        result = await agent.resolveAction(resolvedAction, context);
      } else {
        // Direct action: Get action definition from registry
        const actionDef = actionRegistry.get(nestedAction.intent || nestedAction.type);

        if (actionDef && actionDef.execute) {
          // Update agent's current context for nested action
          const previousContext = agent._currentActionContext;
          agent._currentActionContext = context;

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

      // Update parent context with result
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
        context.results.push(resultForContext);

        // Store with action ID if provided
        if (nestedAction.id) {
          context[nestedAction.id] = { output: resultForContext };
        }
      }
    }

    return {
      executed: conditionResult ? 'then' : 'else',
      result: result
    };
  }
};
