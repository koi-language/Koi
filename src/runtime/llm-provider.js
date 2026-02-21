import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { cliLogger } from './cli-logger.js';
import { actionRegistry } from './action-registry.js';
import { classifyFeedback, classifyResponse } from './context-memory.js';
import { costCenter, getModelCaps } from './cost-center.js';
import { DEFAULT_TASK_PROFILE, selectAutoModel, getAvailableProviders } from './auto-model-selector.js';

// Load .env file but don't override existing environment variables
// Silent by default - dotenv will not log unless there's an error
const originalWrite = process.stdout.write;
process.stdout.write = () => {}; // Temporarily silence stdout
dotenv.config({ override: false });
process.stdout.write = originalWrite; // Restore stdout

/**
 * Format prompt text with > prefix for each line (for debug output)
 */
function formatPromptForDebug(text) {
  return text.split('\n').map(line => `> \x1b[90m${line}\x1b[0m`).join('\n');
}

// Default models per provider
const DEFAULT_MODELS = {
  openai:    'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  gemini:    'gemini-2.0-flash',
};

// Short aliases for Anthropic models
const ANTHROPIC_ALIASES = {
  'sonnet':       'claude-sonnet-4-6',
  'sonnet-4':     'claude-sonnet-4-6',
  'opus':         'claude-opus-4-6',
  'opus-4':       'claude-opus-4-6',
  'haiku':        'claude-haiku-4-5-20251001',
  'haiku-4':      'claude-haiku-4-5-20251001',
};

