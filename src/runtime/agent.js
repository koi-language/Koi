import { LLMProvider } from './llm-provider.js';
import { cliLogger } from './cli-logger.js';
import { actionRegistry } from './action-registry.js';
import { PlaybookSession } from './playbook-session.js';
import { buildActionDisplay } from './cli-display.js';
import { initSessionTracker, sessionTracker } from './session-tracker.js';
import { ContextMemory } from './context-memory.js';

// Global call stack to detect infinite loops across all agents
const globalCallStack = [];


/**
 * Use LLM to infer action metadata from playbook
 * @param {string} playbook - The playbook text
 * @returns {Promise<{description: string, inputParams: string, returnType: string}>}
 */
async function inferActionMetadata(playbook) {
  try {
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[InferActionMetadata] Analyzing playbook...');
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        description: 'Execute action',
        inputParams: '{ ... }',
        returnType: '{ "result": "any" }'
      };
    }

    // Call OpenAI API directly
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Extract action metadata from agent playbooks. Focus on UNIQUE, SPECIFIC characteristics that distinguish this action from others. Return ONLY valid JSON.'
          },
          {
            role: 'user',
            content: `Analyze this playbook and identify what makes it UNIQUE:\n\n${playbook}\n\nExtract:\n1. description: What makes THIS action unique and specific (15-20 words). Focus on:\n   - The specific role/persona (e.g., "left-wing activist", "philosopher", "poet")\n   - The unique perspective or style it brings\n   - What differentiates it from similar actions\n   Example: "Generates radical left-wing political response from activist perspective" NOT "Generates response"\n\n2. inputParams: Input parameters structure (look for \${args.X} references)\n   Example: { "context": "string", "conversation": "string" }\n\n3. returnType: Output structure (look for "Return:" or return statements)\n   Example: { "answer": "string" }\n\nRespond with JSON:\n{ "description": "...", "inputParams": "{ ... }", "returnType": "{ ... }" }\n\nNO markdown, NO explanations, ONLY JSON.`
          }
        ]
      })
    });

    const data = await response.json();
    let result = data.choices[0].message.content.trim();

    // Clean up response (remove markdown if present)
    if (result.startsWith('```')) {
      result = result.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    const parsed = JSON.parse(result);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[InferActionMetadata] Result:`, parsed);
    }

    return {
      description: parsed.description || 'Execute action',
      inputParams: parsed.inputParams || '{ ... }',
      returnType: parsed.returnType || '{ "result": "any" }'
    };
  } catch (error) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[InferActionMetadata] Error: ${error.message}`);
    }
    // If inference fails, use defaults
    return {
      description: 'Execute action',
      inputParams: '{ ... }',
      returnType: '{ "result": "any" }'
    };
  }
}

export class Agent {
  /**
   * CLI hooks — injectable callbacks for UI integration.
   * Set by the CLI bootstrap layer (e.g. ink-bootstrap.js).
   * The runtime has no knowledge of the specific UI implementation.
   *
   * Interface: {
   *   onBusy(busy: boolean),      // Agent busy state changed
   *   getAbortSignal() → signal,  // Get AbortSignal for cancellation
   *   onInfo(text: string),       // Token/info line update (unused — use cliLogger.setInfo)
   *   onSlashCommands(cmds),      // Register slash commands for completion
   * }
   */
  static _cliHooks = null;
  static _cliBootstrapped = false;
  static _indexingStarted = false;

  /** Set CLI hooks from the bootstrap layer. */
  static setCliHooks(hooks) {
    Agent._cliHooks = hooks;
  }

  constructor(config) {
    this.name = config.name;
    this.description = config.description || null;
    this.role = config.role;
    this.skills = config.skills || [];
    this.usesTeams = config.usesTeams || []; // Teams this agent uses as a client
    this.usesMCPNames = config.usesMCP || []; // MCP server names this agent uses
    this.llm = config.llm || { provider: 'openai', model: 'gpt-4', temperature: 0.2 };
    this.state = config.state || {};
    this.playbooks = config.playbooks || {};
    this.resilience = config.resilience || null;
    this.amnesia = config.amnesia || false;
    this.contextMemoryState = null; // Serialized ContextMemory state across playbook executions

    // Never allow peers to be null - use a proxy that throws helpful error
    if (config.peers) {
      this.peers = config.peers;
    } else {
      this.peers = this._createNoTeamProxy();
    }

    this.handlers = config.handlers || {};

    // Initialize LLM provider if needed
    this.llmProvider = null;
  }

  /**
   * Create a proxy that throws a helpful error when trying to use peers without a team
   */
  _createNoTeamProxy() {
    // Return an object that mimics a Team but throws when execute() is called
    let eventName = 'unknown';
    const noTeamQuery = {
      __isNoTeamProxy: true, // Marker for Team constructor to detect and replace
      event: (name) => {
        eventName = name;
        return noTeamQuery;
      },
      role: () => noTeamQuery,
      any: () => noTeamQuery,
      all: () => noTeamQuery,
      execute: () => {
        throw new Error(`NO_AGENT_HANDLER:${eventName}::no-team`);
      }
    };
    return noTeamQuery;
  }

  /**
   * Get a specific team by reference (for peers(TeamName) syntax)
   * @param {Team} teamRef - Team instance or constructor
   * @returns {Team} The team instance
   */
  _getTeam(teamRef) {
    // If teamRef is already a Team instance, check if we have access to it
    if (teamRef && typeof teamRef === 'object') {
      // Check if it's the same instance as peers
      if (this.peers === teamRef) {
        return this.peers;
      }

      // Search in usesTeams array for the exact same instance
      if (Array.isArray(this.usesTeams)) {
        const team = this.usesTeams.find(t => t === teamRef);
        if (team) {
          return team;
        }
      }

      // Team not found - throw helpful error
      const teamName = teamRef.name || teamRef.constructor?.name || 'Unknown';
      throw new Error(
        `Agent ${this.name} does not have access to team ${teamName}.\n` +
        `Available teams: ${this.usesTeams.map(t => t?.name || t?.constructor?.name || 'Unknown').join(', ') || 'none'}\n` +
        `Hint: Add "uses Team ${teamName}" to the agent definition.`
      );
    }

    // If teamRef is a constructor/class, search by constructor
    if (typeof teamRef === 'function') {
      if (this.peers && this.peers.constructor === teamRef) {
        return this.peers;
      }

      if (Array.isArray(this.usesTeams)) {
        const team = this.usesTeams.find(t => t && t.constructor === teamRef);
        if (team) {
          return team;
        }
      }
    }

    throw new Error(
      `Agent ${this.name} could not find team.\n` +
      `Available teams: ${this.usesTeams.map(t => t?.name || t?.constructor?.name || 'Unknown').join(', ') || 'none'}`
    );
  }

  /**
   * Check if the agent has a specific permission
   * Supports hierarchical permissions: if role has "registry", it can execute "registry:read", "registry:write", etc.
   * @param {string} permissionName - Permission to check (e.g., 'execute', 'delegate', 'registry:read')
   * @returns {boolean} True if agent has the permission
   */
  hasPermission(permissionName) {
    if (!this.role) {
      return false;
    }

    // Check exact permission match first
    if (this.role.can(permissionName)) {
      return true;
    }

    // Check hierarchical permissions (e.g., "registry" covers "registry:read")
    if (permissionName.includes(':')) {
      const [prefix] = permissionName.split(':');
      if (this.role.can(prefix)) {
        return true;
      }
    }

    return false;
  }

  async handle(eventName, args, _fromDelegation = false) {
    // Bootstrap CLI layer (e.g. Ink) early — before any stdout writes.
    // When KOI_CLI_MODE is set, dynamically import the bootstrap module
    // which sets up providers on cliLogger, cliInput, cliSelect, and Agent.
    // The runtime never imports UI modules directly — only the bootstrap does.
    // The bootstrap module path is injected via KOI_CLI_BOOTSTRAP_PATH env var,
    // set by the CLI tool (e.g. koi-cli) before spawning the runtime process.
    if (process.env.KOI_CLI_MODE === '1' && !Agent._cliBootstrapped) {
      Agent._cliBootstrapped = true;
      const bootstrapPath = process.env.KOI_CLI_BOOTSTRAP_PATH;
      if (bootstrapPath) {
        const { bootstrapInk } = await import(bootstrapPath);
        await bootstrapInk();
        // After bootstrap, _cliHooks is set — register slash commands from command-registry
        if (Agent._cliHooks?.onSlashCommands) {
          const registryPath = process.env.KOI_CLI_COMMAND_REGISTRY_PATH;
          if (registryPath) {
            const { getCommandList } = await import(registryPath);
            const cmds = await getCommandList();
            Agent._cliHooks.onSlashCommands(cmds);
          }
        }
      }
      // Prompt for any missing API keys (OpenAI, Anthropic, Gemini)
      const { promptMissingApiKeys } = await import('./api-key-manager.js');
      await promptMissingApiKeys();
    }

    // Fire-and-forget: start project indexing in background (once per process)
    if (process.env.KOI_CLI_MODE === '1' && !Agent._indexingStarted) {
      Agent._indexingStarted = true;
      this._startBackgroundIndexing();
    }

    if (!_fromDelegation) {
      cliLogger.progress(`[🤖 ${this.name}] ${eventName}...`);
    }

    const handler = this.handlers[eventName];
    if (!handler) {
      cliLogger.clear();
      cliLogger.error(`[🤖 ${this.name}] No handler for event: ${eventName}`);
      throw new Error(`Agent ${this.name} has no handler for event: ${eventName}`);
    }

    try {
      // Check if handler is playbook-only (has __playbookOnly__ flag)
      if (handler.__playbookOnly__) {
        const playbookText = handler.__playbookFn__
          ? await handler.__playbookFn__(args, this.state, this)
          : handler.__playbook__;
        const result = await this.executePlaybookHandler(eventName, playbookText, args, _fromDelegation, handler.__playbookFn__ || null);
        cliLogger.clear();
        return result;
      }

      // Execute handler with agent context
      const result = await handler.call(this, args);
      cliLogger.clear();
      return result;
    } catch (error) {
      cliLogger.clear();
      // Don't log NO_AGENT_HANDLER errors - they'll be handled in runtime.js
      if (!error.message || !error.message.startsWith('NO_AGENT_HANDLER:')) {
        cliLogger.error(`[${this.name}] Error in ${eventName}: ${error.message}`);

        // Apply resilience if configured
        if (this.resilience?.retry_max_attempts) {
          console.log(`[Agent:${this.name}] Applying resilience policy...`);
          // TODO: Implement retry logic
        }
      }

      throw error;
    }
  }

