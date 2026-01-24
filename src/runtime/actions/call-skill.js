/**
 * Call Skill Action - Invoke a skill
 */

export default {
  type: 'call_skill',          // Mantener temporalmente
  intent: 'call_skill',        // NUEVO: identificador semántico
  description: 'Call a skill with parameters',
  permission: 'execute', // Requires execute permission
  hidden: true, // Don't show in LLM prompts - skills are handled via tool calling

  schema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'Name of the skill to call'
      },
      input: {
        type: 'object',
        description: 'Input parameters for the skill'
      }
    },
    required: ['skill']
  },

  examples: [
    { type: 'call_skill', skill: 'DataValidator', input: { data: 'user_input' } }
  ],

  // Executor function
  async execute(action, agent) {
    const skillName = action.skill || action.name;
    const input = action.input || action.data || {};

    if (!agent.skills.includes(skillName)) {
      throw new Error(`Agent ${agent.name} does not have skill: ${skillName}`);
    }

    // Call the skill
    const result = await agent.callSkill(skillName, input);

    return result;
  }
};