export class LLMProvider {
  constructor(config = {}) {
    const _providerIsAuto = config.provider === 'auto';
    const _modelIsAuto    = config.model === 'auto';
    this._autoMode = _providerIsAuto || _modelIsAuto;
    // When provider is fixed but model is auto, selection is constrained to that provider only
    this._lockedProvider = (!_providerIsAuto && _modelIsAuto) ? config.provider : null;

    this.temperature = config.temperature ?? 0.1; // Low temperature for deterministic results
    this.maxTokens = config.max_tokens || 8000; // Increased to avoid truncation of long responses

    // Auto mode: dynamically pick the best model per task
    if (this._autoMode) {
      this.provider = 'auto';
      this.model = 'auto';
      this.openai = null;
      this.anthropic = null;

      if (this._lockedProvider) {
        // provider fixed, model auto — only use clients for the locked provider
        // Client is created lazily if the key is missing (see _ensureClients).
        this._availableProviders = [this._lockedProvider];
        if (this._lockedProvider === 'openai' && process.env.OPENAI_API_KEY) {
          this._oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        } else if (this._lockedProvider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
          this._ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        } else if (this._lockedProvider === 'gemini' && process.env.GEMINI_API_KEY) {
          this._gc = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
        }
      } else {
        // both provider and model are auto — use all available providers.
        // If no keys are configured yet, _availableProviders stays empty and the
        // user will be prompted on first use (see _ensureClients).
        this._availableProviders = getAvailableProviders();
        if (process.env.OPENAI_API_KEY)    this._oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        if (process.env.ANTHROPIC_API_KEY) this._ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        if (process.env.GEMINI_API_KEY)    this._gc = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
      }
      return;
    }

    this.provider = config.provider || 'openai';

    // Resolve model: alias expansion + per-provider defaults
    let model = config.model;
    if (this.provider === 'anthropic' && model && ANTHROPIC_ALIASES[model]) {
      model = ANTHROPIC_ALIASES[model];
    }
    this.model = model || DEFAULT_MODELS[this.provider];

    // Initialize clients — deferred if key is missing (user will be prompted on first use).
    if (this.provider === 'openai') {
      if (process.env.OPENAI_API_KEY) this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else if (this.provider === 'anthropic') {
      if (process.env.ANTHROPIC_API_KEY) this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else if (this.provider === 'gemini') {
      if (process.env.GEMINI_API_KEY) {
        this.openai = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
      }
    }
  }

  // =========================================================================
  // API KEY MANAGEMENT — lazy client initialization
  // =========================================================================

  /**
   * Ensure all required clients are ready before making any LLM call.
   * Prompts the user for missing API keys, saves them to .env, and creates clients.
   */
  async _ensureClients() {
    if (this._autoMode) {
      if (this._lockedProvider) {
        await this._ensureLockedProviderClient();
      } else {
        await this._ensureAnyProvider();
      }
    } else {
      await this._ensureExplicitClient();
    }
  }

  /**
   * For auto mode with no locked provider: ensure at least one provider client exists.
   * If none are configured, let the user pick a provider and enter the key.
   */
  async _ensureAnyProvider() {
    if (this._availableProviders.length > 0) return;

    const { cliLogger } = await import('./cli-logger.js');
    const { cliSelect } = await import('./cli-select.js');
    const { ensureApiKey } = await import('./api-key-manager.js');

    cliLogger.print('No API key configured. Select a provider to use:');
    const provider = await cliSelect('Select provider', [
      { title: 'OpenAI (GPT-4o, GPT-4o-mini…)', value: 'openai' },
      { title: 'Anthropic (Claude Sonnet, Haiku…)', value: 'anthropic' },
      { title: 'Google Gemini (gemini-2.0-flash…)', value: 'gemini' },
    ]);

    if (!provider) throw new Error('No provider selected — cannot continue without an API key');

    const apiKey = await ensureApiKey(provider);

    if (provider === 'openai') {
      this._oa = new OpenAI({ apiKey });
    } else if (provider === 'anthropic') {
      this._ac = new Anthropic({ apiKey });
    } else if (provider === 'gemini') {
      this._gc = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
    }

    this._availableProviders = [provider];
  }

  /**
   * For auto mode with a locked provider: ensure the client for that provider exists.
   */
  async _ensureLockedProviderClient() {
    const p = this._lockedProvider;
    const hasClient = (p === 'openai' && this._oa) ||
                      (p === 'anthropic' && this._ac) ||
                      (p === 'gemini' && this._gc);
    if (hasClient) return;

    const { ensureApiKey } = await import('./api-key-manager.js');
    const apiKey = await ensureApiKey(p);

    if (p === 'openai') {
      this._oa = new OpenAI({ apiKey });
    } else if (p === 'anthropic') {
      this._ac = new Anthropic({ apiKey });
    } else if (p === 'gemini') {
      this._gc = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
    }
  }

  /**
   * For explicit (non-auto) provider: ensure the client exists.
   */
  async _ensureExplicitClient() {
    if (this.openai || this.anthropic) return;

    const { ensureApiKey } = await import('./api-key-manager.js');
    const apiKey = await ensureApiKey(this.provider);

    if (this.provider === 'openai') {
      this.openai = new OpenAI({ apiKey });
    } else if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey });
    } else if (this.provider === 'gemini') {
      this.openai = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
    }
  }

  /**
   * Format text for debug output with gray color
   */
  formatDebugText(text) {
    const lines = text.split('\n');
    return lines.map(line => `> \x1b[90m${line}\x1b[0m`).join('\n');
  }

  /**
   * Log LLM request (system + user prompts)
   */
  logRequest(model, systemPrompt, userPrompt, context = '') {
    if (process.env.KOI_DEBUG_LLM !== '1') return;

    console.error('─'.repeat(80));
    console.error(`[LLM Debug] Request - Model: ${model}${context ? ' | ' + context : ''}`);
    console.error('System Prompt:');
    console.error(this.formatDebugText(systemPrompt));
    console.error('============');
    console.error('User Prompt:');
    console.error('============');
    console.error(this.formatDebugText(userPrompt));
    console.error('─'.repeat(80));
  }

  /**
   * Log LLM response
   */
  logResponse(content, context = '') {
    if (process.env.KOI_DEBUG_LLM !== '1') return;

    console.error(`\n[LLM Debug] Response${context ? ' - ' + context : ''} (${content.length} chars)`);
    console.error('─'.repeat(80));

    // Try to format JSON for better readability
    let formattedContent = content;
    try {
      const parsed = JSON.parse(content);
      formattedContent = JSON.stringify(parsed, null, 2);
    } catch (e) {
      // Not JSON, use as is
    }

    const lines = formattedContent.split('\n');
    for (const line of lines) {
      console.error(`< \x1b[90m${line}\x1b[0m`);
    }
    console.error('─'.repeat(80));
  }

  /**
   * Log simple message
   */
  logDebug(message) {
    if (process.env.KOI_DEBUG_LLM !== '1') return;
    console.error(`[LLM Debug] ${message}`);
  }

  /**
   * Log error
   */
  logError(message, error) {
    if (process.env.KOI_DEBUG_LLM !== '1') return;
    console.error(`[LLM Debug] ERROR: ${message}`);
    if (error) {
      console.error(error.stack || error.message);
    }
  }

  /**
   * Simple chat completion for build-time tasks (descriptions, summaries).
   * No system prompt injection, no JSON mode, with timeout.
   */
  async simpleChat(prompt, { timeoutMs = 15000 } = {}) {
    await this._ensureClients();
    const messages = [{ role: 'user', content: prompt }];

    if (this.provider === 'openai' || this.provider === 'gemini') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const completion = await this.openai.chat.completions.create(
          this.buildApiParams({
            model: this.model,
            messages,
            temperature: 0.1,
            max_tokens: this.maxTokens || 150
          }),
          { signal: controller.signal }
        );
        return completion.choices[0].message.content?.trim() || '';
      } finally {
        clearTimeout(timer);
      }
    } else if (this.provider === 'anthropic') {
      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: this.maxTokens || 150,
        temperature: 0.1,
        messages
      });
      return message.content[0].text.trim();
    }
    return '';
  }

  /**
   * Call OpenAI with logging
   * @param {Object} options - { model, messages, temperature, max_tokens, stream, response_format }
   * @param {string} context - Context description for logging
   * @returns {Promise} - OpenAI completion response
   */
  async callOpenAI(options, context = '') {
    const { model, messages, temperature = 0, max_tokens = 4000, stream = false, response_format } = options;

    // Extract prompts for logging
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const userPrompt = messages.find(m => m.role === 'user')?.content || '';

    // Log request
    this.logRequest(model, systemPrompt, userPrompt, context);

    // Make API call with buildApiParams to handle gpt-5.2
    const completion = await this.openai.chat.completions.create(
      this.buildApiParams({
        model,
        messages,
        temperature,
        max_tokens,
        stream,
        ...(response_format && { response_format })
      })
    );

    // If not streaming, log response immediately
    if (!stream) {
      const content = completion.choices[0].message.content;
      this.logResponse(content, context);
    }

    return completion;
  }

  /**
   * Strip unsupported params based on model capabilities.
   * Consults MODEL_DB flags: noTemperature, noMaxTokens.
   */
  buildApiParams(baseParams) {
    const caps = getModelCaps(baseParams.model);
    let params = { ...baseParams };
    if (caps.noTemperature) delete params.temperature;
    if (caps.noMaxTokens)   delete params.max_tokens;
    return params;
  }

  async executePlanning(prompt) {
    try {
      let response;

      if (this.provider === 'openai') {
        const completion = await this.openai.chat.completions.create(
          this.buildApiParams({
            model: 'gpt-5.2',  // Force best model for planning
            messages: [
              { role: 'system', content: 'Planning assistant. JSON only.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0,
          })
        );
        response = completion.choices[0].message.content.trim();
      } else if (this.provider === 'anthropic') {
        const completion = await this.anthropic.messages.create({
          model: 'claude-3-haiku-20240307',  // Force fastest Anthropic model
          max_tokens: 800,
          temperature: 0,  // Use 0 for maximum determinism
          messages: [{ role: 'user', content: prompt }],
          system: 'Planning assistant. JSON only.'
        });
        response = completion.content[0].text.trim();
      } else {
        throw new Error(`Unknown provider: ${this.provider}`);
      }

      // Parse JSON
      return JSON.parse(response);
    } catch (error) {
      throw new Error(`Planning failed: ${error.message}`);
    }
  }


  /**
   * Classify a task using the fastest/cheapest available model.
   * Returns { taskType: 'code'|'planning'|'reasoning', difficulty: 1-10 }.
   * Falls back to keyword heuristic if the LLM call fails.
   */
  async _inferTaskProfile(playbookText, args, agentName) {
    const taskDescription = [
      agentName ? `Agent: ${agentName}` : '',
      playbookText || '',
      args ? 'Args: ' + JSON.stringify(args) : ''
    ].filter(Boolean).join('\n').substring(0, 600);

    const prompt = `Reply ONLY with valid JSON (no markdown in the output):
{"taskType":"code"|"planning"|"reasoning","difficulty":1-10}

## TASK TYPE

- **"code"**: writing, editing, debugging, refactoring, analysing or generating code, scripts, queries, configs, tests, or file operations. Includes implementation tasks even if design is required.
- **"planning"**: system design, architecture, task decomposition, requirement analysis, specifications, workflows or strategy definition.
- **"reasoning"**: logic, math, research, classification, summarisation, comparison, or conceptual analysis without producing runnable code.

If multiple apply, choose the dominant expected output.

## DIFFICULTY (be conservative; most tasks are 4-6)

- **1-2 trivial** — print/list/echo/very basic search  
- **3-4 easy** — small edit, simple command, basic explanation  
- **5-6 normal (default)** — implement function, refactor module, write feature, debug non-trivial bug  
- **7-8 hard** — multi-file refactor, system design, API integration, complex algorithm, optimisation, edge cases  
- **9-10 legendary (rare)** — distributed systems, compilers, cryptography, kernel/low-level, novel research, formal proofs  

## ADJUSTMENTS

Increase difficulty (+1 to +3) if involving:
- Significant design decisions  
- Cross-module coordination  
- Complex math  
- Concurrency or distributed systems  
- Security-sensitive logic  
- Strict correctness guarantees  
- High ambiguity  
- Performance-critical constraints  

Decrease difficulty (-1) if:
- Mechanical or obvious solution  
- Highly scoped and routine task  

Default to **5** when unsure.  
Use **9-10** only for genuinely expert-level tasks.

---

Classify the following task:
${taskDescription}`;

    const _debug = !!process.env.KOI_DEBUG_LLM;

    // Ordered fallback candidates for classification (cheapest/fastest first)
    const _candidates = [
      ...(this._gc ? [
        { client: this._gc, model: 'gemini-2.0-flash-lite', provider: 'gemini' },
        { client: this._gc, model: 'gemini-2.0-flash',      provider: 'gemini' },
        { client: this._gc, model: 'gemini-1.5-flash',      provider: 'gemini' },
      ] : []),
      ...(this._oa ? [{ client: this._oa, model: 'gpt-4o-mini', provider: 'openai' }] : []),
      ...(this._ac ? [{ client: null, model: 'claude-haiku-4-5-20251001', provider: 'anthropic' }] : []),
    ];

    if (_candidates.length === 0) {
      if (_debug) console.error(`[Auto] No client for classification — using default profile`);
      return DEFAULT_TASK_PROFILE;
    }

    for (const candidate of _candidates) {
      if (_debug) console.error(`[Auto] Classifying with ${candidate.model}...`);
      try {
        let content, inputTokens = 0, outputTokens = 0;
        if (candidate.provider === 'anthropic') {
          const resp = await this._ac.messages.create({
            model: candidate.model, max_tokens: 50, temperature: 0,
            messages: [{ role: 'user', content: prompt }]
          });
          content = resp.content[0].text.trim();
          inputTokens  = resp.usage?.input_tokens  || 0;
          outputTokens = resp.usage?.output_tokens || 0;
        } else {
          const resp = await candidate.client.chat.completions.create({
            model: candidate.model, max_tokens: 50, temperature: 0,
            messages: [{ role: 'user', content: prompt }]
          });
          content = resp.choices[0].message.content.trim();
          inputTokens  = resp.usage?.prompt_tokens     || 0;
          outputTokens = resp.usage?.completion_tokens || 0;
        }
        costCenter.recordUsage(candidate.model, candidate.provider, inputTokens, outputTokens);
        if (_debug) console.error(`[Auto] Classification: ${content} (${inputTokens}↑ ${outputTokens}↓)`);
        const json = JSON.parse(content);
        if (json.taskType && json.difficulty) {
          const profile = { taskType: json.taskType, difficulty: Math.min(10, Math.max(1, Number(json.difficulty))) };
          if (_debug) console.error(`[Auto] Profile: ${profile.taskType} difficulty=${profile.difficulty}/10`);
          return profile;
        }
        if (_debug) console.error(`[Auto] Invalid shape from ${candidate.model}, trying next...`);
      } catch (e) {
        if (_debug) console.error(`[Auto] ${candidate.model} failed: ${e.message} — trying next...`);
      }
    }
    if (_debug) console.error(`[Auto] All candidates failed — using default profile`);
    return DEFAULT_TASK_PROFILE;
  }

  /**
   * Lightweight JSON call: send a prompt, get parsed JSON back.
   * No system prompt injection, no streaming, no onAction.
   */
  async callJSON(prompt, agent = null) {
    await this._ensureClients();
    const agentName = agent?.name || '';
    cliLogger.planning(agentName ? `[🤖 ${agentName}] Thinking` : 'Thinking');

    this.logRequest(this.model, 'Return ONLY valid JSON.', prompt, agentName ? `callJSON | Agent: ${agentName}` : 'callJSON');

    // In auto mode, use the first available provider for callJSON
    const _cjProvider = this._autoMode ? this._availableProviders[0] : this.provider;
    const _cjModel    = this._autoMode ? (DEFAULT_MODELS[_cjProvider] || this._availableProviders[0]) : this.model;
    const _cjOpenai   = this._autoMode ? (this._oa || this._gc) : this.openai;
    const _cjAnthropic = this._autoMode ? this._ac : this.anthropic;

    let response;
    try {
      if (_cjProvider === 'openai' || _cjProvider === 'gemini') {
        const completion = await _cjOpenai.chat.completions.create(
          this.buildApiParams({
            model: _cjModel,
            messages: [
              { role: 'system', content: 'Return ONLY valid JSON. No markdown, no explanations.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0,
            max_tokens: this.maxTokens,
            response_format: { type: 'json_object' }
          })
        );
        response = completion.choices[0].message.content?.trim() || '';
      } else if (_cjProvider === 'anthropic') {
        const message = await _cjAnthropic.messages.create({
          model: _cjModel,
          max_tokens: this.maxTokens,
          temperature: 0,
          system: 'Return ONLY valid JSON. No markdown, no explanations.',
          messages: [{ role: 'user', content: prompt }]
        });
        response = message.content[0].text.trim();
      } else {
        throw new Error(`Unknown provider: ${_cjProvider}`);
      }

      cliLogger.clear();
      this.logResponse(response, 'callJSON');

      if (!response) return { result: '' };

      // Clean markdown code blocks if present
      let cleaned = response;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^\`\`\`(?:json)?\n?/, '').replace(/\n?\`\`\`$/, '').trim();
      }

      return JSON.parse(cleaned);
    } catch (error) {
      cliLogger.clear();
      if (error instanceof SyntaxError) {
        return { result: response };
      }
      throw error;
    }
  }

  // =========================================================================
  // REACTIVE AGENTIC LOOP METHODS
  // =========================================================================

  /**
   * Execute one iteration of the reactive playbook loop.
   * The LLM returns ONE action per call, receives feedback, and adapts.
   *
   * @param {Object} params
   * @param {string} params.playbook - The playbook text
   * @param {Object} params.context - Context with args and state
   * @param {string} params.agentName - Agent name for logging
   * @param {PlaybookSession} params.session - Session tracking state
   * @param {Object} params.agent - Agent instance
   * @param {ContextMemory} params.contextMemory - Tiered memory manager
   * @returns {Object} A single action object
   */
  async executePlaybookReactive({ playbook, context, agentName, session, agent, contextMemory, isFirstCall = false, thinkingHint = 'Thinking', isDelegate = false, abortSignal = null }) {
    // Ensure API keys / clients are ready (prompts user if missing)
    await this._ensureClients();

    const planningPrefix = agentName ? `[🤖 ${agentName}]` : '';

    // For non-auto mode the model is fixed — show it right away (before LLM call)
    if (!this._autoMode) cliLogger.setInfo('model', this.model);

    cliLogger.planning(`${planningPrefix} ${thinkingHint}`);
    cliLogger.log('llm', `Reactive call: ${agentName} (iteration ${session.iteration + 1}, firstCall=${isFirstCall})`);

    // Age memories each iteration
    await contextMemory.tick();

    // Rebuild system prompt on the first LLM call (isFirstCall) or when context memory
    // has no history yet (fresh start, or after fast-greeting skipped the first LLM call).
    if (isFirstCall || !contextMemory.hasHistory()) {
      // Always rebuild system prompt at session start so the playbook and fresh
      // action docs are included — this also fixes resumed sessions where the
      // old system prompt had no playbook.
      const systemPrompt = await this._buildReactiveSystemPrompt(agent, playbook);
      contextMemory.setSystem(systemPrompt);
    }

    // Decide what message to add based on how many actions have been executed.
    // Use session.iteration (action count) rather than contextMemory.hasHistory() so
    // that the fast-greeting path (which skips the first LLM call but executes
    // print + prompt_user) is treated as "subsequent" rather than "fresh start".
    if (session.iteration === 0) {
      // No actions executed yet — fresh start, resumed session, or task resumption.
      if (session._resumingTasks) {
        // User confirmed they want to continue the pending task plan.
        // Build the task list inline so the model sees it immediately without
        // needing to call task_list first (codex tends to explore/ask otherwise).
        let taskListStr = '';
        try {
          const { taskManager } = await import('./task-manager.js');
          const allTasks = taskManager.list();
          const pending = allTasks.filter(t => t.status !== 'completed');
          if (pending.length > 0) {
            taskListStr = '\n\nPending tasks:\n' + pending.map(t => {
              const icon = t.status === 'in_progress' ? '●' : '☐';
              const desc = t.description ? ` — ${t.description}` : '';
              return `  [${t.id}] ${icon} ${t.subject}${desc}`;
            }).join('\n');
          }
        } catch { /* non-fatal — fall back to generic instruction */ }

        contextMemory.add(
          'user',
          `The user confirmed: resume the previous task plan.${taskListStr}\n\nExecute these tasks now, in order, starting with the first in_progress or pending one. Do NOT ask the user any questions. Do NOT explore files or run any commands before starting. Execute the first task immediately.`,
          'Resume tasks.',
          null
        );
      } else if (contextMemory.hasHistory() && !isDelegate) {
        // Session resumed: tell the LLM to wait for user input (do NOT auto-execute).
        // Delegates are excluded — their prior context is valid working history.
        contextMemory.add(
          'user',
          `CRITICAL — SESSION RESUMED. The conversation history above belongs to a previous session that has ENDED.

You are starting FRESH. You MUST NOT continue, resume, or reference any previous task.

Your ONLY allowed action right now is:
{ "intent": "prompt_user" } — wait for the user to type something new.

ANY other action (print, read_file, search, shell, delegate, grep, etc.) is STRICTLY FORBIDDEN until the user explicitly asks for something new.`,
          'Session resumed.',
          null
        );
      } else {
        const contextStr = Object.keys(context).length > 0
          ? `\nContext: ${JSON.stringify(context)}`
          : '';

        // Include MCP connection errors so the LLM can diagnose
        let mcpErrorStr = '';
        if (session.mcpErrors && Object.keys(session.mcpErrors).length > 0) {
          const errors = Object.entries(session.mcpErrors)
            .map(([name, cause]) => `- MCP "${name}" server output:\n${cause}`)
            .join('\n');
          mcpErrorStr = `\n\n⚠️ MCP SERVER ERRORS — The following MCP servers crashed on startup. Do NOT call them.\nAnalyze the server output below, identify the root cause, and use "print" to tell the user:\n1. What went wrong (the specific error, not the raw output)\n2. How to fix it (e.g. "run npm install in /path/to/project")\nThen "return" with an error.\n\n${errors}`;
        }

        // Playbook is now in the system prompt; first user message just starts execution
        const startMsg = `Return your FIRST action.${contextStr}${mcpErrorStr}`;
        contextMemory.add('user', startMsg, 'Instruction.', null);
      }
    } else {
      // Actions have been executed — use last result as feedback (including after fast-greeting).
      const lastEntry = session.actionHistory[session.actionHistory.length - 1];

      if (lastEntry) {
        const classified = classifyFeedback(lastEntry.action, lastEntry.result, lastEntry.error);

        // Inject relevant commit context when user just spoke (after prompt_user)
        let commitContext = '';
        if (!lastEntry.error) {
          const lastIntent = lastEntry.action.intent || lastEntry.action.type;
          if (lastIntent === 'prompt_user' && lastEntry.result?.answer) {
            commitContext = await this._searchRelevantCommits(lastEntry.result.answer);
            // Also hydrate latent memories
            await contextMemory.hydrate(lastEntry.result.answer);
          }
        }

        // Build the immediate content (full detail + commit context + continue)
        const immediate = `${classified.immediate}${commitContext}\nContinue.`;
        contextMemory.add('user', immediate, classified.shortTerm, classified.permanent);
      }
    }

    // Check abort before making the call
    if (abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Resolve auto model.
    // Re-classify only on first call or when returning from a delegation — not every iteration.
    let _autoRestore = null;
    if (this._autoMode) {
      const _lastAction = session.actionHistory.at(-1);
      const _isDelegateReturn = _lastAction?.action?.actionType === 'delegate';
      const _shouldReclassify = !session._autoProfile || isFirstCall || _isDelegateReturn;

      if (_shouldReclassify) {
        session._autoProfile = await this._inferTaskProfile(playbook, context?.args, agentName);
        if (process.env.KOI_DEBUG_LLM) {
          const _reason = isFirstCall ? 'first call' : _isDelegateReturn ? 'delegate returned' : 'no cached profile';
          console.error(`[Auto] Reclassifying (${_reason})`);
        }
      }
      const profile = session._autoProfile;

      // Escalate difficulty only when the SAME error repeats 3+ times in a row.
      // Different errors mean the model is trying different things — no escalation needed.
      let _sameErrorCount = 0;
      const _lastMsg = session.lastError?.message;
      if (_lastMsg) {
        for (let _i = session.actionHistory.length - 1; _i >= 0; _i--) {
          const _e = session.actionHistory[_i];
          const _msg = _e.error?.message ?? (_e.result?.success === false ? _e.result.error : null);
          if (!_msg) break;           // success entry — stop counting
          if (_msg !== _lastMsg) break; // different error — not a stuck loop
          _sameErrorCount++;
        }
      }
      const _difficultyBoost     = _sameErrorCount >= 3 ? Math.min(Math.floor(_sameErrorCount / 3), 3) : 0;
      const _effectiveDifficulty = Math.min(10, profile.difficulty + _difficultyBoost);

      const selected = selectAutoModel(profile.taskType, _effectiveDifficulty, this._availableProviders);
      const _resolvedProvider = selected?.provider || this._availableProviders[0];
      const _resolvedModel    = selected?.model    || DEFAULT_MODELS[_resolvedProvider];

      const _boostNote = _difficultyBoost > 0 ? ` [escalated +${_difficultyBoost}, same error ×${_sameErrorCount}]` : '';
      cliLogger.log('llm', `[auto] ${agentName || 'agent'} → ${_resolvedProvider}/${_resolvedModel} | ${profile.taskType}:${_effectiveDifficulty}/10${_boostNote}`);
      if (process.env.KOI_DEBUG_LLM) console.error(`[Auto] ${agentName || 'agent'} → ${_resolvedProvider}/${_resolvedModel} (${profile.taskType} ${_effectiveDifficulty}/10${_boostNote})`);

      // Show model in footer immediately (before LLM call)
      cliLogger.setInfo('model', _resolvedModel);

      // Store for cost tracking after the finally block restores this.model → 'auto'
      session._autoProvider = _resolvedProvider;
      session._autoModel    = _resolvedModel;

      // Temporarily set provider/model/client for this call
      _autoRestore = { provider: this.provider, model: this.model, openai: this.openai, anthropic: this.anthropic };
      this.provider  = _resolvedProvider;
      this.model     = _resolvedModel;
      if (_resolvedProvider === 'openai')     this.openai    = this._oa;
      else if (_resolvedProvider === 'gemini') this.openai   = this._gc;
      else if (_resolvedProvider === 'anthropic') this.anthropic = this._ac;
    }

    // Build messages from tiered memory
    const messages = contextMemory.toMessages();
    const msgCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
    cliLogger.log('llm', `Sending to ${this.provider}/${this.model} (${msgCount} messages, last user msg: ${lastUserMsg.length} chars)`);
    cliLogger.log('llm', `Last user msg preview: ${lastUserMsg.substring(0, 300)}${lastUserMsg.length > 300 ? '...' : ''}`);

    let response;
    const _t0 = Date.now();
    try {
      if (this.provider === 'openai') {
        const caps = getModelCaps(this.model);
        if (caps.api === 'responses') {
          response = await this._callOpenAIResponsesReactive(messages, agent, abortSignal);
        } else {
          response = await this._callOpenAIReactive(messages, agent, abortSignal);
        }
      } else if (this.provider === 'gemini') {
        response = await this._callGeminiReactive(messages, agent, abortSignal);
      } else if (this.provider === 'anthropic') {
        response = await this._callAnthropicReactive(messages, agent, abortSignal);
      } else {
        throw new Error(`Unknown provider: ${this.provider}`);
      }
    } finally {
      // Restore auto state so subsequent calls can re-resolve cleanly
      if (_autoRestore) {
        this.provider  = _autoRestore.provider;
        this.model     = _autoRestore.model;
        this.openai    = _autoRestore.openai;
        this.anthropic = _autoRestore.anthropic;
      }
    }
    const _apiMs = Date.now() - _t0;

    const responseText = response.text;
    const usage = response.usage;

    // Use the effective model/provider for cost tracking (resolved from session cache if auto)
    const _effectiveModel    = session._autoModel    || this.model;
    const _effectiveProvider = session._autoProvider || this.provider;

    // Accumulate token usage on session (printed as summary before prompt_user)
    if (!session.tokenAccum) session.tokenAccum = { input: 0, output: 0, calls: 0 };
    session.tokenAccum.input += usage.input;
    session.tokenAccum.output += usage.output;
    session.tokenAccum.calls++;
    // Store last call's usage for per-request display
    session.lastUsage = { input: usage.input, output: usage.output };

    // Record to global cost center
    costCenter.recordUsage(_effectiveModel, _effectiveProvider, usage.input, usage.output, _apiMs);

    cliLogger.log('llm', `Response (${responseText.length} chars, ↑${usage.input} ↓${usage.output} tokens): ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);

    // Parse the response into a single action
    const action = this._parseReactiveResponse(responseText);

    // Add assistant message to memory with classification
    const assistantClassified = classifyResponse(responseText, action);
    contextMemory.add('assistant', assistantClassified.immediate, assistantClassified.shortTerm, assistantClassified.permanent);

    return action;
  }

  /**
   * Search commit embeddings for context relevant to user text.
   * Returns a string to inject into the LLM context, or '' if nothing relevant.
   * @private
   */
  async _searchRelevantCommits(userText) {
    try {
      const { sessionTracker } = await import('./session-tracker.js');
      if (!sessionTracker) return '';

      const { commits } = sessionTracker.loadCommitEmbeddings();
      const hashes = Object.keys(commits);
      if (hashes.length === 0) return '';

      const userEmbedding = await this.getEmbedding(userText);
      if (!userEmbedding) return '';

      const { SessionTracker } = await import('./session-tracker.js');

      // Score each commit
      const allScored = hashes.map(hash => ({
        hash,
        summary: commits[hash].summary,
        score: SessionTracker.cosineSimilarity(userEmbedding, commits[hash].embedding)
      }));

      cliLogger.log('llm', `Commit search: ${allScored.length} commits scored against "${userText.substring(0, 60)}"`);
      for (const c of allScored) {
        cliLogger.log('llm', `  [${c.hash}] score=${c.score.toFixed(3)} ${c.score >= 0.35 ? '✓' : '✗'} "${c.summary}"`);
      }

      const matched = allScored
        .filter(c => c.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (matched.length === 0) {
        cliLogger.log('llm', `Commit search: no matches above threshold (0.35)`);
        return '';
      }

      cliLogger.log('llm', `Commit search: injecting ${matched.length} relevant commit(s)`);

      // Build context with truncated diffs
      const parts = matched.map(c => {
        let diff = '';
        try {
          diff = sessionTracker.getCommitDiff(c.hash);
          if (diff.length > 2048) diff = diff.substring(0, 2048) + '\n... [truncated]';
        } catch { /* no diff */ }
        return `[${c.hash}] "${c.summary}"${diff ? `\nDiff:\n${diff}` : ''}`;
      });

      return `\n\nRELEVANT SESSION CHANGES:\n${parts.join('\n\n')}`;
    } catch (err) {
      cliLogger.log('llm', `Commit search failed: ${err.message}`);
      return '';
    }
  }

  /**
   * Build system prompt for reactive mode.
   * Prepends the agent's playbook (persona/instructions) before the
   * generic execution engine rules and available actions.
   */
  async _buildReactiveSystemPrompt(agent, playbook = null) {
    const base = await this._buildSystemPrompt(agent);
    if (!playbook?.trim()) return base;
    return `${playbook.trim()}\n\n${base}`;
  }

  /**
   * Call OpenAI for a reactive loop iteration.
   * Uses the full conversation history for multi-turn context.
   */
  async _callOpenAIReactive(messages, agent, abortSignal = null) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set in environment');
    }

    const agentInfo = agent ? `Agent: ${agent.name}` : '';
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    this.logRequest(this.model, systemPrompt, messages.filter(m => m.role === 'user').pop()?.content || '', `Reactive ${agentInfo}`);

    cliLogger.log('llm', `HTTP request starting...`);
    let completion;
    try {
      const params = this.buildApiParams({
        model: this.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' }
      });
      const options = abortSignal ? { signal: abortSignal } : {};
      completion = await this.openai.chat.completions.create(params, options);
    } catch (httpError) {
      cliLogger.log('llm', `HTTP request FAILED: ${httpError.message}`);
      throw httpError;
    }
    cliLogger.log('llm', `HTTP request completed`);

    const choice = completion.choices?.[0];
    if (!choice) {
      throw new Error(`OpenAI returned no choices (status: ${completion?.status || 'unknown'}, id: ${completion?.id || 'none'})`);
    }
    const content = choice.message.content?.trim() || '';
    this.logResponse(content, `Reactive ${agentInfo}`);

    return {
      text: content,
      usage: { input: completion.usage?.prompt_tokens || 0, output: completion.usage?.completion_tokens || 0 }
    };
  }

  /**
   * Call OpenAI Responses API (used by codex/reasoning models that don't
   * support the chat completions endpoint).
   */
  async _callOpenAIResponsesReactive(messages, agent, abortSignal = null) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set in environment');
    }

    const agentInfo = agent ? `Agent: ${agent.name}` : '';
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
    this.logRequest(this.model, systemPrompt, lastUserMsg, `Reactive ${agentInfo}`);

    // Build input: user + assistant turns (system becomes instructions)
    let inputMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    // The Responses API requires the word "json" to appear somewhere in the
    // input messages (not just in instructions) when using json_object format.
    // Append a reminder to the last user message if it's missing.
    const lastUserIdx = inputMessages.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx >= 0 && !inputMessages[lastUserIdx].content.toLowerCase().includes('json')) {
      inputMessages = inputMessages.map((m, i) =>
        i === lastUserIdx
          ? { ...m, content: m.content + '\n\nRespond with a valid JSON object only.' }
          : m
      );
    }

    cliLogger.log('llm', `HTTP request starting...`);
    let response;
    try {
      const params = {
        model: this.model,
        instructions: systemPrompt,
        input: inputMessages,
        text: { format: { type: 'json_object' } }
      };
      const options = abortSignal ? { signal: abortSignal } : {};
      response = await this.openai.responses.create(params, options);
    } catch (httpError) {
      cliLogger.log('llm', `HTTP request FAILED: ${httpError.message}`);
      throw httpError;
    }
    cliLogger.log('llm', `HTTP request completed`);

    // Extract text — SDK may expose output_text directly or nested in output array
    const text = response.output_text
      || response.output?.find(o => o.type === 'message')
          ?.content?.find(c => c.type === 'output_text')?.text
      || '';

    this.logResponse(text, `Reactive ${agentInfo}`);

    return {
      text,
      usage: {
        input:  response.usage?.input_tokens  || 0,
        output: response.usage?.output_tokens || 0
      }
    };
  }

  /**
   * Call Anthropic for a reactive loop iteration.
   * Extracts system prompt from sentinel and uses multi-turn messages.
   */
  async _callAnthropicReactive(messages, agent, abortSignal = null) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in environment');
    }

    // Anthropic needs system prompt separate from messages
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    // Append a JSON-only reminder to the last user message.
    // Anthropic models tend to add preamble text in long conversations despite
    // system prompt instructions — a reminder on the last user turn is much more effective.
    const lastUserIdx = chatMessages.map(m => m.role).lastIndexOf('user');
    const messagesWithReminder = chatMessages.map((m, i) =>
      i === lastUserIdx
        ? { ...m, content: m.content + '\n\nRespond with ONLY a valid JSON object. No text, no explanation, no preamble. Start with {' }
        : m
    );

    const agentInfo = agent ? `Agent: ${agent.name}` : '';
    this.logRequest(this.model, systemPrompt, messagesWithReminder.filter(m => m.role === 'user').pop()?.content || '', `Reactive ${agentInfo}`);

    const createParams = {
      model: this.model,
      max_tokens: 8192,
      temperature: 0,
      system: systemPrompt,
      messages: messagesWithReminder
    };
    const message = abortSignal
      ? await this.anthropic.messages.create(createParams, { signal: abortSignal })
      : await this.anthropic.messages.create(createParams);

    if (!message.content?.[0]) {
      throw new Error(`Anthropic returned no content (id: ${message?.id || 'none'})`);
    }
    const content = message.content[0].text.trim();
    this.logResponse(content, `Reactive ${agentInfo}`);

    return {
      text: content,
      usage: { input: message.usage?.input_tokens || 0, output: message.usage?.output_tokens || 0 }
    };
  }

  /**
   * Call Gemini for a reactive loop iteration.
   * Uses the OpenAI SDK pointed at Gemini's OpenAI-compatible API.
   */
  async _callGeminiReactive(messages, agent, abortSignal = null) {
    const agentInfo = agent ? `Agent: ${agent.name}` : '';
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    this.logRequest(this.model, systemPrompt, messages.filter(m => m.role === 'user').pop()?.content || '', `GeminiReactive ${agentInfo}`);

    const geminiParams = this.buildApiParams({
      model: this.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' }
    });
    const geminiOptions = abortSignal ? { signal: abortSignal } : {};
    const completion = await this.openai.chat.completions.create(geminiParams, geminiOptions);

    const geminiChoice = completion.choices?.[0];
    if (!geminiChoice) {
      throw new Error(`Gemini returned no choices`);
    }
    const content = geminiChoice.message.content?.trim() || '';
    this.logResponse(content, `GeminiReactive ${agentInfo}`);

    return {
      text: content,
      usage: { input: completion.usage?.prompt_tokens || 0, output: completion.usage?.completion_tokens || 0 }
    };
  }

  /**
   * Parse the LLM response from reactive mode into a single action object.
   * Handles edge cases like markdown wrapping or legacy array format.
   */
  _parseReactiveResponse(responseText) {
    // Clean markdown code blocks
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    // Strip preamble: some models (e.g. Anthropic) write reasoning text before the JSON.
    // Find the first { and discard everything before it.
    const braceIdx = cleaned.indexOf('{');
    if (braceIdx > 0) cleaned = cleaned.substring(braceIdx);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Fallback 1: LLM returned multiple JSON objects on separate lines
      const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
      if (lines.length > 1) {
        try {
          const actions = lines.map(l => JSON.parse(l));
          return actions.map(a => this._normalizeReactiveAction(a));
        } catch (e2) {
          // Fall through
        }
      }
      // Fallback 2: concatenated objects without newline: {...}{...}
      try {
        const asArray = JSON.parse(`[${cleaned.replace(/\}\s*\{/g, '},{')}]`);
        if (Array.isArray(asArray) && asArray.length > 0) {
          return asArray.map(a => this._normalizeReactiveAction(a));
        }
      } catch (e3) {
        // Fall through
      }
      // Fallback 3: truncated response — try to parse just the first complete JSON object
      const firstObjMatch = cleaned.match(/^\{[\s\S]*?\}(?=\s*[\{$]|\s*$)/);
      if (firstObjMatch) {
        try {
          const firstObj = JSON.parse(firstObjMatch[0]);
          return this._normalizeReactiveAction(firstObj);
        } catch (e4) {
          // Fall through
        }
      }
      throw new Error(`Failed to parse reactive LLM response as JSON: ${e.message}\nResponse: ${cleaned.substring(0, 200)}`);
    }

    // Handle batched actions: { "batch": [action1, action2, ...] }
    // Items may be regular actions OR { "parallel": [...] } groups.
    if (parsed.batch && Array.isArray(parsed.batch) && parsed.batch.length > 0) {
      this.logDebug(`Reactive response batched ${parsed.batch.length} actions`);
      const actions = parsed.batch.map(a => this._normalizeBatchItem(a));
      return actions.length === 1 ? actions[0] : actions;
    }

    // Handle raw array (in case json_object mode is not used)
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        throw new Error('Reactive response was an empty array');
      }
      const actions = parsed.map(a => this._normalizeReactiveAction(a));
      return actions.length === 1 ? actions[0] : actions;
    }

    // If LLM returned legacy format { "actions": [...] }, extract as batch
    if (parsed.actions && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      this.logDebug('Reactive response used legacy {actions:[...]} format, extracting as batch');
      const actions = parsed.actions.map(a => this._normalizeReactiveAction(a));
      return actions.length === 1 ? actions[0] : actions;
    }

    return this._normalizeReactiveAction(parsed);
  }

  /**
   * Normalize a single item from a batch array.
   * If it's a { parallel: [...] } group, normalize each inner action.
   * Otherwise treat it as a regular action.
   */
  _normalizeBatchItem(item) {
    if (item && Array.isArray(item.parallel)) {
      return { parallel: item.parallel.map(a => this._normalizeReactiveAction(a)) };
    }
    return this._normalizeReactiveAction(item);
  }

  /**
   * Normalize a single action object from a reactive response.
   */
  _normalizeReactiveAction(parsed) {
    // Safety net: if actionType is not "direct"/"delegate", the LLM put the intent there
    if (parsed.actionType && parsed.actionType !== 'direct' && parsed.actionType !== 'delegate') {
      if (!parsed.intent) {
        parsed.intent = parsed.actionType;
      }
      parsed.actionType = 'direct';
    }

    // Validate minimal structure — if no action fields, treat as raw return data
    if (!parsed.intent && !parsed.actionType && !parsed.type) {
      if (Object.keys(parsed).length > 0) {
        this.logDebug('Reactive response was raw data, wrapping as return action');
        return { actionType: 'direct', intent: 'return', data: parsed };
      }
      throw new Error(`Invalid reactive action: missing "intent" or "actionType". Got: ${JSON.stringify(parsed).substring(0, 200)}`);
    }

    return parsed;
  }

  // =========================================================================
  // UNIFIED SYSTEM PROMPT - shared rules for all execution modes
  // =========================================================================

  /**
   * Build the system prompt for all agents.
   * Single unified prompt — only the available intents change per agent.
   * @param {Agent} agent - The agent
   * @returns {string} Complete system prompt
   */
  async _buildSystemPrompt(agent) {
    const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;
    const resourceSection = await this._buildSmartResourceSection(agent);
    const intentNesting = hasTeams ? '\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.' : '';
    const koiMd = this._loadKoiMd();

    return `
# OUTPUT FORMAT INSTRUCTIONS:

Convert user instructions into executable JSON actions using ONLY the actions and agents listed in AVAILABLE ACTIONS and AVAILABLE AGENTS.

ABSOLUTE OUTPUT RULE:
- Your entire response MUST be a single valid JSON object.
- Output ONLY JSON. No markdown. No explanations. No extra text.
- The response MUST start with { and end with }.
- If you output anything else, the system will crash.

ACTION FORMAT:
- Single action:
  { "actionType": "direct", "intent": "<actionName>", ... }

- Delegate to agent:
  { "actionType": "delegate", "intent": "agentKey::eventName", "data": { ... } }

- Multiple actions — ALWAYS group independent actions in parallel:
  { "batch": [ { action1 }, { "parallel": [ { action2 }, { action3 }, { action4 } ] }, { action5 } ] }
  → action1 runs first, then action2+action3+action4 run CONCURRENTLY, then action5 once all finish.
  RULE: if two or more actions do not depend on each other's output, they MUST go inside a "parallel" block.
  NEVER put independent actions sequentially in a batch — always parallelize them.
  EXCEPTION: prompt_user must NEVER be inside a parallel block — it waits for user input and must always be a standalone sequential action.

REQUIREMENTS:
- "actionType" and "intent" are ALWAYS required.
- Do NOT nest "intent" inside "data".
- Delegate intents MUST follow: agentKey::eventName.

EXECUTION FLOW:
- Return ONE JSON object per step: either a single action or a { "batch": [...] } with multiple steps.
- After each response, you receive the results and decide the next step.
- Continue step-by-step until the task is fully completed.
- Only when EVERYTHING is done, return: { "actionType": "direct", "intent": "return", "data": { ... } }
- CRITICAL: Static content (headers, banners, labels) that does NOT depend on any result MUST be included in the FIRST response — never deferred to a later step. Combine them in a batch with other first actions.
- If you are a delegate agent and have a doubt you cannot resolve by reading the codebase, use: { "actionType": "direct", "intent": "ask_parent", "question": "..." }. The runtime will ask the invoking agent and re-call you with args.answer set to the response.
- If args.answer is present, it is the parent agent's answer to your previous ask_parent — use it to continue.

RULES:
1. Never answer in natural language.
2. Never explain reasoning.
3. Never describe what you will do — execute it.
4. If an action fails, choose a different valid action — EXCEPT for "command not found" / exit code 127, which must be handled by rule 11, not skipped.
5. If the user denies permission (🚫), do not retry the same action.
6. If instructions say to repeat N times, execute ALL N iterations.
7. Do not duplicate content (e.g., do not print before prompt_user).
8. PARALLELISM IS MANDATORY: within a batch, whenever 2 or more actions do not depend on each other's output, they MUST go inside a "parallel" block. It is WRONG to list independent actions sequentially in a batch — always parallelize them. EXCEPTION: prompt_user is always sequential and must never be in a parallel block.
9. NEVER return before ALL steps are done. Delegating/reading/exploring is NOT completing a task — you must also execute every follow-up action (edits, writes, prints, etc.) that the task requires. Only emit { "intent": "return" } when every required change has been applied and verified.
10. ONE QUESTION PER prompt_user: Never list multiple questions in a single prompt_user. If you need N pieces of information, use N sequential prompt_user actions, one question each. After the last answer, continue with the next step — do NOT add a "submit" or summary prompt.
11. ⚠️ MISSING TOOLS (overrides rule 4): If any shell command returns "command not found" or exit code 127, the required tool is not installed. You MUST immediately stop the current task and use prompt_user (with options ["Yes", "No"]) to ask the user for permission to install it. Example: { "intent": "prompt_user", "prompt": "Flutter is not installed. Install it now? (brew install flutter) → ", "options": ["Yes", "No"] }. If Yes, install it first, then continue the original task. If No, tell the user what to install and stop. Never skip this step and continue with the task.
12. QUESTIONS: When gathering information from the user, always use prompt_user with a "question" field. The question is displayed above the input area. Never use a preceding print to show a question. Example: { "intent": "prompt_user", "question": "What is the app's main purpose?" }
14. BACKGROUND PROCESSES: Commands that launch apps, emulators, or dev servers (e.g. "flutter run", "open -a Simulator", "npm start", "python server.py") MUST use "background": true in the shell action. These processes run indefinitely — do not wait for them to finish.
13. NEVER ask the user something you can verify yourself with a shell command or file read. Run the check first, then act on the result. Examples: do NOT ask "Is Flutter installed?" — run "which flutter" or "flutter --version". Do NOT ask "Does this file exist?" — read it. Only ask the user for things that are genuinely unknowable without their input (e.g. project name, desired behavior, credentials).

All available capabilities are defined below. Use them exactly as specified.

${resourceSection}${intentNesting}

CRITICAL: Return a single JSON action or { "batch": [...] } for multiple actions. No markdown. Remember: static headers/labels go in the FIRST response; parallelize independent actions; never return until ALL steps are done.${koiMd}`;

  }

  /**
   * Load KOI.md from the project root (cwd) if it exists.
   * Similar to CLAUDE.md — project-specific instructions appended to the system prompt.
   */
  _loadKoiMd() {
    const candidates = [
      path.join(process.cwd(), 'KOI.md'),
      path.join(process.cwd(), 'koi.md'),
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (content) {
            return `\n\nPROJECT INSTRUCTIONS (from KOI.md):\n${content}`;
          }
        } catch { /* ignore read errors */ }
      }
    }
    return '';
  }

  // =========================================================================
  // SMART RESOURCE SECTION
  // =========================================================================

  /**
   * Build a smart resource section for system prompts.
   * THE RULE:
   *   - If total intents across ALL resources <= 25: show everything (1-step)
   *   - If total > 25: collapse resources with > 3 intents to summaries (2-step)
   *
   * @param {Agent} agent - The agent
   * @returns {string} Resource documentation for system prompt
   */
  async _buildSmartResourceSection(agent) {
    // 1. Collect ALL resources with their intents
    const resources = [];

    // Direct actions (from action registry)
    const directActions = actionRegistry.getAll().filter(a => {
      if (a.hidden) return false;
      if (!a.permission) return true;
      return agent.hasPermission(a.permission);
    });
    if (directActions.length > 0) {
      resources.push({
        type: 'direct',
        name: 'Built-in Actions',
        intents: directActions.map(a => ({
          name: a.intent || a.type,
          description: a.description,
          schema: a.schema,
          _actionDef: a
        }))
      });
    }

    // Team members (delegation targets)
    const peerIntents = this._collectPeerIntents(agent);
    for (const peer of peerIntents) {
      resources.push({
        type: 'delegate',
        name: peer.agentName,
        agentPureName: peer.agentPureName,
        agentDescription: peer.agentDescription,
        intents: peer.handlers.map(h => ({
          name: h.name,
          description: h.description,
          params: h.params
        }))
      });
    }

    // MCP servers
    const mcpSummaries = agent.getMCPToolsSummary?.() || [];
    for (const mcp of mcpSummaries) {
      resources.push({
        type: 'mcp',
        name: mcp.name,
        intents: mcp.tools.map(t => ({
          name: t.name,
          description: t.description || t.name,
          inputSchema: t.inputSchema
        }))
      });
    }

    // 2. Count total intents
    const totalIntents = resources.reduce((sum, r) => sum + r.intents.length, 0);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[SmartPrompt] Total intents: ${totalIntents} across ${resources.length} resources`);
      for (const r of resources) {
        console.error(`  [${r.type}] ${r.name}: ${r.intents.length} intents`);
      }
    }

    // Always expand all resources (1-step)
    return this._buildExpandedResourceSection(resources, agent);
  }

  /**
   * Collect peer intents (handler names + descriptions) from accessible teams.
   * @param {Agent} agent
   * @returns {Array<{agentName, handlers: Array<{name, description}>}>}
   */
  _collectPeerIntents(agent) {
    const result = [];
    const processedAgents = new Set();

    const collectFrom = (memberKey, member, teamName) => {
      if (!member || member === agent || processedAgents.has(member.name)) return;
      processedAgents.add(member.name);

      if (!member.handlers || Object.keys(member.handlers).length === 0) return;

      const handlers = [];
      for (const [handlerName, handlerFn] of Object.entries(member.handlers)) {
        let description = `Handle ${handlerName}`;
        let params = [];

        // Prefer LLM-generated description from build cache
        if (handlerFn?.__description__) {
          description = handlerFn.__description__;
        } else if (handlerFn?.__playbook__) {
          // Fallback: first line of playbook
          const firstLine = handlerFn.__playbook__.split('\n')[0].trim();
          description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 80);
        }

        // Extract required params from ${args.X} patterns in playbook
        if (handlerFn?.__playbook__) {
          const paramMatches = handlerFn.__playbook__.matchAll(/\$\{args\.(\w+)/g);
          params = [...new Set([...paramMatches].map(m => m[1]))];
        }

        handlers.push({ name: handlerName, description, params });
      }

      result.push({
        agentName: teamName ? `${memberKey} (${teamName})` : memberKey,
        agentPureName: memberKey,
        agentDescription: member.description || null,
        handlers
      });
    };

    // Peers team
    if (agent.peers?.members) {
      for (const [name, member] of Object.entries(agent.peers.members)) {
        collectFrom(name, member, agent.peers.name);
      }
    }

    // Uses teams
    for (const team of (agent.usesTeams || [])) {
      if (team?.members) {
        for (const [name, member] of Object.entries(team.members)) {
          collectFrom(name, member, team.name);
        }
      }
    }

    return result;
  }

  /**
   * Build expanded resource section - show all intents directly.
   * This is the normal behavior when total intents <= 25.
   */
  _buildExpandedResourceSection(resources, agent) {
    let doc = '';

    // ── AVAILABLE ACTIONS ───────────────────────────────────────────────────
    for (const resource of resources) {
      if (resource.type === 'direct') {
        doc += actionRegistry.generatePromptDocumentation(agent);
      }
    }

    // ── AVAILABLE AGENTS ────────────────────────────────────────────────────
    const delegateResources = resources.filter(r => r.type === 'delegate');
    if (delegateResources.length > 0) {
      doc += '## AVAILABLE AGENTS\n\n';
      for (const resource of delegateResources) {
        doc += `### ${resource.agentPureName}\n`;
        if (resource.agentDescription) {
          doc += `${resource.agentDescription}\n`;
        }
        for (const handler of resource.intents) {
          doc += ` - ${handler.name}: ${handler.description}\n`;
          if (handler.params?.length > 0) {
            doc += `    In: { ${handler.params.map(p => `"${p}"`).join(', ')} }\n`;
          }
        }
        doc += '\n';
      }
    }

    // ── AVAILABLE MCP TOOLS ─────────────────────────────────────────────────
    const mcpResources = resources.filter(r => r.type === 'mcp');
    if (mcpResources.length > 0) {
      doc += '## AVAILABLE MCP TOOLS\n\n';
      for (const resource of mcpResources) {
        doc += `### ${resource.name}\n`;
        for (const tool of resource.intents) {
          doc += ` - ${tool.name}: ${tool.description || tool.name}\n`;
          if (tool.inputSchema?.properties) {
            const keys = Object.keys(tool.inputSchema.properties);
            if (keys.length > 0) doc += `    In: ${keys.map(k => `"${k}"`).join(', ')}\n`;
          }
        }
        doc += '\n';
      }
    }

    // ── INVOCATION SYNTAX ───────────────────────────────────────────────────
    doc += '---\n';
    doc += 'To execute an action:\n';
    doc += '{ "actionType": "direct", "intent": "print", "message": "Hello" }\n\n';

    if (delegateResources.length > 0) {
      const ex = delegateResources[0];
      const exEvent = ex.intents[0]?.name ?? 'handle';
      doc += 'To call an agent:\n';
      doc += `{ "actionType": "delegate", "intent": "${ex.agentPureName}::${exEvent}", "data": { ... } }\n\n`;
      doc += 'The intent for a delegate action must use the format agentKey::eventName\n';
    }

    return doc;
  }

  // =========================================================================
  // COMPOSE PROMPT EXECUTION
  // =========================================================================

  /**
   * Execute a compose block: call an LLM to dynamically assemble a prompt
   * from named fragments, optionally calling runtime actions (e.g. task_list)
   * to make the decision.
   *
   * @param {Object} composeDef - { fragments, rules, model }
   * @param {Agent} agent - The agent requesting composition
   * @returns {string} The assembled prompt text
   */
  /**
   * Infer the LLM provider from a model name.
   * Used by executeCompose when a model is explicitly specified.
   */
  static _inferProviderFromModel(model) {
    if (!model) return 'openai';
    if (model.startsWith('gemini-')) return 'gemini';
    if (model.startsWith('claude-')) return 'anthropic';
    // gpt-*, o1*, o3*, o4*, codex → openai
    return 'openai';
  }

  async executeCompose(composeDef, agent) {
    const { fragments, rules, model } = composeDef;

    // Build a provider for compose: if a model is specified, infer its provider
    // from the model name (don't inherit the agent's provider blindly).
    const provider = model
      ? new LLMProvider({ provider: LLMProvider._inferProviderFromModel(model), model })
      : this;

    // Resolve fragment values (may be strings or functions from parameterized prompts)
    const resolvedFragments = {};
    for (const [name, value] of Object.entries(fragments)) {
      resolvedFragments[name] = typeof value === 'function' ? value() : (value || '');
    }

    // Build available actions list for the compose LLM
    const directActions = actionRegistry.getAll().filter(a => {
      if (a.hidden) return false;
      if (!a.permission) return true;
      return agent.hasPermission(a.permission);
    });
    const actionDocs = directActions
      .map(a => `- ${a.intent || a.type}: ${a.description || ''}`)
      .join('\n');

    // Only expose fragment names — the LLM selects them, the code assembles the text.
    // This avoids asking the LLM to reproduce potentially huge fragment contents.
    const fragmentNames = Object.keys(resolvedFragments).join(', ');

    const systemPrompt = `You are a prompt composer. Select which fragments to include based on runtime context.

## AVAILABLE FRAGMENTS
${fragmentNames}

## AVAILABLE ACTIONS (call these to gather context before deciding)
${actionDocs}

## COMPOSITION RULES
${rules}

## OUTPUT FORMAT
- To call an action first: { "call": "action_name", "data": {} }
- When ready to decide: { "include": ["fragmentName1", "fragmentName2"] }
  List fragment names in order. Only use names from AVAILABLE FRAGMENTS.
Output ONLY valid JSON.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Compose now.' }
    ];

    const MAX_STEPS = 5;
    for (let i = 0; i < MAX_STEPS; i++) {
      const response = await provider._callJSONWithMessages(messages);

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Compose] Step ${i + 1}:`, JSON.stringify(response));
      }

      if (response.include && Array.isArray(response.include)) {
        // Assemble only the selected fragments in the specified order
        const assembled = response.include
          .filter(name => resolvedFragments[name] !== undefined)
          .map(name => resolvedFragments[name])
          .join('\n\n');
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Compose] Selected fragments: ${response.include.join(', ')}`);
        }
        return assembled;
      }

      if (response.call) {
        const actionDef = actionRegistry.get(response.call);
        if (actionDef) {
          const result = await actionDef.execute(
            { intent: response.call, ...(response.data || {}) },
            agent
          );
          messages.push({ role: 'assistant', content: JSON.stringify(response) });
          messages.push({
            role: 'user',
            content: `Action "${response.call}" returned: ${JSON.stringify(result)}\n\nNow output your fragment selection.`
          });
        } else {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Compose] Unknown action: ${response.call}`);
          }
          break;
        }
      } else {
        // Unexpected response shape — break to fallback
        if (process.env.KOI_DEBUG_LLM) {
          console.error('[Compose] Unexpected response shape, falling back:', JSON.stringify(response));
        }
        break;
      }
    }

    // Fallback: concatenate all fragments
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[Compose] Falling back to concatenated fragments');
    }
    return Object.values(resolvedFragments).join('\n\n');
  }

  /**
   * Call the LLM with a full messages array and return a parsed JSON object.
   * Used by executeCompose for multi-turn composition.
   *
   * @param {Array} messages - Array of { role, content } message objects
   * @returns {Object} Parsed JSON response
   */
  async _callJSONWithMessages(messages) {
    try {
      if (this.provider === 'openai' || this.provider === 'gemini') {
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: 4096,
          response_format: { type: 'json_object' }
        });
        return JSON.parse(completion.choices[0].message.content?.trim() || '{}');
      } else if (this.provider === 'anthropic') {
        const [sys, ...rest] = messages;
        const msg = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: 4096,
          temperature: 0,
          system: sys.content,
          messages: rest
        });
        return JSON.parse(msg.content[0].text.trim());
      }
    } catch (e) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error('[Compose] _callJSONWithMessages error:', e.message);
      }
      return {};
    }
    return {};
  }

  /**
   * Generate embeddings for semantic search
   * Uses OpenAI's text-embedding-3-small for fast, cheap embeddings
   */
  async getEmbedding(text) {
    // Validate input
    if (!text || typeof text !== 'string' || text.trim() === '') {
      throw new Error('getEmbedding requires non-empty text input');
    }

    if (this.provider === 'openai' || this.provider === 'anthropic' || this.provider === 'gemini' || this.provider === 'auto') {
      // Always use OpenAI for embeddings (Anthropic/Gemini don't have compatible embeddings API)
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY required for embeddings');
      }

      // Use a dedicated OpenAI client for embeddings (Gemini's openai client points elsewhere)
      if (!this._embeddingClient) {
        this._embeddingClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      }

      try {
        const response = await this._embeddingClient.embeddings.create({
          model: 'text-embedding-3-small',
          input: text.trim()
        });

        return response.data[0].embedding;
      } catch (error) {
        console.error(`[LLM] Error generating embedding:`, error.message);
        throw error;
      }
    }

    throw new Error(`Embeddings not supported for provider: ${this.provider}`);
  }
}
