/**
 * If Action - Conditional execution
 */

export default {
  type: 'if',
  intent: 'if',
  description: 'Execute actions conditionally based on a condition. Use template variables like ${id.output.field} in condition → Returns: result from executed branch',
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

    // Evaluate condition directly using agent's evaluateCondition method
    // This properly handles template variables and quotes strings correctly
    let conditionResult = false;
    try {
      conditionResult = agent.evaluateCondition(condition, context);
    } catch (error) {
      throw new Error(`Failed to evaluate condition "${condition}": ${error.message}`);
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
      cliLogger.progress(`[${agent.name}] ${intent}`);

      // Get action definition
      const actionDef = actionRegistry.get(nestedAction.intent || nestedAction.type);

      if (actionDef && actionDef.execute) {
        // Update agent's current context for nested action
        const previousContext = agent._currentActionContext;
        agent._currentActionContext = context;

        // Execute with agent
        result = await actionDef.execute(resolvedAction, agent);

        // Restore previous context
        agent._currentActionContext = previousContext;

        cliLogger.clear();

        // Update parent context with result
        if (result && typeof result === 'object') {
          const resultForContext = JSON.parse(JSON.stringify(result));
          context.results.push(resultForContext);

          // Store with action ID if provided
          if (nestedAction.id) {
            context[nestedAction.id] = { output: resultForContext };
          }
        }
      } else {
        cliLogger.clear();
        throw new Error(`Action ${nestedAction.intent || nestedAction.type} not found`);
      }
    }

    return {
      executed: conditionResult ? 'then' : 'else',
      result: result
    };
  }
};