  async executePlaybookHandler(eventName, playbook, args, _fromDelegation = false, playbookFn = null) {
    // Initialize LLM provider if not already done
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    // Prepare context with args and state
    const context = {
      args,
      state: this.state
    };

    // Get available skill functions for tool calling
    const tools = this.getSkillFunctions();

    // Extract playbook content if it's an object (transpiler stores it as {type, content})
    const playbookContent = typeof playbook === 'object' && playbook.content
      ? playbook.content
      : playbook;

    // Evaluate template string with context (interpolate ${...} expressions)
    // Create a function that evaluates the template in the context of args and state
    // Wraps args/state in Proxy so undefined properties resolve to "" instead of "undefined"
    const evaluateTemplate = (template, context) => {
      try {
        // Safe string substitution: only replace ${args.path} and ${state.path} patterns.
        // This avoids new Function / eval entirely, so code examples in playbooks
        // (e.g. JS template literals like `User ${route.params.userId}`) are never executed.
        const resolve = (ns, path) => {
          const root = ns === 'args' ? (context.args || {}) : (context.state || {});
          if (!path) return typeof root === 'object' ? JSON.stringify(root) : String(root);
          const parts = path.split('.');
          let val = root;
          for (const part of parts) {
            if (val == null) return '';
            val = val[part];
          }
          return val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
        };
        return template.replace(/\$\{(args|state)(?:\.([^}]*))?\}/g, (_, ns, path) => resolve(ns, path || ''));
      } catch (error) {
        console.warn(`[Agent:${this.name}] Failed to evaluate playbook template: ${error.message}`);
        return template; // Return original if evaluation fails
      }
    };

    const interpolatedPlaybook = evaluateTemplate(playbookContent, context);

    // Use skillSelector for semantic skill selection instead of passing all skills
    // This improves accuracy by only passing relevant tools to the LLM
    let selectedTools = tools;
    if (typeof globalThis.skillSelector !== 'undefined' && interpolatedPlaybook) {
      try {
        selectedTools = await globalThis.skillSelector.selectSkillsForTask(interpolatedPlaybook, 2);
      } catch (error) {
        console.warn(`[Agent:${this.name}] Skill selection failed, using all skills: ${error.message}`);
        selectedTools = tools; // Fallback to all skills
      }
    }

    // Agent memory: pass previous context memory state unless amnesia is enabled
    const memoryState = this.amnesia ? null : this.contextMemoryState;
    if (process.env.KOI_DEBUG_LLM) {
      const entryCount = memoryState?.entries?.length || 0;
      const latentCount = memoryState?.latentPool?.length || 0;
      console.error(`[Agent:${this.name}] 🧠 Memory check: amnesia=${this.amnesia}, entries=${entryCount}, latent=${latentCount}`);
    }

    // If a compose-based playbookFn is provided, create a resolver that re-evaluates
    // it on each user turn (so compose blocks pick up runtime state changes).
    const playbookResolver = playbookFn
      ? async () => {
          try {
            const rawText = await playbookFn(args, this.state, this);
            const content = typeof rawText === 'object' && rawText.content ? rawText.content : rawText;
            return evaluateTemplate(content, { args, state: this.state });
          } catch {
            return interpolatedPlaybook; // fallback to initial on error
          }
        }
      : null;

