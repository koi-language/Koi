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

    // Evaluate condition
    let conditionResult = false;
    try {
      // The condition comes already interpolated from the LLM with template variables replaced
      // We just need to evaluate it as a JavaScript expression
      conditionResult = eval(condition);
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
