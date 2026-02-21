/**
 * Edit File Action - Apply a unified diff to a file.
 *
 * The LLM sends a unified diff (like git diff), the action:
 *   1. Parses the diff hunks
 *   2. Displays a colored preview (red bg = removed, green bg = added)
 *   3. Asks for permission
 *   4. Applies the changes
 *
 * Permission model: shared with write-file (per directory).
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { cliInput } from '../cli-input.js';
import { parseUnifiedDiff, renderColoredDiff } from '../diff-render.js';
import { getFilePermissions } from '../file-permissions.js';
import { sessionTracker } from '../session-tracker.js';

/**
 * Apply parsed hunks to file content.
 * Returns the new content or throws on mismatch.
 */
function applyHunks(content, hunks) {
  const lines = content.split('\n');
  // Sort hunks by oldStart descending so we apply from bottom to top
  // (this way line numbers don't shift as we apply earlier hunks)
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const startIdx = hunk.oldStart - 1; // 0-based

    // Collect old lines (context + remove) and new lines (context + add)
    const oldLines = [];
    const newLines = [];
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        oldLines.push(line.text);
        newLines.push(line.text);
      } else if (line.type === 'remove') {
        oldLines.push(line.text);
      } else if (line.type === 'add') {
        newLines.push(line.text);
      }
    }

    // Verify context matches (fuzzy: try exact position first, then search nearby/entire file)
    let matchIdx = findHunkPosition(lines, oldLines, startIdx, hunk.fuzzy);
    if (matchIdx === -1) {
      throw new Error(`Hunk at line ${hunk.oldStart} does not match file content. Context lines don't match.`);
    }

    // Update hunk's oldStart with actual matched position (for correct line numbers in rendering)
    hunk.oldStart = matchIdx + 1; // 1-based
    hunk.newStart = matchIdx + 1;

    // Replace old lines with new lines
    lines.splice(matchIdx, oldLines.length, ...newLines);
  }

  return lines.join('\n');
}

/**
 * Find where a hunk's old lines match in the file.
 * Tries exact position first, then searches nearby (±20 lines).
 */
function findHunkPosition(fileLines, oldLines, expectedIdx, fuzzy = false) {
  // Try exact position first
  if (linesMatch(fileLines, oldLines, expectedIdx)) {
    return expectedIdx;
  }

  // Search range: nearby for positioned hunks, entire file for fuzzy
  const searchRange = fuzzy ? fileLines.length : 20;
  for (let offset = 1; offset <= searchRange; offset++) {
    if (expectedIdx - offset >= 0 && linesMatch(fileLines, oldLines, expectedIdx - offset)) {
      return expectedIdx - offset;
    }
    if (expectedIdx + offset < fileLines.length && linesMatch(fileLines, oldLines, expectedIdx + offset)) {
      return expectedIdx + offset;
    }
  }

  return -1;
}

/**
 * Check if oldLines match fileLines starting at idx.
 */
function linesMatch(fileLines, oldLines, idx) {
  if (idx + oldLines.length > fileLines.length) return false;
  for (let i = 0; i < oldLines.length; i++) {
    if (fileLines[idx + i] !== oldLines[i]) return false;
  }
  return true;
}

export default {
  type: 'edit_file',
  intent: 'edit_file',
  description: 'Edit a file using a unified diff. Provide "path" and "diff" (unified diff format with @@ hunks). Shows colored preview and asks permission. The diff format is the standard unified diff: lines starting with - are removed, + are added, space are context. Example diff: "@@ -10,3 +10,4 @@\\n context line\\n-old line\\n+new line\\n+added line\\n context". Returns: { success, path }',
  thinkingHint: (action) => `Editing ${action.path || 'file'}`,
  permission: 'execute',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      diff: { type: 'string', description: 'Unified diff with @@ hunks. Lines: " " context, "-" remove, "+" add.' }
    },
    required: ['path', 'diff']
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'edit_file',
      path: 'src/cli.js',
      diff: "@@ -15,3 +15,4 @@\n const COMMANDS = {\n   run: 'Compile and run',\n+  execute: 'Alias for run',\n   compile: 'Compile only',"
    }
  ],

  async execute(action, agent) {
    const filePath = action.path;
    const diffStr = action.diff;

    if (!filePath) throw new Error('edit_file: "path" field is required');
    if (!diffStr) throw new Error('edit_file: "diff" field is required');

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');

    // Parse the diff
    const hunks = parseUnifiedDiff(diffStr);
    if (hunks.length === 0) {
      return {
        success: false,
        error: 'Could not parse diff — no @@ hunk headers found.',
        fix: 'Rewrite the diff field using this EXACT format:\n'
          + '"diff": "@@\\n context line (unchanged)\\n-line to remove\\n+line to add\\n context line"'
          + '\n\nRULES:\n'
          + '- Start with @@ on its own line\n'
          + '- Context lines (unchanged) start with a SPACE character\n'
          + '- Lines to DELETE start with -\n'
          + '- Lines to ADD start with +\n'
          + '- Include 1-2 unchanged context lines before and after changes so the match is unique\n'
          + '- Do NOT use shell/sed. Retry edit_file with the corrected diff.'
      };
    }

    // Try applying the diff
    let newContent;
    try {
      newContent = applyHunks(content, hunks);
    } catch (err) {
      // Show surrounding file content to help the LLM write correct context lines
      const lines = content.split('\n');
      const hunk = hunks[0];
      const around = Math.max(0, hunk.oldStart - 5);
      const snippet = lines.slice(around, around + 20).map((l, i) => `${around + i + 1}: ${l}`).join('\n');

      return {
        success: false,
        error: err.message,
        fix: 'The context lines in your diff do not match the actual file. '
          + 'Here is what the file looks like around that area:\n'
          + snippet + '\n\n'
          + 'Rewrite the diff with context lines that EXACTLY match the file content above. '
          + 'If you are unsure of the file content, use read_file first to see the exact lines. '
          + 'Do NOT use shell/sed. Retry edit_file.'
      };
    }

    // Render colored diff preview
    const coloredOutput = renderColoredDiff(hunks, filePath);

    cliLogger.clearProgress();
    cliLogger.print(`\n${coloredOutput}\n`);

    // Check permissions (shared across all file actions)
    const permissions = getFilePermissions(agent);
    const dir = path.dirname(resolvedPath);
    let permitted = permissions.isAllowed(resolvedPath, 'write');

    if (!permitted) {
      const agentName = agent?.name || 'Agent';
      cliLogger.print(`🔧 ${agentName} wants to edit: \x1b[33m${filePath}\x1b[0m\n`);

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

    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    if (sessionTracker) sessionTracker.trackFile(resolvedPath, content);
    cliLogger.print(`\x1b[2mDone\x1b[0m`);

    return { success: true, path: filePath };
  }
};
