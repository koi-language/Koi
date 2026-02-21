/**
 * Write File Action - Write/edit files with diff preview and permission system.
 *
 * Permission model (same as shell):
 *   - Per DIRECTORY. If allowed for /foo, covers /foo/bar etc.
 *   - Always shows the diff preview (even if already allowed).
 *   - Per-agent, in-memory only (reset between sessions).
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { cliInput } from '../cli-input.js';
import { renderContentDiff, renderNewFileDiff } from '../diff-render.js';
import { getFilePermissions } from '../file-permissions.js';
import { sessionTracker } from '../session-tracker.js';

export default {
  type: 'write_file',
  intent: 'write_file',
  description: 'Write or edit a file. Shows a colored diff preview and asks for permission. Fields: "path" (file path), "content" (full new content). Returns: { success, path }',
  thinkingHint: 'Writing file',
  permission: 'execute',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Full file content to write' }
    },
    required: ['path', 'content']
  },

  async execute(action, agent) {
    const filePath = action.path;
    const newContent = action.content;

    if (!filePath) throw new Error('write_file: "path" field is required');
    if (newContent === undefined) throw new Error('write_file: "content" field is required');

    const resolvedPath = path.resolve(filePath);
    const exists = fs.existsSync(resolvedPath);
    const oldContent = exists ? fs.readFileSync(resolvedPath, 'utf8') : '';

    // Generate diff preview (single shared function)
    const diff = exists
      ? renderContentDiff(oldContent, newContent, filePath)
      : renderNewFileDiff(newContent, filePath);

    // No real changes (only trailing whitespace differences)
    if (exists && !diff) {
      cliLogger.print(`\x1b[2mNo changes\x1b[0m`);
      return { success: true, path: filePath, noChanges: true };
    }

    cliLogger.clearProgress();
    cliLogger.print(`\n${diff}\n`);

    // Check permissions (shared across all file actions)
    const permissions = getFilePermissions(agent);
    const dir = path.dirname(resolvedPath);
    let permitted = permissions.isAllowed(resolvedPath, 'write');

    if (!permitted) {
      const agentName = agent?.name || 'Agent';
      cliLogger.print(`🔧 ${agentName} wants to ${exists ? 'edit' : 'create'}: \x1b[33m${filePath}\x1b[0m\n`);

      const value = await cliSelect('Allow this file change?', [
        { title: 'Yes', value: 'yes', description: 'Apply this time' },
        { title: 'Always allow', value: 'always', description: 'Always allow file changes in this directory' },
        { title: 'No, but', value: 'feedback', description: 'Reject and give instructions to retry' },
        { title: 'No', value: 'no', description: 'Skip this change' }
      ]);

      if (value === 'always') {
        permissions.allow(dir, 'write');
        permitted = true;
      } else if (value === 'yes') {
        permitted = true;
      } else if (value === 'feedback') {
        const feedback = await cliInput('> ');
        cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
        return { success: false, denied: true, feedback, message: `User rejected the edit with feedback: ${feedback}` };
      }
    }

    if (!permitted) {
      cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
      return { success: false, denied: true, message: 'User denied file change' };
    }

    // Ensure directory exists
    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    if (sessionTracker) sessionTracker.trackFile(resolvedPath, oldContent);
    cliLogger.print(`\x1b[2mDone\x1b[0m`);

    return { success: true, path: filePath };
  }
};
