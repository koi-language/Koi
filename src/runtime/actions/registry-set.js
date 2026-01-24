/**
 * Registry Set Action - Save data to registry
 */

export default {
  type: 'registry_set',          // Mantener temporalmente
  intent: 'registry_set',        // NUEVO: identificador semántico
  description: 'Save data to the shared registry',
  permission: 'registry:write', // Requires registry:write permission (or registry)

  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Registry key (e.g., "user:123")'
      },
      value: {
        type: 'object',
        description: 'Data to store'
      }
    },
    required: ['key', 'value']
  },

  examples: [
    {
      type: 'registry_set',
      key: 'user:${args.id}',
      value: {
        name: '${args.name}',
        age: '${args.age}',
        createdAt: '${Date.now()}'
      }
    }
  ],

  // Executor function
  async execute(action, agent) {
    const key = action.key;
    const value = action.value;

    if (!key) {
      throw new Error('registry_set action requires "key" field');
    }

    await globalThis.registry.set(key, value);
    return { success: true, key, saved: true };
  }
};
