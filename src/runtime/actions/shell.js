/**
 * Shell Action - Execute a shell command with user permission.
 *
 * The LLM must provide a human-readable description of what the command does.
 * Before execution, the user is prompted for permission unless the command
 * has been "Always allow"-ed for this agent during the current session.
 *
 * Safe read-only commands (pwd, whoami, date, which, uname, hostname)
 * run silently without asking for permission or showing output chrome.
 *
 * Permission options:
 *   - Yes            → execute this time only
 *   - Always allow   → execute without asking again for this category + directory
 *   - No             → skip this time (can be asked again later)
 *
 * Permission grouping (shared with file actions read_file/write_file/edit_file):
 *   - READ commands (ls, cat, grep, …)  → shared with read_file / search per directory
 *   - WRITE commands (mkdir, rm, cp, …) → shared with write_file / edit_file per directory
 *   - Other commands (node, npm, …)     → individual permission per command + directory
 *
 * Permissions are per-agent and in-memory only (reset between sessions).
 */

import { spawn } from 'child_process';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { getFilePermissions } from '../file-permissions.js';

/**
 * Injectable callback — wired by ink-bootstrap.js to uiBridge.submitInput().
 * When a background process exits unexpectedly, we inject a system message
 * into the agent's input queue so it can react (retry, inform user, etc.).
 */
let _bgNotify = null;
export function setBackgroundNotifyCallback(fn) {
  _bgNotify = fn;
}

/**
 * Detect potentially dangerous command patterns and return a warning string,
 * or null if no concerns are found.
 */
function detectWarnings(command) {
  const warnings = [];
  if (/(?<![|>])<(?!\s*<)/.test(command))          warnings.push('Command contains input redirection (<) which could read sensitive files');
  if (/rm\s+(-\w*r\w*|-r\w*f\w*)\s/i.test(command)) warnings.push('Command contains recursive deletion (rm -r) which permanently removes files');
  if (/\bsudo\b/.test(command))                     warnings.push('Command runs with elevated (sudo) privileges');
  if (/\bcurl\b.*\|\s*(bash|sh)\b/.test(command) || /\bwget\b.*\|\s*(bash|sh)\b/.test(command))
                                                    warnings.push('Command pipes remote content directly into a shell');
  return warnings.length > 0 ? warnings.join('\n ') : null;
}

/**
 * Extract the base command from a shell command string.
 * E.g. "npm install foo" → "npm", "ls -la /tmp" → "ls"
 */
function extractBaseCommand(command) {
  const trimmed = command.trim();
  // Skip env vars at the start (e.g. FOO=bar npm install)
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (!part.includes('=')) return part.replace(/^.*\//, ''); // strip path
  }
  return parts[0] || '';
}

/**
 * Extract the target directory from a command (for per-directory permissions).
 */
function extractTargetDir(command, cwd) {
  return cwd || process.cwd();
}

/**
 * Command categories for permission grouping.
 *
 * READ  → permission covers ALL read commands in a directory
 * WRITE → permission covers ALL write/modify commands in a directory
 * other → individual permission per base command
 */
const READ_COMMANDS = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'bat',
  'find', 'grep', 'rg', 'ag', 'ack', 'fd',
  'wc', 'sort', 'uniq', 'tr', 'cut', 'diff', 'cmp', 'comm',
  'file', 'stat', 'du', 'df', 'ps', 'lsof', 'tree',
  'strings', 'xxd', 'od', 'hexdump',
]);

const WRITE_COMMANDS = new Set([
  'mkdir', 'rmdir', 'touch', 'rm', 'cp', 'mv', 'ln',
  'chmod', 'chown', 'chgrp', 'tee', 'rsync', 'install',
]);

/**
 * Return the permission category key for a base command:
 *   'READ'  – grouped with all read commands
 *   'WRITE' – grouped with all write/modify commands
 *   baseCmd – individual (execution commands like node, flutter, etc.)
 */
function permissionCategory(baseCmd) {
  if (READ_COMMANDS.has(baseCmd)) return 'READ';
  if (WRITE_COMMANDS.has(baseCmd)) return 'WRITE';
  return baseCmd;
}

