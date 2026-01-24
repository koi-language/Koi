/**
 * Action Registry - Manages available actions for the LLM planner
 *
 * Actions are modules that define what the LLM can do in playbooks.
 * Each action has a type, description, schema, and examples.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ActionRegistry {
  constructor() {
    this.actions = new Map(); // Map<type, actionDefinition>
    this.actionsByIntent = new Map(); // NUEVO: Map<intent, actionDefinition>
  }

  /**
   * Register an action
   */
  register(action) {
    if (!action.type || !action.description) {
      throw new Error('Action must have type and description');
    }
    this.actions.set(action.type, action);

    // NUEVO: indexar también por intent
    if (action.intent) {
      this.actionsByIntent.set(action.intent, action);
    }
  }

  /**
   * Get an action by type or intent
   */
  get(typeOrIntent) {
    // Intentar por intent primero (nuevo)
    const byIntent = this.actionsByIntent.get(typeOrIntent);
    if (byIntent) return byIntent;

    // Fallback a type (legacy)
    return this.actions.get(typeOrIntent);
  }

  /**
   * Get all registered actions
   */
  getAll() {
    return Array.from(this.actions.values());
  }

  /**
   * Load all actions from a directory
   */
  async loadFromDirectory(dirPath) {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      if (file.endsWith('.js')) {
        const filePath = path.join(dirPath, file);
        try {
          const module = await import(`file://${filePath}`);
          const action = module.default;

          if (action && action.type) {
            this.register(action);
          }
        } catch (error) {
          console.warn(`[ActionRegistry] Failed to load action from ${file}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Generate LLM prompt documentation for actions
   * @param {Agent} agent - Agent to filter actions by permissions (null = show all actions)
   */
  generatePromptDocumentation(agent = null) {
    let actions = this.getAll();

    // If agent is provided, filter by permissions
    // If no agent, show all actions (for system-level operations like routing)
    if (agent) {
      actions = actions.filter(action => {
        // Skip hidden actions (like call_skill which is handled via tool calling)
        if (action.hidden) {
          return false;
        }

        // If action has no permission requirement, it's always available
        if (!action.permission) {
          return true;
        }

        // Check if agent has the required permission
        return agent.hasPermission(action.permission);
      });
    } else {
      // Even without agent, filter out hidden actions
      actions = actions.filter(action => !action.hidden);
    }

    if (actions.length === 0) {
      return '';
    }

    let doc = '';

    actions.forEach((action, index) => {
      doc += `- { "actionType": "direct", "intent": "${action.intent || action.type}"`;

      // Add required parameters
      if (action.schema && action.schema.properties) {
        const props = Object.keys(action.schema.properties);
        if (props.length > 0) {
          doc += `, ${props.map(p => `"${p}": ...`).join(', ')}`;
        }
      }

      doc += ` } - ${action.description}\n`;
    });

    return doc;
  }

  /**
   * Generate detailed examples for LLM prompt
   */
  generateExamples() {
    const actions = this.getAll();
    const actionsWithExamples = actions.filter(a => a.examples && a.examples.length > 0);

    if (actionsWithExamples.length === 0) {
      return '';
    }

    let examples = '\nAction Examples:\n';

    actionsWithExamples.forEach(action => {
      if (action.examples && action.examples.length > 0) {
        examples += `\n${action.type}:\n`;
        action.examples.forEach(example => {
          examples += `  ${JSON.stringify(example)}\n`;
        });
      }
    });

    return examples;
  }

  /**
   * Clear all registered actions
   */
  clear() {
    this.actions.clear();
  }
}

// Global singleton instance
export const actionRegistry = new ActionRegistry();

// Auto-load actions from the actions directory on module load (SYNCHRONOUSLY)
const actionsDir = path.join(__dirname, 'actions');
if (fs.existsSync(actionsDir)) {
  await actionRegistry.loadFromDirectory(actionsDir).catch(err => {
    console.warn('[ActionRegistry] Failed to auto-load actions:', err.message);
  });
}
