/**
 * Prompt User Action - Ask user for input via command line
 */

import readline from 'readline';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'prompt_user',
  intent: 'prompt_user',
  description: 'Ask the user a question via command line and get their text response',
  permission: 'execute', // Requires execute permission

  schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user'
      },
      prompt: {
        type: 'string',
        description: 'Optional custom prompt (defaults to "> ")'
      }
    },
    required: ['question']
  },

  examples: [
    { id: 'a1', intent: 'prompt_user', question: 'What is your age?' },
    { id: 'a2', intent: 'prompt_user', question: 'Enter the file path:', prompt: 'Path: ' },
    { id: 'a3', intent: 'prompt_user', question: 'Do you want to continue?', prompt: '(y/n) ' }
  ],

  // Executor function - receives the action and agent context
  async execute(action, agent) {
    const question = action.question || action.data?.question || '';
    const promptText = action.prompt || action.data?.prompt || '> ';

    if (!question) {
      throw new Error('prompt_user action requires a "question" field');
    }

    // Clear any progress indicators
    cliLogger.clearProgress();

    // Create readline interface
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // Ask the question and wait for user input
    const answer = await new Promise((resolve) => {
      // Print the question
      process.stdout.write(`\n${question}\n`);

      // Show prompt and wait for input
      rl.question(promptText, (userInput) => {
        rl.close();
        resolve(userInput.trim());
      });
    });

    // Return the user's answer
    return { answer };
  }
};
