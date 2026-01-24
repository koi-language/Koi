/**
 * Print Action - Display text to console
 */

import { cliLogger } from '../cli-logger.js';

export default {
  type: 'print',          // Mantener temporalmente
  intent: 'print',        // NUEVO: identificador semántico
  description: 'Print directly to console (FAST - use this for all console output!)',
  permission: 'execute', // Requires execute permission

  schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Text to display on console'
      }
    },
    required: ['message']
  },

  examples: [
    { type: 'print', message: '╔══════════════════════════════════════╗' },
    { type: 'print', message: '║  Processing...                       ║' },
    { type: 'print', message: '╚══════════════════════════════════════╝' },
    { type: 'print', message: '✅ Task completed successfully' },
    { type: 'print', message: 'Found ${previousResult.count} items' }
  ],

  // Executor function - receives the action and agent context
  async execute(action, agent) {
    const message = action.message || action.text || action.data || '';

    // Print directly to stdout (bypassing cliLogger interception)
    cliLogger.clearProgress();
    process.stdout.write(message + '\n');

    return { printed: true, message };
  }
};