/**
 * Global per-command permission tracker for non-READ/WRITE commands
 * (node, npm, flutter, etc.) — shared across all agents.
 */
class IndividualPermissions {
  constructor() {
    this._map = new Map();
  }
  isAllowed(baseCmd, dir) {
    return this._map.has(`${baseCmd}:${dir}`) || this._map.has(`${baseCmd}:*`);
  }
  allow(baseCmd, dir) {
    this._map.set(`${baseCmd}:${dir}`, true);
  }
}

const _globalIndividualPerms = new IndividualPermissions();

/**
 * Global serial queue for permission requests.
 * Parallel shell actions must not show overlapping permission menus — the last
 * uiBridge.select() call would overwrite the previous resolve, leaving earlier
 * promises permanently stuck and hanging the entire parallel batch.
 * Queuing ensures prompts appear one at a time regardless of parallelism.
 *
 * Additionally, each queue item waits for the previous command to finish
 * executing before showing its menu. This prevents command output (stderr,
 * "Failed" messages, clearProgress calls) from corrupting the next SelectMenu's
 * keyboard input focus in Ink.
 */
const _permQueue = [];
let _permQueueRunning = false;

async function _drainPermQueue() {
  if (_permQueueRunning) return;
  _permQueueRunning = true;
  let waitForPrev = Promise.resolve();
  while (_permQueue.length > 0) {
    const { command, baseCmd, description, agentName, resolve, checkPermitted } = _permQueue.shift();

    // If a prior grant in this queue run already covers this command, skip the prompt.
    if (checkPermitted && checkPermitted()) {
      resolve({ answer: 'yes', reportDone: () => {}, descriptionShown: false });
      continue;
    }

    // Wait for the previous command to finish executing before showing the next
    // permission prompt. Without this, command output (stderr, clearProgress)
    // fires while the SelectMenu is active, disrupting Ink's input handling.
    await waitForPrev;

    cliLogger.clearProgress();
    // Build the "Always allow" label based on the command's category
    const alwaysLabel = (() => {
      const cat = permissionCategory(baseCmd);
      if (cat === 'READ')  return 'Always allow read commands in this directory';
      if (cat === 'WRITE') return 'Always allow write commands in this directory';
      return `Always allow ${baseCmd} in this directory`;
    })();

    // Detect dangerous patterns for the warning message
    const warning = detectWarnings(command);

    // Pass command + warning as meta so the UI can render the Claude-style layout
    const value = await cliSelect(description, [
      { title: 'Yes', value: 'yes' },
      { title: alwaysLabel, value: 'always' },
      { title: 'No', value: 'no' }
    ], 0, { meta: { type: 'bash', command, warning } });

    // Create a done signal: execute() calls reportDone() when the command
    // finishes. The next queue iteration awaits this before showing its menu.
    let reportDone;
    waitForPrev = new Promise(r => { reportDone = r; });
    resolve({ answer: value || 'no', reportDone, descriptionShown: false });
  }
  _permQueueRunning = false;
}

async function askPermission(command, baseCmd, description, agentName, checkPermitted) {
  return new Promise((resolve) => {
    _permQueue.push({ command, baseCmd, description, agentName, resolve, checkPermitted });
    _drainPermQueue();
  });
}