    // All agents use reactive loop mode (step by step, one action per LLM call)
    return await this._executePlaybookReactive(eventName, interpolatedPlaybook, args, context, memoryState, _fromDelegation, false, playbookResolver);
  }

  /**
   * Reactive agentic loop: LLM decides ONE action per iteration,
   * receives feedback, and adapts its strategy.
   * Uses ContextMemory for brain-inspired tiered memory management.
   */
  async _executePlaybookReactive(eventName, interpolatedPlaybook, args, context, memoryState = null, isDelegate = false, _isRecovery = false, playbookResolver = null) {
    // Initialize session tracker if session ID is set and tracker not yet created
    if (process.env.KOI_SESSION_ID && !sessionTracker) {
      initSessionTracker(
        process.env.KOI_SESSION_ID,
        process.env.KOI_PROJECT_ROOT || process.cwd()
      );
    }

    const session = new PlaybookSession({
      playbook: interpolatedPlaybook,
      agentName: this.name
    });
    session.actionContext.args = args;
    session.actionContext.state = this.state;

    // Create ContextMemory and restore previous state
    const contextMemory = new ContextMemory({
      agentName: this.name,
      llmProvider: this.llmProvider
    });
    this._activeContextMemory = contextMemory;

    if (memoryState) {
      contextMemory.restore(memoryState);
    }

    // If resuming a session, try to restore from session tracker.
    // Skip for delegates — they should always start fresh with only the task data.
    if (sessionTracker && !memoryState && !isDelegate) {
      try {
        const history = sessionTracker.getHistory();
        if (history.length > 0) {
          context.sessionHistory = history.map(h => h.summary);
        }
      } catch { /* non-fatal */ }

      // Restore context memory from previous session
      try {
        const savedState = sessionTracker.loadConversation(this.name);
        if (savedState && (savedState.version === 1 || (Array.isArray(savedState) && savedState.length > 0))) {
          contextMemory.restore(savedState);
          const entryCount = contextMemory.entries.length;
          const latentCount = contextMemory.latentPool.length;
          cliLogger.log('session', `Restored context memory for ${this.name} (${entryCount} entries, ${latentCount} latent)`);
        }
      } catch { /* non-fatal */ }

      // Restore input history from previous session
      try {
        const { loadHistory } = await import('./cli-input.js');
        const savedHistory = sessionTracker.loadInputHistory();
        if (savedHistory.length > 0) {
          loadHistory(savedHistory);
          cliLogger.log('session', `Restored ${savedHistory.length} input history entries`);
        }
      } catch { /* non-fatal */ }
    }

    // Connect MCPs eagerly so their tools appear in the system prompt
    const mcpErrors = {};
    if (this.usesMCPNames.length > 0) {
      const mcpRegistry = globalThis.mcpRegistry;
      if (mcpRegistry) {
        for (const mcpName of this.usesMCPNames) {
          const client = mcpRegistry.get(mcpName);
          if (client && !client.initialized) {
            try {
              await client.connect();
            } catch (err) {
              const cause = client.lastError || err.message;
              mcpErrors[mcpName] = cause;
              console.error(`[Agent:${this.name}] ❌ MCP "${mcpName}" failed to connect: ${cause}`);
            }
          }
        }
      }
    }

    // If any MCPs failed, inject the errors so the LLM knows
    if (Object.keys(mcpErrors).length > 0) {
      session.mcpErrors = mcpErrors;
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent:${this.name}] 🔄 Starting reactive loop${isDelegate ? ' (delegate)' : ''}`);
    }
    cliLogger.log('agent', `${this.name}: Starting reactive loop${isDelegate ? ' [delegate]' : ''}`);

    let isFirstCall = true;
    let thinkingHint = 'Thinking';
    let exitedOnAbort = false;

    // Fast-greeting: skip the first LLM call for interactive CLI agents.
    // When the playbook has __FAST_GREETING__, we directly show a hardcoded greeting
    // + prompt_user on iteration 0 without calling the LLM at all.
    // This eliminates the 2-5s startup delay and ensures prompt_user runs in the
    // sequential path (so slash commands like /cost are properly intercepted).
    const FAST_GREETINGS = [
      "What can I build for you?",
      "Ready. What's the task?",
      "What do you need?",
      "Go ahead.",
      "What are we working on?",
    ];
    const _fastGreetMsg = FAST_GREETINGS[Math.floor(Math.random() * FAST_GREETINGS.length)];
    const isFastGreeting = !isDelegate
      && !contextMemory.hasHistory()
      && !session.mcpErrors
      && interpolatedPlaybook.includes('__FAST_GREETING__');

    // Mark agent as busy for the entire reactive loop
    Agent._cliHooks?.onBusy?.(true);

    // ── RESUMED SESSION: check for pending tasks before the first LLM call ──
    // When the session resumes (context history exists, not a delegate) and there
    // are unfinished tasks persisted on disk, ask the user whether to continue or
    // start fresh — BEFORE calling the LLM, so the prompt appears immediately.
    if (!isDelegate && contextMemory.hasHistory()) {
      try {
        const { taskManager } = await import('./task-manager.js');
        const hasPendingOnDisk = taskManager.checkRestoredFromDisk();
        if (hasPendingOnDisk) {
          const tasks = taskManager.list();
          const unfinished = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
          if (unfinished.length > 0) {
            const { cliSelect } = await import('./cli-select.js');
            Agent._cliHooks?.onBusy?.(false);

            // Format: only show unfinished tasks (completed ones are not shown here).
            const UNFINISHED_LIMIT = 5;

            const fmtTask = t =>
              `  ${t.status === 'in_progress' ? '●' : '☐'}  ${t.subject}`;

            const unfinishedLines = unfinished.slice(0, UNFINISHED_LIMIT).map(fmtTask);
            const unfinishedExtra = unfinished.length - UNFINISHED_LIMIT;
            if (unfinishedExtra > 0) unfinishedLines.push(`    … +${unfinishedExtra} more`);

            cliLogger.print(unfinishedLines.join('\n'));
            const choice = await cliSelect(
              'Do you want to continue the plan?',
              [
                { title: 'Continue', value: 'continue', description: 'Resume the plan where it left off' },
                { title: 'Start fresh', value: 'fresh', description: 'Discard the plan and start over' },
              ]
            );
            Agent._cliHooks?.onBusy?.(true);
            if (choice === 'continue') {
              // User confirmed: populate the anchored panel now
              taskManager.showPanel();
              cliLogger.print('Resuming tasks...');
              session._resumingTasks = true;
            } else {
              // "Start fresh" or Escape — discard unfinished tasks, keep panel empty
              for (const t of unfinished) {
                try { taskManager.update(t.id, { status: 'deleted' }); } catch { /* non-fatal */ }
              }
              cliLogger.print('Plan cleared.');
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    while (!session.isTerminated) {
      // If stuck on too many consecutive errors, pivot before giving up.
      // Inject a "try completely different approach" message and reset counters.
      // After 3 pivots, break out and let recovery handle it.
      if (session.consecutiveErrors >= session.maxConsecutiveErrors) {
        const canPivot = session.pivot();
        if (!canPivot) break;
        cliLogger.log('agent', `${this.name}: pivot #${session._pivotCount} after ${session.maxConsecutiveErrors} consecutive errors`);
        contextMemory.add(
          'user',
          `CRITICAL — PIVOT REQUIRED (attempt ${session._pivotCount}/3): You have been stuck in a failing loop. You MUST completely abandon your current approach and try something entirely different. Do NOT repeat any strategy that already failed. If you are truly blocked and cannot find another approach, use prompt_user to ask the user for guidance.`,
          'Pivot: forced strategy change.',
          null
        );
      }

      // Check if user cancelled via Ctrl+C.
      // Check both the signal (while controller exists) and wasAborted flag
      // (persists after uiBridge nulls the controller on abort).
      if (Agent._cliHooks?.getAbortSignal?.()?.aborted || Agent._cliHooks?.wasAborted?.()) {
        exitedOnAbort = true;
        break;
      }

      // 1. GET ACTION(S) from LLM — or fast-start on iteration 0
      let response;

      if (isFastGreeting && session.iteration === 0) {
        // Skip LLM call — show greeting then prompt directly (instant startup)
        cliLogger.log('agent', `${this.name}: Fast-greeting (skipping LLM on iteration 0)`);
        response = [
          { actionType: 'direct', intent: 'print', message: _fastGreetMsg },
          { actionType: 'direct', intent: 'prompt_user' }
        ];
        isFirstCall = false;
      } else {

      cliLogger.log('agent', `${this.name}: Calling LLM (iteration ${session.iteration + 1}, hint: ${thinkingHint})`);

      // Show ↑ tokens BEFORE the LLM call + context breakdown in separate slot
      // Only update slots when values > 0 so the last known data persists
      {
        const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        const est = (text) => text ? Math.ceil(text.length / 4) : 0;
        const msgs = contextMemory.toMessages();
        const inputTk = msgs.reduce((sum, m) => sum + est(m.content || ''), 0);
        if (inputTk > 0) {
          cliLogger.setInfo('tokens', `↑${fmt(inputTk)} tokens`);
        }

        let sysTk = est(contextMemory.systemPrompt), longTk = 0, midTk = 0, shortTk = 0, latentTk = 0;
        for (const e of contextMemory.entries) {
          if (e.tier === 'long-term') longTk += est(e.permanent);
          else if (e.tier === 'medium-term') midTk += est(e.shortTerm);
          else if (e.tier === 'short-term') shortTk += est(e.immediate);
        }
        for (const m of contextMemory.latentPool) latentTk += est(m.summary);
        const totalCtx = sysTk + longTk + midTk + shortTk + latentTk;
        if (totalCtx > 0) {
          cliLogger.setInfo('context', `(\u{1F9E0} ${fmt(sysTk)} sys / ${fmt(longTk)} long / ${fmt(midTk)} mid / ${fmt(shortTk)} short / ${fmt(latentTk)} latent)`);
        }
      }

      try {
        response = await this.llmProvider.executePlaybookReactive({
          playbook: interpolatedPlaybook,
          context,
          agentName: this.name,
          session,
          agent: this,
          contextMemory,
          isFirstCall,
          thinkingHint,
          isDelegate,
          abortSignal: Agent._cliHooks?.getAbortSignal?.()
        });
        isFirstCall = false;
        this._llmErrorShown = false; // Reset warning flag on successful call
        cliLogger.log('agent', `${this.name}: LLM responded`);
      } catch (error) {
        cliLogger.clear();

        // AbortError = user pressed Ctrl+C → break out of loop immediately.
        // Use wasAborted() hook (UIBridge flag set on user Ctrl+C) as the primary
        // signal — avoids false positives from network errors like ECONNABORTED.
        // Fall back to error.name check for non-CLI mode (no hooks).
        const isAbort = Agent._cliHooks?.wasAborted?.()
          || error.name === 'AbortError'
          || Agent._cliHooks?.getAbortSignal?.()?.aborted;
        if (isAbort) {
          exitedOnAbort = true;
          cliLogger.log('agent', `${this.name}: Cancelled by user`);
          break;
        }

        const modelId = this.llmProvider?.model ?? '?';
        const providerId = this.llmProvider?.provider ?? '?';
        cliLogger.log('agent', `${this.name}: LLM FAILED (${modelId}): ${error.message}\n${error.stack}`);
        cliLogger.log('llm', `[${this.name}] LLM error (${providerId}/${modelId}): ${error.message}`);
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Agent:${this.name}] ❌ LLM call failed (${modelId}): ${error.message}`);
        }
        session.recordAction({ intent: '_llm_error', actionType: 'direct' }, null, error);
        continue;
      }

      } // end else (normal LLM path)

      // Normalize to array for uniform processing
      const actionBatch = Array.isArray(response) ? response : [response];

      // Normalize actions: collect stray fields into "data" when missing
      for (const act of actionBatch) {
        this._normalizeActionData(act);
      }

      if (process.env.KOI_DEBUG_LLM && actionBatch.length > 1) {
        console.error(`[Agent:${this.name}] 📦 Batched ${actionBatch.length} actions`);
      }

      // Process each action in the batch sequentially.
      // Items with { parallel: [...] } are executed concurrently via Promise.all.
      let terminated = false;
      for (const action of actionBatch) {
        if (!session.canContinue()) break;

        // ── PARALLEL GROUP ──────────────────────────────────────────────────
        if (action.parallel && Array.isArray(action.parallel)) {
          const group = action.parallel;
          cliLogger.log('action', `${this.name}: Executing ${group.length} actions in parallel`);
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ⚡ Parallel group (${group.length}): ${group.map(a => a.intent || a.type).join(', ')}`);
          }

          // Pre-flight: collect all required permissions BEFORE launching parallel.
          // Without this, each concurrent action would ask the user separately for
          // the same directory — pre-granting here ensures they only ask once.
          await this._preflightParallelPermissions(group);

          const parallelResults = await Promise.all(group.map(async (pa) => {
            const paIntent = pa.intent || pa.type || 'unknown';
            try {
              const { result } = await this._executeAction(pa, pa, session.actionContext);
              if (pa.id) {
                // Store in shared context so subsequent actions in the same batch
                // can reference results via session.actionContext[id].output
                session.actionContext[pa.id] = { output: result };
              }
              session.recordAction(pa, result);
              cliLogger.log('result', `${this.name} [parallel/${paIntent}]: ${JSON.stringify(result).substring(0, 150)}`);
              return { action: pa, result };
            } catch (error) {
              const failedIntent = pa?.intent || pa?.type || 'unknown';
              cliLogger.log('error', `${this.name}: Parallel action "${failedIntent}" failed: ${error.message}\n${error.stack}`);
              session.recordAction(pa, null, error);
              return { action: pa, result: null, error };
            }
          }));

          // Build a combined result so the LLM sees ALL parallel results at once
          // (not just the last one, which is what the standard feedback path would show)
          const parallelSummary = parallelResults.map(r => {
            const intent = r.action.intent || r.action.type || 'unknown';
            const id = r.action.id ? ` [${r.action.id}]` : '';
            if (r.error) return `❌ ${intent}${id} -> ${r.error.message}`;
            return `✅ ${intent}${id} -> ${JSON.stringify(r.result).substring(0, 200)}`;
          }).join('\n');
          // Inject a synthetic "parallel group done" record so executePlaybookReactive
          // picks it up as the last feedback entry
          session.recordAction(
            { intent: '_parallel_done', actionType: 'direct', _parallelGroup: true },
            { _parallelResults: parallelSummary }
          );

          if (process.env.KOI_DEBUG_LLM) {
            const summary = parallelResults.map(r => `${r.action.intent || r.action.type}: ${r.error ? '❌' : '✅'}`).join(', ');
            console.error(`[Agent:${this.name}] ⚡ Parallel done: ${summary}`);
          }
          continue;
        }
        // ────────────────────────────────────────────────────────────────────

        const intent = action.intent || action.type || 'unknown';
        cliLogger.log('action', `${this.name}: Executing ${intent}${action.id ? ' [' + action.id + ']' : ''}`);

        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Agent:${this.name}] 🎯 Reactive step ${session.iteration + 1}: ${intent}`);
        }

        // Print token/memory summary before return (reset accumulator)
        if (intent === 'return') {
          this._printTokenSummary(session, contextMemory, { reset: true });
        }

        // CHECK TERMINAL ACTION
        if ((action.intent || action.type) === 'return') {
          let returnData = action.data || {};

          // Apply state updates if present
          if (returnData && typeof returnData === 'object' && (returnData.state_updates || returnData.stateUpdates)) {
            const updates = returnData.state_updates || returnData.stateUpdates;
            Object.keys(updates).forEach(key => {
              this.state[key] = updates[key];
            });
            const { state_updates, stateUpdates, ...cleanData } = returnData;
            returnData = cleanData;
          }

          // In CLI mode, "return" means "task done, wait for next user input".
          // For delegate agents this does NOT apply — they must return the result
          // to the agent that called them, not wait for user input.
          if (process.env.KOI_CLI_MODE === '1' && !isDelegate) {
            cliLogger.log('agent', `${this.name}: Task completed, waiting for next input`);
            // Commit pending changes
            if (sessionTracker && sessionTracker.hasPendingChanges()) {
              await this._commitSessionChanges(interpolatedPlaybook);
              const lastSummary = sessionTracker.lastCommitSummary;
              if (lastSummary) cliLogger.print(`\x1b[2m${lastSummary}\x1b[0m`);
            }
            // Save context memory
            if (!this.amnesia && sessionTracker) {
              sessionTracker.saveConversation(this.name, contextMemory.serialize());
            }
            // Release busy state
            Agent._cliHooks?.onBusy?.(false);
            this._printTokenSummary(session, contextMemory, { reset: true });
            // Tick memory (age entries)
            await contextMemory.tick();
            // Record the return so the LLM knows the task is done,
            // and add feedback telling it to wait for user input
            session.recordAction(action, returnData);
            contextMemory.add(
              'user',
              'Task completed. Wait for the user to type something — use prompt_user now.',
              'Task completed.',
              null
            );
            thinkingHint = 'Thinking';
            // Continue the loop — LLM will be called again and should prompt_user
            continue;
          }

          if (isDelegate) {
            cliLogger.log('agent', `${this.name}: Delegate task completed, returning to caller`);
          }
          session.terminate(returnData);
          terminated = true;
          break;
        }

        // Release busy state before giving control to the user
        if (intent === 'prompt_user') {
          Agent._cliHooks?.onBusy?.(false);
        }

        // Commit pending changes before returning control to the user (prompt_user)
        if (intent === 'prompt_user' && sessionTracker && sessionTracker.hasPendingChanges()) {
          await this._commitSessionChanges(interpolatedPlaybook);
          const lastSummary = sessionTracker.lastCommitSummary;
          if (lastSummary) cliLogger.print(`\x1b[2m${lastSummary}\x1b[0m`);
        }

        // EXECUTE ACTION
        try {
          cliLogger.planning(buildActionDisplay(this.name, action));

          let { result } = await this._executeAction(action, action, session.actionContext);

          cliLogger.clear();

          // Intercept slash commands from prompt_user (e.g. /history, /diff, /undo)
          while (intent === 'prompt_user' && result?.answer?.startsWith('/')) {
            const slashResult = await this._handleSlashCommand(result.answer, action, session);
            if (!slashResult.handled) break;
            cliLogger.planning(buildActionDisplay(this.name, action));
            const { result: newResult } = await this._executeAction(action, action, session.actionContext);
            cliLogger.clear();
            result = newResult;
          }

          // Re-enter busy state after prompt_user resolves
          if (intent === 'prompt_user') {
            Agent._cliHooks?.onBusy?.(true);
          }

          // Save input history, dialogue, and context memory after prompt_user
          // (persists memory in case user closes with Ctrl+C before loop ends)
          if (intent === 'prompt_user' && sessionTracker && result) {
            try {
              const { getHistory: getInputHistory } = await import('./cli-input.js');
              sessionTracker.saveInputHistory(getInputHistory());
            } catch { /* non-fatal */ }
            sessionTracker.appendDialogue({ ts: Date.now(), type: 'user_input', text: result.answer || '' });
            if (!this.amnesia) {
              sessionTracker.saveConversation(this.name, contextMemory.serialize());
            }
          }

          // Log action results to dialogue
          if (intent !== 'prompt_user' && sessionTracker) {
            const resultPreview = result ? JSON.stringify(result).substring(0, 200) : 'null';
            sessionTracker.appendDialogue({ ts: Date.now(), type: 'action', intent, result: resultPreview });
          }

          session.recordAction(action, result);

          // If a delegate used ask_parent, terminate early so the parent can answer.
          if (result && result.__askParent__ === true && isDelegate) {
            session.terminate(result);
            terminated = true;
            break;
          }

          // Update token info in status bar after every action
          this._printTokenSummary(session, contextMemory);

          const full = result ? JSON.stringify(result) : 'null';
          const preview = full.length > 150 ? full.substring(0, 150) + '...' : full;
          cliLogger.log('result', `${this.name}: ${preview}`);

          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ✅ Result: ${preview}`);
          }

          // Update thinking hint based on what just happened
          if (result && result.success === false) {
            thinkingHint = 'Retrying';
          } else {
            thinkingHint = this._describeNextStep(action, result);
          }
        } catch (error) {
          cliLogger.clear();
          const failedIntent = action?.intent || action?.type || 'unknown';
          cliLogger.log('error', `${this.name}: Action "${failedIntent}" failed [iter=${session.iteration}, delegate=${isDelegate}]: ${error.message}\n${error.stack}`);
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ❌ Action "${failedIntent}" failed: ${error.message}\n${error.stack}`);
          }
          session.recordAction(action, null, error);
          thinkingHint = 'Rethinking';
          break;
        }
      }

      if (terminated) break;
    }

    // Clear busy state when loop exits
    Agent._cliHooks?.onBusy?.(false);

    // Commit ALL pending file changes as ONE changeset when control returns to user
    if (sessionTracker && sessionTracker.hasPendingChanges()) {
      await this._commitSessionChanges(interpolatedPlaybook);
    }

    // Save final input history on loop exit
    if (sessionTracker) {
      try {
        const { getHistory: getInputHistory } = await import('./cli-input.js');
        sessionTracker.saveInputHistory(getInputHistory());
      } catch { /* non-fatal */ }
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent:${this.name}] 🔄 Reactive loop finished after ${session.iteration} iterations`);
    }

    // Save context memory state (unless amnesia is enabled)
    if (!this.amnesia) {
      this.contextMemoryState = contextMemory.serialize();
      if (sessionTracker) {
        sessionTracker.saveConversation(this.name, this.contextMemoryState);
      }
    }

    // In CLI mode, if the loop exited (consecutive errors, abort, etc.),
    // add a recovery message and re-enter. The loop should normally never exit
    // in CLI mode (return actions are handled as continue above).
    // Delegates must NOT enter this recovery path — they should propagate errors
    // back to the calling agent so it can handle them.
    if (process.env.KOI_CLI_MODE === '1' && !isDelegate) {
      const lastError = session.actionHistory.at(-1)?.error;
      const exitedOnErrors = session.consecutiveErrors >= session.maxConsecutiveErrors
        || (session._pivotCount || 0) > 3;

      cliLogger.log('agent', `${this.name}: CLI mode — loop exited (errors: ${session.consecutiveErrors}, abort: ${exitedOnAbort}, recovery: ${_isRecovery})`);

      // Ctrl+C abort: stop silently. No LLM call, no recovery greeting.
      // agentBusy is already false (cleared above). Directly show the input
      // prompt and wait for the user's next message, then restart fresh.
      if (exitedOnAbort) {
        contextMemory.add('user', 'Task was cancelled by user.', 'Cancelled.', null);
        let promptResult;
        try {
          // Re-mark busy so Ctrl+C during this wait triggers cancel (not exit warning)
          Agent._cliHooks?.onBusy?.(true);
          const { result } = await this._executeAction(
            { intent: 'prompt_user' },
            { intent: 'prompt_user' },
            session.actionContext
          );
          Agent._cliHooks?.onBusy?.(false);
          promptResult = result;
        } catch (_) { Agent._cliHooks?.onBusy?.(false); return {}; }

        if (!promptResult?.answer) return {};

        // Add user's new message to context and restart the reactive loop.
        // Re-evaluate the playbook via playbookResolver so compose blocks pick up
        // any runtime state changes (e.g. tasks created since the session started).
        contextMemory.add('user', promptResult.answer, promptResult.answer, null);
        this.contextMemoryState = contextMemory.serialize();
        const freshPlaybook = playbookResolver ? await playbookResolver() : interpolatedPlaybook;
        return await this._executePlaybookReactive(eventName, freshPlaybook, args, context, this.contextMemoryState, false, false, playbookResolver);
      }

      // If already in recovery, do NOT recurse again — print error and stop.
      if (_isRecovery) {
        if (lastError) {
          cliLogger.print(`\x1b[31m⚠ ${lastError.message}\x1b[0m`);
        }
        return {};
      }

      // Loop exited on consecutive errors: show the error before recovering
      if (exitedOnErrors && lastError) {
        cliLogger.print(`\x1b[31m⚠ ${lastError.message}\x1b[0m`);
      }

      if (!this.amnesia) {
        this.contextMemoryState = contextMemory.serialize();
      }
      contextMemory.add(
        'user',
        'The previous task encountered an error. Wait for the user — use prompt_user now.',
        'Error recovery.',
        null
      );
      this.contextMemoryState = contextMemory.serialize();
      return await this._executePlaybookReactive(eventName, interpolatedPlaybook, args, context, this.contextMemoryState, false, true, playbookResolver);
    }

    // Return final result
    if (session.finalResult) return session.finalResult;

    // If a delegate agent exits without a return action (exhausted pivots / too many errors),
    // it MUST inform the user and return a failure result so the calling agent knows what happened.
    if (isDelegate) {
      const exitedOnErrors = session.consecutiveErrors >= session.maxConsecutiveErrors
        || (session._pivotCount || 0) > 3;

      if (exitedOnErrors && !exitedOnAbort) {
        // Find the most informative error in recent history
        const recentError = [...session.actionHistory].reverse().find(e => e.error || (e.result?.success === false));
        const errorMsg = recentError?.error?.message
          || recentError?.result?.error
          || `Reached retry limit after ${session.iteration} attempts without completing the task`;

        cliLogger.print(`\x1b[31m⚠ [${this.name}] Could not complete task: ${errorMsg}\x1b[0m`);
        cliLogger.print(`\x1b[33mThe agent was unable to recover. Please review the problem and provide guidance or try a different approach.\x1b[0m`);

        return { success: false, error: `[${this.name}] ${errorMsg}`, agentName: this.name };
      }
    }

    // Fallback: return last action result if loop exhausted
    const lastEntry = session.actionHistory[session.actionHistory.length - 1];
    return lastEntry?.result || {};
  }

  /**
   * Normalize a delegate action: everything that isn't actionType, intent or id
   * gets collected into "data".
   * E.g. { actionType, intent, name, age } → { actionType, intent, data: { name, age } }
   * @private
   */
  _normalizeActionData(action) {
    if (!action || action.data || action.actionType !== 'delegate') return;

    const reserved = new Set(['actionType', 'intent']);
    const data = {};
    for (const [k, v] of Object.entries(action)) {
      if (!reserved.has(k)) {
        data[k] = v;
        if (k !== 'id') delete action[k];
      }
    }

    if (Object.keys(data).length > 0) {
      action.data = data;
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Agent:${this.name}] 🔧 Normalized stray fields into data: ${Object.keys(data).join(', ')}`);
      }
    }
  }

  /**
   * Generate a descriptive thinking hint based on the last completed action.
   * @private
   */
  _describeNextStep(lastAction, result) {
    const intent = lastAction.intent || lastAction.type || '';

    // Ask the action itself — each action defines its own thinkingHint
    const actionDef = actionRegistry.get(intent);
    if (actionDef?.thinkingHint) {
      const hint = actionDef.thinkingHint;
      return typeof hint === 'function' ? hint(lastAction) : hint;
    }

    if (lastAction.actionType === 'delegate') {
      const agentKey = intent.split('::')[0];
      const agentName = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
      return `Processing response from ${agentName}`;
    }
    return 'Thinking';
  }


  /**
   * Commit pending session file changes with an LLM-generated summary.
   * Called after all actions from a prompt have been executed.
   * @private
   */

  // ─── Slash Commands ─────────────────────────────────────────────────

  /**
   * Handle a slash command typed by the user in prompt_user.
   * Commands are auto-loaded from the path in KOI_CLI_COMMAND_REGISTRY_PATH env var
   * (set by the CLI tool, e.g. koi-cli, before spawning the runtime process).
   * @returns {{ handled: boolean, action?, result? }}
   */
  async _handleSlashCommand(input, originalAction, session) {
    const trimmed = input.trim();
    const [cmd, ...args] = trimmed.substring(1).split(/\s+/);

    const registryPath = process.env.KOI_CLI_COMMAND_REGISTRY_PATH;
    if (!registryPath) {
      return { handled: false };
    }
    const { getCommand, getCommands } = await import(registryPath);
    const command = await getCommand(cmd);

    if (!command) {
      // No command or unknown command — show interactive menu of available commands
      cliLogger.clearProgress();
      const { cliSelect } = await import('./cli-select.js');
      const cmds = await getCommands();
      const options = [...cmds.values()]
        .map(c => ({ title: `/${c.name}`, value: c.name, description: c.description }));

      const promptText = originalAction.question || originalAction.prompt || '';
      const selected = await cliSelect('Commands:', options, 0, { filterable: true, inlinePrefix: promptText, initialFilter: '/' });
      if (!selected) {
        return { handled: true };
      }

      // Execute the selected command
      return this._handleSlashCommand(`/${selected}`, originalAction, session);
    }

    try {
      cliLogger.progress('\x1b[2mplease wait...\x1b[0m');
      const result = await command.execute(this, args);
      cliLogger.clearProgress();
      // Add executed slash command to input history (navigable with up/down arrows)
      const { addToHistory } = await import('./cli-input.js');
      addToHistory(`/${cmd}${args.length > 0 ? ' ' + args.join(' ') : ''}`);
      return { handled: true, result };
    } catch (err) {
      cliLogger.clearProgress();
      cliLogger.log('error', `Slash command /${cmd} failed: ${err.message}`);
      return { handled: false };
    }
  }

  /**
   * Print a single dim summary line with token usage and memory tier breakdown.
   * Called once before prompt_user or return — then resets the accumulator.
   */
  _printTokenSummary(session, contextMemory, { reset = false } = {}) {
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const est = (text) => text ? Math.ceil(text.length / 4) : 0;

    // Update tokens slot with ↓ (output tokens from last response)
    // Only update if there's actual data so last known value persists
    const last = session.lastUsage || { input: 0, output: 0 };
    if (last.output > 0) {
      cliLogger.setInfo('tokens', `↓${fmt(last.output)} tokens`);
    }

    // Update context slot with memory breakdown
    let sysTk = est(contextMemory.systemPrompt), longTk = 0, midTk = 0, shortTk = 0, latentTk = 0;
    for (const e of contextMemory.entries) {
      if (e.tier === 'long-term') longTk += est(e.permanent);
      else if (e.tier === 'medium-term') midTk += est(e.shortTerm);
      else if (e.tier === 'short-term') shortTk += est(e.immediate);
    }
    for (const m of contextMemory.latentPool) latentTk += est(m.summary);
    const totalCtx = sysTk + longTk + midTk + shortTk + latentTk;
    if (totalCtx > 0) {
      cliLogger.setInfo('context', `(\u{1F9E0} ${fmt(sysTk)} sys / ${fmt(longTk)} long / ${fmt(midTk)} mid / ${fmt(shortTk)} short / ${fmt(latentTk)} latent)`);
    }

    if (reset) {
      const accum = session.tokenAccum;
      if (accum) session.tokenAccum = { input: 0, output: 0, calls: 0 };
    }
  }

  async _commitSessionChanges(promptContext) {
    if (!sessionTracker || !sessionTracker.hasPendingChanges()) return;

    try {
      const files = [...sessionTracker.pendingFiles];
      let summary = `Changed: ${files.join(', ')}`;

      // Get the actual diff of staged changes to feed the summary LLM
      let diffText = '';
      try {
        diffText = sessionTracker._git('diff --cached');
      } catch { /* fallback to no diff */ }

      // Generate natural language summary via LLM (fast, non-critical)
      if (this.llmProvider && diffText) {
        try {
          const completion = await this.llmProvider.callOpenAI(
            {
              model: 'gpt-4o-mini',
              temperature: 0,
              max_tokens: 100,
              messages: [
                { role: 'system', content: 'Summarize the code diff in one short sentence (max 80 chars). Be specific about WHAT changed, not the files. No markdown, no quotes. Examples: "Added execute command as alias for run", "Removed unused import and helper function"' },
                { role: 'user', content: diffText.substring(0, 2000) }
              ]
            },
            'session commit summary'
          );
          summary = completion.choices[0].message.content.trim();
        } catch {
          // Fallback to file list if LLM fails
        }
      }

      const commitResult = sessionTracker.commitChanges(summary);

      // Fire-and-forget: embed the commit summary for semantic search
      if (commitResult.success && commitResult.hash) {
        this._embedCommitSummary(commitResult.hash, summary).catch(() => {});
      }
      sessionTracker.lastCommitSummary = summary;
      return summary;
    } catch {
      // Non-fatal
    }
  }

  /**
   * Start background project indexing (fire-and-forget).
   * Uses BackgroundTaskManager + VectorStore for semantic search pre-warming.
   * @private
   */
  async _startBackgroundIndexing() {
    try {
      if (!this.llmProvider) {
        this.llmProvider = new LLMProvider(this.llm);
      }
      const projectDir = process.env.KOI_PROJECT_ROOT || process.cwd();
      const embedFn = async (text) => this.llmProvider.getEmbedding(text);
      const { backgroundTaskManager } = await import('./background-task-manager.js');
      backgroundTaskManager.startProjectIndexing(projectDir, embedFn);
    } catch (err) {
      cliLogger.log('background', `Indexing start failed: ${err.message}`);
    }
  }

  /**
   * Embed a commit summary and save it for later semantic search.
   * @private
   */
  async _embedCommitSummary(hash, summary) {
    if (!this.llmProvider || !sessionTracker) return;
    try {
      const embedding = await this.llmProvider.getEmbedding(summary);
      if (embedding) {
        sessionTracker.saveCommitEmbedding(hash, summary, embedding);
        cliLogger.log('session', `Embedded commit [${hash}]: ${summary}`);
      }
    } catch (err) {
      cliLogger.log('session', `Embed commit failed: ${err.message}`);
    }
  }

  /**
   * Pre-flight permission check for a parallel action group.
   * Asks the user ONCE per unique directory before launching concurrent actions,
   * so they don't each pop their own permission dialog.
   * Grants permission even for "yes" (not just "always") so all parallel actions
   * in the group inherit the approval without re-asking.
   * @private
   */
  async _preflightParallelPermissions(group) {
    const { getFilePermissions } = await import('./file-permissions.js');
    const { cliSelect } = await import('./cli-select.js');
    const path = (await import('path')).default;
    const fs = (await import('fs')).default;

    // Determine what path and permission level each action needs
    const getPermissionTarget = (action) => {
      const intent = action.intent || action.type || '';
      // Path may be on action directly or nested in data
      const rawPath = action.path ?? action.data?.path;
      switch (intent) {
        case 'grep':
        case 'search':
        case 'read_file':
          return { targetPath: rawPath || process.cwd(), level: 'read' };
        case 'edit_file':
        case 'write_file':
          return rawPath ? { targetPath: rawPath, level: 'write' } : null;
        default:
          return null; // no file permission needed
      }
    };

    const permissions = getFilePermissions(this);

    // Build deduplicated set of (resolvedDir, level) pairs that lack permission
    const toCheck = new Map(); // key: `${dir}:${level}` → { dir, level }

    for (const action of group) {
      const target = getPermissionTarget(action);
      if (!target) continue;

      const resolved = path.resolve(target.targetPath);
      let dir;
      try {
        const stat = fs.statSync(resolved);
        dir = stat.isFile() ? path.dirname(resolved) : resolved;
      } catch {
        // Path doesn't exist yet (write target) — use dirname
        dir = fs.existsSync(path.dirname(resolved)) ? path.dirname(resolved) : process.cwd();
      }

      if (!permissions.isAllowed(dir, target.level)) {
        const key = `${dir}:${target.level}`;
        if (!toCheck.has(key)) {
          toCheck.set(key, { dir, level: target.level });
        }
      }
    }

    if (toCheck.size === 0) return; // everything already permitted

    // Ask once per unique (dir, level) — sequentially to avoid concurrent prompts
    for (const { dir, level } of toCheck.values()) {
      cliLogger.clearProgress();
      const op = level === 'write' ? 'write to' : 'read from';
      cliLogger.print(`🔍 ${this.name} wants to ${op}: \x1b[33m${dir}\x1b[0m\n`);

      const value = await cliSelect(`Allow ${level} access to this directory?`, [
        { title: 'Yes',          value: 'yes',    description: 'Allow for this batch' },
        { title: 'Always allow', value: 'always', description: 'Always allow in this directory' },
        { title: 'No',           value: 'no',     description: 'Deny access' }
      ]);

      if (value === 'yes' || value === 'always') {
        // Grant so all parallel actions (and the "always" case, future calls) skip the dialog
        permissions.allow(dir, level);
        cliLogger.log('permissions', `Pre-granted ${level} for parallel group: ${dir}`);
      }
      // If 'no': don't grant — individual actions will surface a denial result
    }
  }

  /**
   * Execute a single action (common code for both streaming and batch execution)
   * @private
   * @returns {Object} { result, shouldExitLoop }
   */
  async _executeAction(action, resolvedAction, context) {
    const actionRegistry = (await import('./action-registry.js')).actionRegistry;
    let result;
    let shouldExitLoop = false;

    // Check if this is a delegation action
    if (action.actionType === 'delegate') {
      // Delegation: route to appropriate team member
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Agent:${this.name}] 🔀 Delegating action: ${action.intent}`);
      }

      // Auto-mark the associated task as in_progress before delegating,
      // and completed/failed after — so the UI always reflects the real state
      // regardless of whether the LLM remembered to call task_update.
      const _taskId = action.data?.taskId ?? resolvedAction.data?.taskId;
      if (_taskId) {
        try {
          const { taskManager } = await import('./task-manager.js');
          const _task = taskManager.get(String(_taskId));
          if (_task && _task.status === 'pending') {
            taskManager.update(String(_taskId), { status: 'in_progress' });
          }
        } catch { /* non-fatal */ }
      }

      result = await this.resolveAction(resolvedAction, context);

      if (_taskId) {
        try {
          const { taskManager } = await import('./task-manager.js');
          const _task = taskManager.get(String(_taskId));
          if (_task && _task.status === 'in_progress') {
            const _failed = result && result.success === false;
            if (!_failed) taskManager.update(String(_taskId), { status: 'completed' });
          }
        } catch { /* non-fatal */ }
      }
    } else {
      // Direct action: if params are nested inside "data", lift them to top level
      if (resolvedAction.data && typeof resolvedAction.data === 'object') {
        for (const [k, v] of Object.entries(resolvedAction.data)) {
          if (resolvedAction[k] === undefined) {
            resolvedAction[k] = v;
          }
        }
      }

      // Check if this is a registered action with an executor
      const actionDef = actionRegistry.get(action.intent || action.type);

      if (actionDef && actionDef.execute) {
        // Fast path: execute registered action
        result = await actionDef.execute(resolvedAction, this);

        // Special handling for return action with conditions
        if ((action.intent === 'return' || action.type === 'return') && action.condition !== undefined) {
          shouldExitLoop = true;
        }
      } else if (action.intent || action.description) {
        // Resolve via router (legacy fallback)
        result = await this.resolveAction(resolvedAction, context);
      } else {
        // Fallback legacy
        result = await this.executeLegacyAction(resolvedAction);
      }
    }

    return { result, shouldExitLoop };
  }

  async _executeComposePrompt(composeDef) {
    // Prefer compile-time generated resolver (embedded by transpiler, no runtime LLM call)
    if (composeDef.resolve) {
      const resolvedFragments = {};
      for (const [key, value] of Object.entries(composeDef.fragments || {})) {
        resolvedFragments[key] = typeof value === 'function' ? value() : (value || '');
      }
      const callAction = async (intent, data = {}) => {
        const actionDef = actionRegistry.get(intent);
        if (!actionDef) return null;
        return await actionDef.execute({ intent, ...data }, this);
      };
      try {
        return await composeDef.resolve(resolvedFragments, callAction);
      } catch (error) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Compose] Resolver error for compiled compose, falling back to LLM: ${error.message}`);
        }
        // Fall through to LLM-based compose
      }
    }

    // Fallback: runtime LLM-based compose (used when no compile-time resolver is available)
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }
    return await this.llmProvider.executeCompose(composeDef, this);
  }

  async executeActions(actions) {
    let finalResult = {};
    const context = { state: this.state };

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const intent = action.intent || action.type || action.description;

      cliLogger.progress(`[${this.name}] Thinking...`);

      const { result, shouldExitLoop } = await this._executeAction(action, action, context);
      finalResult = result;

      if (shouldExitLoop) {
        i = actions.length;
      }

      cliLogger.clear();

      if (process.env.KOI_DEBUG_LLM) {
        const fullStr = JSON.stringify(finalResult);
        console.error(`[Agent:${this.name}] 🔍 Action ${intent} returned:`, fullStr.length > 150 ? fullStr.substring(0, 150) + '...' : fullStr);
      }
    }

    return finalResult;
  }


  /**
   * Resolve an action using cascading strategy:
   * 1️⃣ Can I handle it myself (do I have a handler)?
   * 2️⃣ Do I have a skill that can do it?
   * 3️⃣ Can I delegate to another agent via router?
   * 4️⃣ Can I execute directly with a simple prompt?
   */
  async resolveAction(action, context = {}) {
    const intent = action.intent || action.type || action.description;

    // Check for infinite loops before proceeding
    const callSignature = `${this.name}:${intent}`;
    if (globalCallStack.includes(callSignature)) {
      throw new Error(
        `[Agent:${this.name}] Infinite loop detected!\n` +
        `  Call stack: ${globalCallStack.join(' → ')} → ${callSignature}\n` +
        `  Preventing recursion for intent: "${intent}"`
      );
    }

    // Push to call stack
    globalCallStack.push(callSignature);

    try {
      // 1️⃣ Do I have a handler for this? (check my own event handlers)
      const matchingHandler = this.findMatchingHandler(intent);
      if (matchingHandler) {
        // Self-delegation (same agent handles it)
        const result = await this.handle(matchingHandler, action.data || action.input || {}, false);
        globalCallStack.pop();
        return result;
      }

      // 2️⃣ Do I have a matching skill?
      const matchingSkill = this.findMatchingSkill(intent);
      if (matchingSkill) {
        cliLogger.planning(buildActionDisplay(this.name, action));
        const result = await this.callSkill(matchingSkill, action.data || action.input || {});
        cliLogger.clear();
        globalCallStack.pop();
        return result;
      }

      // 3️⃣ Can someone in my teams handle it? (check peers + usesTeams)
      if (this.peers || this.usesTeams.length > 0) {
        // Check delegate permission
        if (!this.hasPermission('delegate')) {
          globalCallStack.pop();
          throw new Error(`Agent "${this.name}" cannot delegate: role "${this.role?.name || 'unknown'}" lacks "can delegate" permission.`);
        }

        // Search within team members - team defines communication boundaries
        const teamMember = await this.findTeamMemberForIntent(intent);

        if (teamMember) {
          // Show delegation with indentation
          const actionTitle = action.title || intent;
          let currentData = action.data || action.input || {};
          let result;

          // Retry loop: if the delegate uses ask_parent, answer and re-invoke.
          while (true) {
            cliLogger.pushIndent(`[${teamMember.agent.name}] ${actionTitle}`);
            result = await teamMember.agent.handle(teamMember.event, currentData, true);
            cliLogger.popIndent();

            if (result && result.__askParent__ === true) {
              const answer = await this._answerDelegateQuestion(result.question, currentData);
              currentData = { ...currentData, answer };
            } else {
              break;
            }
          }

          globalCallStack.pop();
          return result;
        }
      } else if (intent && typeof intent === 'string' && intent.trim() !== '') {
        // No teams defined - fall back to global router (rare case)
        const { agentRouter } = await import('./router.js');
        let matches = await agentRouter.findMatches(intent, 5);

        // Filter out self-delegation
        matches = matches.filter(match => match.agent !== this);

        if (matches.length > 0) {
          const best = matches[0];
          const actionTitle = action.title || intent;
          cliLogger.pushIndent(`[${best.agent.name}] ${actionTitle}`);

          const result = await best.agent.handle(best.event, action.data || action.input || {}, true);
          cliLogger.popIndent();

          globalCallStack.pop();
          return result;
        }
      }

      // 4️⃣ Can I execute directly with LLM? (simple tasks, only if no one else can do it)
      if (this.canExecuteDirectly(action)) {
        const result = await this.executeDirectly(action, context);
        globalCallStack.pop();
        return result;
      }

      // ❌ Cannot resolve
      globalCallStack.pop();
      throw new Error(
        `[Agent:${this.name}] Cannot resolve: "${intent}"\n` +
        `  - I don't have a handler for this\n` +
        `  - I don't have a matching skill\n` +
        `  - No team member available via router\n` +
        `  - Too complex for direct execution`
      );
    } catch (error) {
      // Clean up call stack on error
      globalCallStack.pop();
      throw error;
    }
  }

  /**
   * Find a team member that can handle the intent
   * Searches in peers (if member of a team) and usesTeams (teams this agent uses)
   */
  async findTeamMemberForIntent(intent) {
    if (!intent || typeof intent !== 'string' || intent.trim() === '') {
      return null;
    }

    // Collect all teams this agent can access
    const accessibleTeams = [];

    if (this.peers && this.peers.members) {
      accessibleTeams.push(this.peers);
    }

    for (const team of this.usesTeams) {
      if (team && team.members) {
        accessibleTeams.push(team);
      }
    }

    if (accessibleTeams.length === 0) {
      return null;
    }

    // 0. Check for qualified intent: "agentKey::eventName" or legacy "AgentName.eventName"
    const colonIdx = intent.indexOf('::');
    const dotIdx   = intent.indexOf('.');
    if (colonIdx >= 0 || dotIdx >= 0) {
      const sepLen   = colonIdx >= 0 ? 2 : 1;
      const splitIdx = colonIdx >= 0 ? colonIdx : dotIdx;
      const agentPart = intent.substring(0, splitIdx).toLowerCase();
      const eventPart = intent.substring(splitIdx + sepLen);
      for (const team of accessibleTeams) {
        for (const [memberName, member] of Object.entries(team.members)) {
          if (member === this) continue;
          if (memberName.toLowerCase() === agentPart || member.name.toLowerCase() === agentPart) {
            const matchingEvent = member.findMatchingHandler(eventPart);
            if (matchingEvent) {
              if (process.env.KOI_DEBUG_LLM) {
                console.error(`[Agent:${this.name}] ✅ Qualified match: ${memberName}::${matchingEvent} for intent "${intent}"`);
              }
              return { agent: member, event: matchingEvent };
            }
          }
        }
      }
    }

    // 1. Try direct handler name matching first (no LLM call needed!)
    for (const team of accessibleTeams) {
      for (const memberName of Object.keys(team.members)) {
        const member = team.members[memberName];
        if (member === this) continue;

        const matchingEvent = member.findMatchingHandler(intent);
        if (matchingEvent) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ✅ Direct match: ${member.name}.${matchingEvent} for intent "${intent}"`);
          }
          return { agent: member, event: matchingEvent };
        }
      }
    }

    // 2. No direct match — use semantic router as fallback
    const { agentRouter } = await import('./router.js');
    let matches = await agentRouter.findMatches(intent, 10);

    // Filter to only include agents in accessible teams (exclude self)
    matches = matches.filter(match => {
      const isAccessible = accessibleTeams.some(team => {
        return Object.keys(team.members).some(name => {
          const member = team.members[name];
          return member === match.agent || member.name === match.agent.name;
        });
      });
      return isAccessible && match.agent !== this;
    });

    if (matches.length > 0) {
      return matches[0];
    }

    return null;
  }

  /**
   * Find a handler in this agent that matches the intent
   */
  findMatchingHandler(intent) {
    if (!this.handlers || Object.keys(this.handlers).length === 0) {
      return null;
    }

    if (!intent || typeof intent !== 'string') {
      return null;
    }

    const intentLower = intent.toLowerCase().replace(/[^a-z0-9]/g, ''); // Remove non-alphanumeric

    // Try exact match first (case insensitive, ignoring separators)
    for (const eventName of Object.keys(this.handlers)) {
      const eventNormalized = eventName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (eventNormalized === intentLower) {
        return eventName;
      }
    }

    // Try partial match
    for (const eventName of Object.keys(this.handlers)) {
      const eventLower = eventName.toLowerCase();
      const intentOriginal = intent.toLowerCase();

      if (intentOriginal.includes(eventLower) || eventLower.includes(intentOriginal)) {
        return eventName;
      }
    }

    // Try keyword matching (split by spaces and camelCase)
    const keywords = intent
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .toLowerCase()
      .split(/\s+/)
      .filter(k => k.length > 2);

    for (const eventName of Object.keys(this.handlers)) {
      const eventLower = eventName.toLowerCase();

      for (const keyword of keywords) {
        if (eventLower.includes(keyword)) {
          return eventName;
        }
      }
    }

    return null;
  }

  /**
   * Generate documentation of peer capabilities for LLM prompts
   * Returns a string describing what intents can be delegated to which peers
   */
  getPeerCapabilitiesDocumentation() {
    const capabilities = [];
    const processedAgents = new Set();

    // Helper function to collect handlers from an agent
    const collectHandlers = (agent, teamName = null) => {
      if (!agent || processedAgents.has(agent.name)) {
        return;
      }
      processedAgents.add(agent.name);

      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        const handlers = Object.keys(agent.handlers);
        const agentInfo = teamName ? `${agent.name} (${teamName})` : agent.name;

        // Collect handler details with descriptions
        const handlerDetails = [];
        for (const handler of handlers) {
          const handlerFn = agent.handlers[handler];
          let description = '';

          if (handlerFn && handlerFn.__playbook__) {
            const playbook = handlerFn.__playbook__;
            const firstLine = playbook.split('\n')[0].trim();
            description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 60);
            if (description.length < firstLine.length) {
              description += '...';
            }
          }

          handlerDetails.push({
            name: handler,
            description: description || `Handle ${handler}`
          });
        }

        capabilities.push({
          agent: agentInfo,
          role: agent.role ? agent.role.name : 'Unknown',
          handlers: handlerDetails
        });
      }
    };

    // Collect from peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      const memberNames = Object.keys(this.peers.members);
      for (const memberName of memberNames) {
        const member = this.peers.members[memberName];
        if (member !== this) {
          collectHandlers(member, this.peers.name);
        }
      }
    }

    // Collect from usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        const memberNames = Object.keys(team.members);
        for (const memberName of memberNames) {
          const member = team.members[memberName];
          collectHandlers(member, team.name);
        }
      }
    }

    if (capabilities.length === 0) {
      return '';
    }

    let doc = '\nAvailable team member capabilities:\n';
    for (const cap of capabilities) {
      doc += `\n${cap.agent} [${cap.role}]:\n`;
      for (const handler of cap.handlers) {
        doc += `  - ${handler.name}: ${handler.description}\n`;
      }
    }
    doc += '\nTo delegate, use: { "intent": "handler_name", "data": {...} }\n';

    return doc;
  }

  /**
   * Generate peer capabilities formatted as available actions
   * Returns a string listing delegation actions in the same format as action registry
   */
  async getPeerCapabilitiesAsActions() {
    const capabilities = [];
    const processedAgents = new Set();

    // Helper function to collect handlers from an agent
    const collectHandlers = async (agent, teamName = null) => {
      if (!agent || processedAgents.has(agent.name)) {
        return;
      }
      processedAgents.add(agent.name);

      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        const handlers = Object.keys(agent.handlers);
        for (const handler of handlers) {
          const agentInfo = teamName ? `${agent.name} (${teamName})` : agent.name;

          // Extract affordance/description from handler
          let description = '';
          let inputParams = '{ ... }';
          let returnType = null;
          const handlerFn = agent.handlers[handler];

          if (handlerFn && handlerFn.__playbook__) {
            const playbook = handlerFn.__playbook__;

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[CollectHandlers] Found playbook for ${handler}, length: ${playbook.length}`);
            }

            // Use LLM to infer metadata from playbook
            const metadata = await inferActionMetadata(playbook);
            description = metadata.description;
            inputParams = metadata.inputParams;
            returnType = metadata.returnType;

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[CollectHandlers] Inferred metadata for ${handler}:`, metadata);
            }
          } else if (handlerFn && typeof handlerFn === 'function') {
            // For regular functions, generate description from name
            description = `Handle ${handler} event`;
            inputParams = '{ ... }';
            returnType = '{ "result": "any" }';
          }

          capabilities.push({
            intent: handler,
            agent: agentInfo,
            role: agent.role ? agent.role.name : 'Unknown',
            description: description || `Execute ${handler}`,
            inputParams: inputParams,
            returnType: returnType || '{ "result": "any" }'
          });
        }
      }
    };

    // Collect from peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      const memberNames = Object.keys(this.peers.members);
      for (const memberName of memberNames) {
        const member = this.peers.members[memberName];
        if (member !== this) {
          await collectHandlers(member, this.peers.name);
        }
      }
    }

    // Collect from usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        const memberNames = Object.keys(team.members);
        for (const memberName of memberNames) {
          const member = team.members[memberName];
          await collectHandlers(member, team.name);
        }
      }
    }

    if (capabilities.length === 0) {
      return '';
    }

    let doc = '\n\nDelegation actions (to team members):\n';
    for (const cap of capabilities) {
      // Build delegation description with inferred metadata
      doc += `- { "actionType": "delegate", "intent": "${cap.intent}", "data": ${cap.inputParams} } - ${cap.description} → Returns: ${cap.returnType} (Delegate to ${cap.agent} [${cap.role}])\n`;
    }

    return doc;
  }

  /**
   * Check if action can be executed directly with LLM
   */
  canExecuteDirectly(action) {
    // Has inline playbook
    if (action.playbook) return true;

    // Explicit LLM task
    if (action.type === 'llm_task') return true;

    // Simple state operations
    if (action.type === 'update_state' || action.type === 'return') return true;

    // If it's a very simple task description, LLM can handle it
    const intent = action.intent || action.description || '';
    if (intent.length < 100 && !action.requiresExternalAgent) {
      return true;
    }

    return false;
  }

  /**
   * Execute action directly with LLM
   */
  async executeDirectly(action, context) {
    // Check if this is a registered action with an executor
    const actionDef = actionRegistry.get(action.type);

    if (actionDef && actionDef.execute) {
      // Use the registered executor
      return await actionDef.execute(action, this);
    }

    // Execute with LLM
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    let prompt;

    if (action.playbook) {
      prompt = action.playbook;
    } else {
      // Generate simple prompt
      const intent = action.intent || action.description;
      const data = action.data || action.input || {};

      prompt = `
Task: ${intent}

Input data:
${JSON.stringify(data, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

Execute this task and return the result as JSON.
`;
    }

    return await this.llmProvider.callJSON(prompt, this);
  }

  /**
   * Answer a question from a delegate agent.
   * Called when a delegate uses the ask_parent action.
   * Uses this agent's LLM to generate an answer, then re-delegates with the answer.
   */
  async _answerDelegateQuestion(question, delegateData) {
    cliLogger.print(`\x1b[33m❓ [${this.name}] Delegate asks: ${question}\x1b[0m`);

    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    const contextStr = delegateData ? JSON.stringify(delegateData, null, 2) : '(none)';
    const prompt = `A delegate agent you invoked has a question and cannot continue without your answer.

Question: "${question}"

Task context that was given to the delegate:
${contextStr}

Answer this question as the coordinating agent. Be specific and concise.
Return JSON: { "answer": "your answer here" }`;

    const response = await this.llmProvider.callJSON(prompt, this);
    const answer = response?.answer ?? JSON.stringify(response);

    cliLogger.print(`\x1b[33m💬 [${this.name}] Answer: ${answer}\x1b[0m`);
    return answer;
  }

  /**
   * Find a skill that matches the given intent
   */
  findMatchingSkill(intent) {
    if (!this.skills || this.skills.length === 0) {
      return null;
    }

    if (!intent || typeof intent !== 'string') {
      return null;
    }

    const intentLower = intent.toLowerCase();

    // Try exact or partial match
    for (const skill of this.skills) {
      const skillLower = skill.toLowerCase();

      if (intentLower.includes(skillLower) || skillLower.includes(intentLower)) {
        return skill;
      }
    }

    // Try keyword matching
    const keywords = intentLower.split(/\s+/);

    for (const skill of this.skills) {
      const skillLower = skill.toLowerCase();

      for (const keyword of keywords) {
        if (keyword.length > 3 && skillLower.includes(keyword)) {
          return skill;
        }
      }
    }

    return null;
  }

  /**
   * Execute legacy action (fallback for actions without executors)
   * This should rarely be used now - most actions have executors
   */
  async executeLegacyAction(action) {
    throw new Error(`Action type "${action.type}" has no executor registered and no legacy handler`);
  }


  async callSkill(skillName, functionNameOrInput, inputOrUndefined) {
    if (!this.skills.includes(skillName)) {
      throw new Error(`Agent ${this.name} does not have skill: ${skillName}`);
    }

    // Support two calling conventions:
    // 1. callSkill(skillName, functionName, input) - call specific function
    // 2. callSkill(skillName, input) - legacy: find matching function by intent
    let functionName, input;

    if (inputOrUndefined !== undefined) {
      // Convention 1: explicit function name
      functionName = functionNameOrInput;
      input = inputOrUndefined;
    } else {
      // Convention 2: auto-select function (legacy)
      input = functionNameOrInput;

      // Try to find a matching function using skill selector
      // For now, we'll just use the first available function
      const skillFunctions = globalThis.SkillRegistry?.getAll(skillName);
      if (!skillFunctions || Object.keys(skillFunctions).length === 0) {
        throw new Error(`No functions found in skill: ${skillName}`);
      }

      functionName = Object.keys(skillFunctions)[0];
    }

    // Get the function from SkillRegistry
    const skillFunction = globalThis.SkillRegistry?.get(skillName, functionName);

    if (!skillFunction) {
      throw new Error(`Function ${functionName} not found in skill ${skillName}`);
    }

    // Execute the skill function
    try {
      const result = await skillFunction.fn(input);
      return result;
    } catch (error) {
      throw new Error(`Skill ${skillName}.${functionName} failed: ${error.message}`);
    }
  }

  /**
   * Get available skill functions for tool calling
   * Returns an array of { name, fn, description } for each available function
   */
  getSkillFunctions() {
    const functions = [];

    // Access SkillRegistry from global scope (set by transpiled code)
    if (typeof globalThis.SkillRegistry !== 'undefined') {
      for (const skillName of this.skills) {
        const skillFunctions = globalThis.SkillRegistry.getAll(skillName);
        for (const [funcName, { fn, metadata }] of Object.entries(skillFunctions)) {
          functions.push({
            name: funcName,
            fn,
            description: metadata.affordance || `Function from ${skillName} skill`
          });
        }
      }
    }

    return functions;
  }


  /**
   * Get MCP tool summaries for system prompt generation.
   * Returns tool info from all MCP servers this agent has access to.
   */
  getMCPToolsSummary() {
    const mcpRegistry = globalThis.mcpRegistry;
    if (!mcpRegistry || this.usesMCPNames.length === 0) return [];

    const summaries = [];
    for (const mcpName of this.usesMCPNames) {
      const client = mcpRegistry.get(mcpName);
      if (client && client.tools.length > 0) {
        summaries.push({
          name: mcpName,
          tools: client.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema
          }))
        });
      }
    }
    return summaries;
  }

  toString() {
    return `Agent(${this.name}:${this.role.name})`;
  }
}
