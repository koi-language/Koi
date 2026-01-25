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

    // Execute actions using agent's executeActions method
    const result = await agent.executeActions(actionsToExecute);

    return {
      executed: conditionResult ? 'then' : 'else',
      result: result
    };
  }
};