export default {
  type: 'shell',
  intent: 'shell',
  description: 'Execute a shell command (requires user permission). Requires: command (the shell command), description (human-friendly explanation of what it does and why). Optional: cwd (working directory), background (boolean — launch without waiting, for apps/servers)',
  thinkingHint: (action) => `Executing ${extractBaseCommand(action.command || '')}`,
  permission: 'execute',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      description: { type: 'string', description: 'Human-friendly reason WHY this command is needed (shown to user). Express NEED, not action. Good: "Need to install X because Y". Bad: "Installing X".' },
      cwd: { type: 'string', description: 'Working directory for the command (optional)' },
      background: { type: 'boolean', description: 'If true, launch without waiting for completion. Use for commands that start long-running processes: apps, emulators, dev servers (e.g. flutter run, open -a Simulator, npm start).' }
    },
    required: ['command', 'description']
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'shell',
      command: 'npm install',
      description: 'Need to install Node.js dependencies required by the project',
      cwd: '/path/to/project'
    }
  ],

  async execute(action, agent) {
    const { command, description, cwd, background = false } = action;

    if (!command) {
      throw new Error('shell: "command" field is required');
    }
    if (!description) {
      throw new Error('shell: "description" field is required');
    }

    const _cmdFull = command.split('\n')[0];
    const cmdPreview = _cmdFull.length > 60 ? _cmdFull.substring(0, 60) + '...' : _cmdFull;

    // Reject commands with obvious placeholder values like <your_api_key>, <TOKEN>, etc.
    const placeholderMatch = command.match(/<[a-zA-Z_][a-zA-Z0-9_]*>/);
    if (placeholderMatch) {
      return {
        success: false,
        error: `Command contains a placeholder "${placeholderMatch[0]}" instead of a real value. Do NOT use placeholder values — use actual values or ask the user for them with prompt_user.`
      };
    }

    const baseCmd = extractBaseCommand(command);
    const effectiveDir = extractTargetDir(command, cwd);
    const cat = permissionCategory(baseCmd);

    // Safe read-only commands that run silently (no permission, no output chrome)
    const ALWAYS_ALLOWED = new Set(['pwd', 'whoami', 'date', 'which', 'uname', 'hostname']);
    const isSilent = ALWAYS_ALLOWED.has(baseCmd);

    // Check permission — READ/WRITE share the same FilePermissions instance as
    // read_file / write_file / edit_file, so a grant in one covers the other.
    const checkPermitted = () => {
      if (cat === 'READ')  return getFilePermissions(agent).isAllowed(effectiveDir, 'read');
      if (cat === 'WRITE') return getFilePermissions(agent).isAllowed(effectiveDir, 'write');
      return _globalIndividualPerms.isAllowed(baseCmd, effectiveDir);
    };

    let permitted = isSilent || checkPermitted();
    let reportDone;
    let descriptionShown = false;

    if (!permitted) {
      let answer;
      ({ answer, reportDone, descriptionShown } = await askPermission(command, baseCmd, description, agent?.name, checkPermitted));

      if (answer === 'always') {
        if (cat === 'READ')       getFilePermissions(agent).allow(effectiveDir, 'read');
        else if (cat === 'WRITE') getFilePermissions(agent).allow(effectiveDir, 'write');
        else                      _globalIndividualPerms.allow(baseCmd, effectiveDir);
        permitted = true;
      } else if (answer === 'yes') {
        permitted = true;
      }
    }

    if (!permitted) {
      reportDone?.();
      cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
      return {
        success: false,
        denied: true,
        message: `User denied execution: ${description}`
      };
    }

    // Background launch: spawn detached, don't wait for completion.
    if (background) {
      const bgChild = spawn('sh', ['-c', command], {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe'],  // pipe stderr to catch startup errors
        detached: true
      });

      // Collect stderr for error reporting (capped at 4KB)
      const bgStderr = [];
      let bgStderrBytes = 0;
      bgChild.stderr.on('data', (chunk) => {
        if (bgStderrBytes < 4096) {
          bgStderr.push(chunk);
          bgStderrBytes += chunk.length;
        }
      });

      // Notify when the background process exits
      bgChild.on('close', (code) => {
        const stderrStr = Buffer.concat(bgStderr).toString().trim();
        cliLogger.log('background', `PID ${bgChild.pid} exited code=${code ?? 'signal'} cmd="${cmdPreview}"`);
        if (code === null) return; // killed by signal (intentional Ctrl+C etc.) — ignore

        // Clear the "background · PID" from the progress bar
        cliLogger.clearProgress();

        if (code !== 0) {
          // Crashed: show error + stderr indented below
          if (stderrStr) {
            cliLogger.printCompact(`\x1b[31m↗  ${cmdPreview} (crashed · code ${code})\x1b[0m`);
            const dimmedStderr = stderrStr
              .split('\n')
              .map(line => `\x1b[2m   ${line}\x1b[0m`)
              .join('\n');
            cliLogger.print(dimmedStderr);
          } else {
            cliLogger.print(`\x1b[31m↗  ${cmdPreview} (crashed · code ${code})\x1b[0m`);
          }
          _bgNotify?.(`[System notification] Background process crashed: "${cmdPreview}" exited with code ${code}.${stderrStr ? ` Error output:\n${stderrStr}` : ''} Please handle this.`);
        } else {
          // Finished cleanly — replaces the progress bar PID line with a ✓ in scroll
          cliLogger.print(`\x1b[2m✓  ${cmdPreview} (finished)\x1b[0m`);
        }
      });

      bgChild.unref();
      reportDone?.();
      if (!isSilent) {
        cliLogger.printCompact(description);
        // Show PID in progress bar (replaceable) instead of scroll (permanent)
        cliLogger.progress(`\x1b[2m↗  ${cmdPreview} (background · PID ${bgChild.pid})\x1b[0m`);
      }
      return { success: true, background: true, pid: bgChild.pid };
    }

    // Capture abort signal NOW (before any await) so we have a reference
    // even after uiBridge nulls the controller on Ctrl+C.
    const abortSignal = agent?.constructor?._cliHooks?.getAbortSignal?.() ?? null;

    return new Promise((resolve) => {
      const startTime = Date.now();
      let timerInterval = null;

      if (!isSilent) {
        if (!descriptionShown) {
          cliLogger.printCompact(description);
          descriptionShown = true;
        }
        cliLogger.progress(`\x1b[2m→  ${cmdPreview} (running for 0s)\x1b[0m`);
        timerInterval = setInterval(() => {
          const secs = Math.floor((Date.now() - startTime) / 1000);
          cliLogger.progress(`\x1b[2m→  ${cmdPreview} (running for ${secs}s)\x1b[0m`);
        }, 1000);
      }

      const child = spawn('sh', ['-c', command], {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Kill child immediately when user presses Ctrl+C.
      // We captured the signal reference before any await, so it stays valid
      // even after uiBridge nulls _abortController.
      const onAbort = () => child.kill('SIGTERM');
      if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

      const stdoutChunks = [];
      const stderrChunks = [];

      child.stdout.on('data', (data) => {
        stdoutChunks.push(data);
      });

      child.stderr.on('data', (data) => {
        stderrChunks.push(data);
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
      }, 300000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timerInterval) clearInterval(timerInterval);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        if (!isSilent) {
          cliLogger.clearProgress();
        }

        const stdoutStr = Buffer.concat(stdoutChunks).toString().trim();
        const stderrStr = Buffer.concat(stderrChunks).toString().trim();

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (code !== 0) {
          if (!isSilent) {
            if (!descriptionShown) cliLogger.printCompact(`${description}`);
            if (stderrStr) {
              cliLogger.printCompact(`\x1b[31m✗  ${cmdPreview} (${elapsed}s)\x1b[0m`);
              // Apply dim+indent to each line individually — Ink resets ANSI state
              // at newline boundaries within a single Text element, so wrapping the
              // whole block in \x1b[2m...\x1b[0m only dims the first line.
              const dimmedStderr = stderrStr
                .split('\n')
                .map(line => `\x1b[2m   ${line}\x1b[0m`)
                .join('\n');
              cliLogger.print(dimmedStderr);
            } else {
              cliLogger.print(`\x1b[31m✗  ${cmdPreview} (${elapsed}s)\x1b[0m`);
            }
          }
          // Signal done AFTER printing output so the next queued menu appears
          // only after this command's output is fully displayed.
          reportDone?.();
          resolve({
            success: false,
            exitCode: code || 1,
            stdout: stdoutStr,
            stderr: stderrStr,
            error: stderrStr || `Command exited with code ${code}`
          });
        } else {
          if (!isSilent) {
            if (!descriptionShown) cliLogger.printCompact(`${description}`);
            cliLogger.print(`\x1b[2m✓  ${cmdPreview} (${elapsed}s)\x1b[0m`);
          }
          reportDone?.();
          resolve({
            success: true,
            exitCode: 0,
            stdout: stdoutStr,
            stderr: stderrStr
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (timerInterval) clearInterval(timerInterval);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        if (!isSilent) {
          cliLogger.clearProgress();
        }
        reportDone?.();
        resolve({
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: '',
          error: err.message
        });
      });
    });
  }
};
