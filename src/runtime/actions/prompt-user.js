/**
 * Prompt User Action - Ask user for input via command line
 */

import readline from 'readline';
import prompts from 'prompts';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'prompt_user',
  intent: 'prompt_user',
  description: 'Ask the user a question via command line. Can include "options" array for interactive menu when user must choose from a limited set (e.g., ["Sí", "No"], ["Opción A", "Opción B", "Opción C"]) - useful for Yes/No, multiple choice, etc. CRITICAL: "question" field ONLY accepts 100% static text OR ${variable} reference to call_llm result. If question needs generation/adaptation (keywords: random, relacionado, based on, adapted), you MUST use call_llm FIRST to generate it, then use ${result} here → Returns: { answer }. Access with ${id.output.answer}',
  permission: 'execute', // Requires execute permission

  schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user'
      },
      options: {
        type: 'array',
        description: 'Optional array of choices for interactive menu (e.g., ["Yes", "No"]). User navigates with arrows and selects with Enter.'
      },
      prompt: {
        type: 'string',
        description: 'Optional custom prompt for text input mode (defaults to "> ")'
      }
    },
    required: ['question']
  },

  examples: [
    { id: 'a1', intent: 'prompt_user', question: 'What is your name?' },
    { intent: 'print', message: 'Hello ${a1.output.answer}!' },
    { id: 'a2', intent: 'prompt_user', question: 'Do you want to proceed?', options: ['Yes', 'No'] },
    { intent: 'print', message: 'You selected: ${a2.output.answer}' }
  ],

  // Executor function - receives the action and agent context
  async execute(action, agent) {
    const question = action.question || action.data?.question || '';
    const options = action.options || action.data?.options || null;
    const promptText = action.prompt || action.data?.prompt || '> ';

    if (!question) {
      throw new Error('prompt_user action requires a "question" field');
    }

    // Clear any progress indicators
    cliLogger.clearProgress();

    // If options are provided, show interactive menu
    if (options && Array.isArray(options) && options.length > 0) {
      const response = await prompts({
        type: 'select',
        name: 'value',
        message: question,
        choices: options.map((opt, idx) => ({
          title: opt,
          value: opt
        })),
        initial: 0
      });

      // Return the selected option
      return { answer: response.value || options[0] };
    }

    // Otherwise, use text input mode
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
