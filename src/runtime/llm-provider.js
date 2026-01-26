import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { cliLogger } from './cli-logger.js';
import { actionRegistry } from './action-registry.js';
import { IncrementalJSONParser } from './incremental-json-parser.js';

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

export class LLMProvider {
  constructor(config = {}) {
    this.provider = config.provider || 'openai';
    this.model = config.model;
    this.temperature = config.temperature ?? 0.1; // Low temperature for deterministic results
    this.maxTokens = config.max_tokens || 8000; // Increased to avoid truncation of long responses

    // Initialize clients
    if (this.provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error('\n⚠️  OPENAI_API_KEY not found!');
        console.error('   Set it as environment variable or create a .env file\n');
        throw new Error('OPENAI_API_KEY is required for OpenAI provider');
      }
      this.openai = new OpenAI({ apiKey });
    } else if (this.provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error('\n⚠️  ANTHROPIC_API_KEY not found!');
        console.error('   Set it as environment variable or create a .env file\n');
        throw new Error('ANTHROPIC_API_KEY is required for Anthropic provider');
      }
      this.anthropic = new Anthropic({ apiKey });
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
   * Build API parameters, excluding max_tokens for gpt-5.2
   */
  buildApiParams(baseParams) {
    // gpt-5.2 doesn't accept max_tokens parameter
    if (baseParams.model === 'gpt-5.2') {
      const { max_tokens, ...paramsWithoutMaxTokens } = baseParams;
      return paramsWithoutMaxTokens;
    }
    return baseParams;
  }

  async executePlanning(prompt) {
    try {
      let response;

      if (this.provider === 'openai') {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-5.2',  // Force best model for planning
          messages: [
            {
              role: 'system',
              content: 'Planning assistant. JSON only.'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0
        });
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

  async executePlaybook(playbook, context = {}, agentName = null, tools = [], agent = null, fromDelegation = false, onAction = null) {
    // Show planning animation while LLM is thinking
    // Format: [🤖 AgentName] Thinking...
    const planningPrefix = agentName ? `[🤖 ${agentName}]` : '';
    cliLogger.planning(`${planningPrefix} Thinking`);

    // Build prompt with context - but keep it minimal
    const contextStr = Object.keys(context).length > 0
      ? `\n\nContext: ${JSON.stringify(context)}\n`
      : '';

    const prompt = `${playbook}${contextStr}

Respond with ONLY valid JSON.`;

    try {
      let response;

      // Use streaming if onAction callback is provided AND no tools
      // (Tools currently don't support streaming)
      const useStreaming = onAction && (!tools || tools.length === 0);

      if (this.provider === 'openai') {
        if (useStreaming) {
          // hasTeams should only be true if agent can delegate to others
          const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;
          response = await this.executeOpenAIStreaming(prompt, fromDelegation, hasTeams, playbook.length, agent, onAction);
        } else {
          response = await this.executeOpenAIWithTools(prompt, tools, agent, fromDelegation, playbook.length);
        }
      } else if (this.provider === 'anthropic') {
        if (useStreaming) {
          response = await this.executeAnthropicStreaming(prompt, agent, onAction);
        } else {
          response = await this.executeAnthropic(prompt, agent);
        }
      } else {
        throw new Error(`Unknown provider: ${this.provider}`);
      }

      // Check for empty response
      if (!response || response.trim() === '') {
        cliLogger.clear();
        console.error('[LLM] Warning: Received empty response from LLM');
        return { actions: [] };
      }

      // Clear planning animation
      cliLogger.clear();

      // Clean markdown code blocks if present
      let cleanedResponse = response.trim();
      if (cleanedResponse.startsWith('```')) {
        // Remove ```json or ``` from start and ``` from end
        cleanedResponse = cleanedResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      }

      // Try to parse as JSON
      try {
        let parsed = JSON.parse(cleanedResponse);

        // Unwrap double-escaped JSON in "result" field (common LLM mistake)
        while (parsed.result && typeof parsed.result === 'string') {
          const trimmedResult = parsed.result.trim();
          if (trimmedResult.startsWith('{') || trimmedResult.startsWith('[')) {
            try {
              parsed = JSON.parse(trimmedResult);
            } catch (e) {
              // Can't parse inner - stop unwrapping
              break;
            }
          } else {
            // Not JSON - stop unwrapping
            break;
          }
        }

        return parsed;
      } catch (e) {
        console.error('[LLM] Warning: Failed to parse response as JSON');
        console.error(`[LLM] Parse error: ${e.message}`);
        console.error(`[LLM] Response (${cleanedResponse.length} chars): ${cleanedResponse.substring(0, 500)}`);
        if (cleanedResponse.length > 500) {
          console.error(`[LLM] Response end: ...${cleanedResponse.substring(cleanedResponse.length - 200)}`);
        }
        // If parsing fails, return as result
        return { result: cleanedResponse };
      }
    } catch (error) {
      cliLogger.clear();
      cliLogger.error(`[LLM] Error: ${error.message}`);
      if (process.env.KOI_DEBUG_LLM) {
        console.error('[LLM] Full error stack:', error.stack);
      }
      throw error;
    }
  }

  async executeOpenAI(prompt, fromDelegation = false, hasTeams = false, promptLength = 0, agent = null) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set in environment');
    }

    const delegationNote = fromDelegation
      ? '\n\nCRITICAL: You are a specialized worker agent. DO NOT return actions, execute your task DIRECTLY.'
      : '';

    const teamDelegationNote = hasTeams
      ? `\n\nIMPORTANT: You have team members available. When tasks involve specialized capabilities (like registry operations, data processing, etc.), use "intent" or "description" fields to delegate to team members instead of using low-level action types. The router will automatically find the right team member based on semantic similarity.

CRITICAL: When delegating work that involves MULTIPLE items (e.g., "create these 6 users"):
- Generate ONE delegation action PER ITEM
- Each action should contain the data for THAT SPECIFIC ITEM ONLY
- Example for "create Alice (id=001) and Bob (id=002)":
  { "title": "Create Alice", "intent": "create user", "data": { "id": "001", "name": "Alice", ... } },
  { "title": "Create Bob", "intent": "create user", "data": { "id": "002", "name": "Bob", ... } }
- NEVER group multiple items into one action unless the handler explicitly expects an array`
      : '';

    const systemPrompt = `Convert playbook to JSON actions.

OUTPUT: { "actions": [...] }

CRITICAL RULES:
1. Dynamic content (random/relacionado/based on) → call_llm FIRST, then use \${id.output.result}
2. Loops: "hasta que se despida" → while with llm_eval condition
3. Loop structure: initial question BEFORE while → registry_set BEFORE while → while loop (registry_get → call_llm → prompt_user → registry_set → print)
4. IDs: Add "id" only when you'll reference \${id.output} later
5. Template variables ONLY in strings: "text \${var}" not \${var}
6. Group consecutive prints with \\n
7. User feedback: Add "desc" field in English gerund form WITHOUT trailing dots. Make it natural and conversational, NOT technical/explicit (e.g., "Analyzing your response", "Processing your message", "Understanding what you said"). Avoid exposing implementation details. Animated spinner added automatically. If omitted, shows "Thinking"

WHILE LOOP EXAMPLE:
{ "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
{ "intent": "registry_set", "key": "last", "value": "\${a1.output.answer}" },
{ "intent": "while",
  "condition": { "llm_eval": true, "desc": "Processing your response", "instruction": "¿Continuar? (false si despedida)", "data": "\${a3.output.answer}" },
  "actions": [
    { "id": "prev", "intent": "registry_get", "key": "last" },
    { "id": "a2", "intent": "call_llm", "desc": "Thinking of next question", "data": {"answer":"\${prev.output.value}"}, "instruction": "Generate question related to answer" },
    { "id": "a3", "intent": "prompt_user", "question": "\${a2.output.result}" },
    { "intent": "registry_set", "key": "last", "value": "\${a3.output.answer}" },
    { "intent": "print", "message": "Interesante: \${a3.output.answer}" }
  ]
}
CRITICAL: condition.data MUST be the ID from prompt_user INSIDE the loop (a3), NOT from outside (a1)

Available actions:
${actionRegistry.generatePromptDocumentation(agent)}
${hasTeams && agent ? agent.getPeerCapabilitiesAsActions() : ''}

${hasTeams ? `\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.` : ''}

Data chaining with action outputs:
- Use \${a1.output.field} to reference the output of action a1
- Template variables can ONLY be used INSIDE strings
- NEVER use template variables as direct values: { "count": \${a1.output.length} } ❌ WRONG
- ALWAYS quote them: { "count": "\${a1.output.length}" } ✅ CORRECT
- NEVER use the word "undefined" in JSON - use null or a string instead

Examples:
- \${a1.output.count} - Access count field from action a1
- \${a2.output.users} - Access users array from action a2
- \${a3.output.users[0].name} - Access nested field
- After action a5 executes, you can reference \${a5.output} in subsequent actions

CRITICAL: When instructions say "Do NOT add print actions", follow that EXACTLY - only generate the actions listed in the steps.
When using "return" actions with data containing template variables, do NOT add intermediate print actions - they will break the data chain.

REMEMBER: Include print actions for ALL output the user should see, UNLESS the instructions explicitly say not to. Return valid, parseable JSON only.`;


    // Use agent's configured model
    const model = this.model;

    if (process.env.KOI_DEBUG_LLM) {
      const agentInfo = agent ? ` | Agent: ${agent.name}` : '';
      console.error('─'.repeat(80));
      console.error(`[LLM Debug] executeOpenAI - Model: ${model}${agentInfo}`);
      console.error('System Prompt:');
      console.error(formatPromptForDebug(systemPrompt));
      console.error('============');
      console.error('User Prompt:');
      console.error('============');
      console.error(formatPromptForDebug(prompt));
      console.error('─'.repeat(80));
    }

    const completion = await this.openai.chat.completions.create(
      this.buildApiParams({
        model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0, // Always use 0 for maximum determinism
        max_tokens: this.maxTokens,
        response_format: { type: "json_object" } // Force valid JSON responses
      })
    );

    const content = completion.choices[0].message.content?.trim() || '';

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[LLM Debug] executeOpenAI Response (${content.length} chars):`);
      console.error('\x1b[90m' + content + '\x1b[0m');
      console.error('─'.repeat(80));
    }

    if (!content) {
      console.error('[LLM] Warning: executeOpenAI returned empty content');
    }

    return content;
  }

  async executeOpenAIWithTools(prompt, tools = [], agent = null, fromDelegation = false, promptLength = 0) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set in environment');
    }

    // If no tools available, fallback to regular execution
    if (!tools || tools.length === 0) {
      // hasTeams should only be true if agent can delegate to others (uses teams as a client)
      // NOT if agent is just a member of a team (has peers)
      const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;
      return await this.executeOpenAI(prompt, fromDelegation, hasTeams, promptLength, agent);
    }

    // Convert tools to OpenAI format
    const openAITools = tools.map(tool => {
      // Build a more informative description
      const description = tool.description || `Function ${tool.name}`;
      const enhancedDescription = `${description}. Extract necessary parameters from the prompt and context.`;

      // Define common parameter properties that skills might need
      // This helps OpenAI understand what to extract from the context
      const commonProperties = {
        url: {
          type: 'string',
          description: 'URL to fetch or process (extract from prompt or context)'
        },
        text: {
          type: 'string',
          description: 'Text content to process (extract from prompt or context)'
        },
        content: {
          type: 'string',
          description: 'Content to process (extract from prompt or context)'
        },
        numbers: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of numbers to process (extract from prompt or context)'
        },
        data: {
          type: 'object',
          description: 'Additional data (extract from context)'
        }
      };

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: enhancedDescription,
          parameters: {
            type: 'object',
            properties: commonProperties,
            additionalProperties: true,
            required: []
          }
        }
      };
    });

    const delegationInstructions = fromDelegation
      ? `\n\nCRITICAL: You are a specialized worker agent being called from another agent.
DO NOT return actions for delegation. Execute your task DIRECTLY using available tools or your own capabilities.
Return only the direct result of your work.`
      : `\n\n2. DELEGATION (for multi-step or complex tasks):
   - When a task requires multiple steps or different capabilities, delegate by returning actions
   - Each action describes what needs to be done, and the framework will find the right agent
   - You can include additional fields in your response (like "plan", "explanation", etc.) along with the actions
   - Format:
     {
       "plan": "Optional: description of the approach you're taking",
       "actions": [
         { "title": "Fetching web page...", "intent": "fetch web page", "data": { "url": "..." } },
         { "title": "Summarizing...", "intent": "summarize content", "data": { "content": "\${previousResult.content}" } }
       ]
     }

CRITICAL: When delegating work that involves MULTIPLE items (e.g., "create these 6 users"):
- Generate ONE delegation action PER ITEM
- Each action should contain the data for THAT SPECIFIC ITEM ONLY
- Example for "create Alice (id=001) and Bob (id=002)":
  { "title": "Create Alice", "intent": "create user", "data": { "id": "001", "name": "Alice", ... } },
  { "title": "Create Bob", "intent": "create user", "data": { "id": "002", "name": "Bob", ... } }
- NEVER group multiple items into one action unless the handler explicitly expects an array`;

    const systemPrompt = `You are a helpful assistant in the Koi agent orchestration framework.

You can accomplish tasks in ${fromDelegation ? 'ONE' : 'TWO'} way${fromDelegation ? '' : 's'}:

1. DIRECT EXECUTION (for single-step tasks):
   - Use available tools/functions when you have a tool that does exactly what's needed
   - Extract parameters from the prompt or context and pass them to the tool
   - Example: If you have a "fetchUrl" tool and need to download a webpage, call fetchUrl({ url: "..." })
${delegationInstructions}

CRITICAL INSTRUCTIONS FOR TOOL CALLING:
1. When you see a URL, email, text, or any data in the prompt or context that is needed for a tool, YOU MUST pass it as parameters to the function call.
2. Extract parameters from:
   - The explicit instructions in the prompt (e.g., "Download the web page from this URL: https://example.com")
   - The Context section showing available data
3. DO NOT call tools with empty parameters. Always extract and pass the necessary data.
4. Match parameter names to what makes sense (url, text, email, etc.)
5. After calling a tool, return the tool result DIRECTLY as JSON. DO NOT wrap it in a "result" field or stringify it again.

JSON VALIDATION RULES:
- ALWAYS use valid JSON - all values must be proper JSON types (strings, numbers, objects, arrays, booleans, null)
- Template variables like \${previousResult.field} can ONLY be used INSIDE strings
- NEVER use template variables as direct values: { "count": \${previousResult.length} } ❌ WRONG
- ALWAYS quote them: { "count": "\${previousResult.length}" } ✅ CORRECT
- NEVER use the word "undefined" in JSON - use null or a string instead

Examples:
- Prompt: "Download the web page from this URL: https://example.com"
- Context: { "args": { "url": "https://example.com" } }
- Correct tool call: fetchUrl({ "url": "https://example.com" })
- WRONG: fetchUrl({})
- After tool returns { "url": "...", "content": "..." }, return it directly as-is

You respond with valid JSON only. No markdown, no code blocks, no explanations.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];

    // Use agent's configured model
    const model = this.model;

    if (process.env.KOI_DEBUG_LLM) {
      const agentInfo = agent ? ` | Agent: ${agent.name}` : '';
      console.error('─'.repeat(80));
      console.error(`[LLM Debug] executeOpenAIWithTools - Model: ${model}, Tools: ${openAITools.length}${agentInfo}`);
      console.error('System Prompt:');
      console.error(formatPromptForDebug(systemPrompt));
      console.error('============');
      console.error('User Prompt:');
      console.error('============');
      console.error(formatPromptForDebug(prompt));
      console.error('─'.repeat(80));
    }

    // Call OpenAI with tools
    let completion = await this.openai.chat.completions.create(
      this.buildApiParams({
        model,
        messages,
        tools: openAITools,
        tool_choice: 'auto',
        temperature: 0, // Always use 0 for maximum determinism
        max_tokens: this.maxTokens,
        response_format: { type: "json_object" } // Force valid JSON responses
      })
    );

    let message = completion.choices[0].message;

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      // Execute tool calls
      messages.push(message); // Add assistant's response with tool calls

      let toolResults = [];
      for (const toolCall of message.tool_calls) {
        const tool = tools.find(t => t.name === toolCall.function.name);
        if (tool) {
          try {
            // Show that agent is using a skill
            if (agent) {
              cliLogger.progress(`[🤖 ${agent.name} ⚙️  ${tool.name}]`);
            }

            // Parse arguments - OpenAI sends them as JSON string
            const args = JSON.parse(toolCall.function.arguments);

            // Execute the function with the arguments
            const result = await tool.fn(args);
            toolResults.push(result);

            // Clear progress after tool execution
            cliLogger.clear();

            // Add tool result to messages
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result)
            });
          } catch (error) {
            cliLogger.clear();
            const errorResult = { error: error.message };
            toolResults.push(errorResult);
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(errorResult)
            });
          }
        }
      }

      // If this is a delegated call with a single tool call, return the tool result directly
      // This avoids token limit issues when the result is large (e.g., fetched HTML content)
      if (fromDelegation && toolResults.length === 1 && !toolResults[0].error) {
        return JSON.stringify(toolResults[0]);
      }

      // Call OpenAI again with tool results
      completion = await this.openai.chat.completions.create(
        this.buildApiParams({
          model,  // Use same model as initial call
          messages,
          temperature: 0, // Always use 0 for maximum determinism
          max_tokens: this.maxTokens,
          response_format: { type: "json_object" } // Force valid JSON responses
        })
      );

      message = completion.choices[0].message;
    }

    const finalContent = message.content?.trim() || '';

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[LLM Debug] executeOpenAIWithTools Response (${finalContent.length} chars):`);
      console.error('\x1b[90m' + finalContent + '\x1b[0m');
      console.error('─'.repeat(80));
    }

    if (!finalContent) {
      console.error('[LLM] Warning: OpenAI returned empty content');
    }

    return finalContent;
  }

  async executeAnthropic(prompt, agent = null) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in environment');
    }

    // Check if agent has teams for delegation
    const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;

    const systemPrompt = `Convert playbook to JSON actions.

OUTPUT: { "actions": [...] }

CRITICAL RULES:
1. Dynamic content (random/relacionado/based on) → call_llm FIRST, then use \${id.output.result}
2. Loops: "hasta que se despida" → while with llm_eval condition
3. Loop structure: initial question BEFORE while → registry_set BEFORE while → while loop (registry_get → call_llm → prompt_user → registry_set → print)
4. IDs: Add "id" only when you'll reference \${id.output} later
5. Template variables ONLY in strings: "text \${var}" not \${var}
6. Group consecutive prints with \\n
7. User feedback: Add "desc" field in English gerund form WITHOUT trailing dots. Make it natural and conversational, NOT technical/explicit (e.g., "Analyzing your response", "Processing your message", "Understanding what you said"). Avoid exposing implementation details. Animated spinner added automatically. If omitted, shows "Thinking"

WHILE LOOP EXAMPLE:
{ "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
{ "intent": "registry_set", "key": "last", "value": "\${a1.output.answer}" },
{ "intent": "while",
  "condition": { "llm_eval": true, "desc": "Processing your response", "instruction": "¿Continuar? (false si despedida)", "data": "\${a3.output.answer}" },
  "actions": [
    { "id": "prev", "intent": "registry_get", "key": "last" },
    { "id": "a2", "intent": "call_llm", "desc": "Thinking of next question", "data": {"answer":"\${prev.output.value}"}, "instruction": "Generate question related to answer" },
    { "id": "a3", "intent": "prompt_user", "question": "\${a2.output.result}" },
    { "intent": "registry_set", "key": "last", "value": "\${a3.output.answer}" },
    { "intent": "print", "message": "Interesante: \${a3.output.answer}" }
  ]
}
CRITICAL: condition.data MUST be the ID from prompt_user INSIDE the loop (a3), NOT from outside (a1)

Available actions:
${actionRegistry.generatePromptDocumentation(agent)}
${hasTeams && agent ? agent.getPeerCapabilitiesAsActions() : ''}

${hasTeams ? `\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.` : ''}

Data chaining with action outputs:
- Use \${a1.output.field} to reference the output of action a1
- Template variables can ONLY be used INSIDE strings
- NEVER use template variables as direct values: { "count": \${a1.output.length} } ❌ WRONG
- ALWAYS quote them: { "count": "\${a1.output.length}" } ✅ CORRECT
- NEVER use the word "undefined" in JSON - use null or a string instead

Examples:
- \${a1.output.count} - Access count field from action a1
- \${a2.output.users} - Access users array from action a2
- \${a3.output.users[0].name} - Access nested field
- After action a5 executes, you can reference \${a5.output} in subsequent actions

CRITICAL: When instructions say "Do NOT add print actions", follow that EXACTLY - only generate the actions listed in the steps.
When using "return" actions with data containing template variables, do NOT add intermediate print actions - they will break the data chain.

REMEMBER: Include print actions for ALL output the user should see, UNLESS the instructions explicitly say not to. Return valid, parseable JSON only.`;

    const message = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0, // Always use 0 for maximum determinism
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    return message.content[0].text.trim();
  }

  /**
   * Execute OpenAI call with streaming and incremental action execution
   * @param {string} prompt - The prompt to send
   * @param {boolean} fromDelegation - Whether this is from delegation
   * @param {boolean} hasTeams - Whether agent has teams
   * @param {number} promptLength - Length of prompt for model selection
   * @param {Object} agent - Agent instance
   * @param {Function} onAction - Callback called for each complete action: (action) => void
   * @returns {Promise<Object>} - Final parsed response
   */
  async executeOpenAIStreaming(prompt, fromDelegation = false, hasTeams = false, promptLength = 0, agent = null, onAction = null) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set in environment');
    }

    // Build system prompt
    const systemPrompt = `Convert playbook to JSON actions.

OUTPUT: { "actions": [...] }

CRITICAL RULES:
1. Dynamic content (random/relacionado/based on) → call_llm FIRST, then use \${id.output.result}
2. Loops: "hasta que se despida" → while with llm_eval condition
3. Loop structure: initial question BEFORE while → registry_set BEFORE while → while loop (registry_get → call_llm → prompt_user → registry_set → print)
4. IDs: Add "id" only when you'll reference \${id.output} later
5. Template variables ONLY in strings: "text \${var}" not \${var}
6. Group consecutive prints with \\n
7. User feedback: Add "desc" field in English gerund form WITHOUT trailing dots. Make it natural and conversational, NOT technical/explicit (e.g., "Analyzing your response", "Processing your message", "Understanding what you said"). Avoid exposing implementation details. Animated spinner added automatically. If omitted, shows "Thinking"

WHILE LOOP EXAMPLE:
{ "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
{ "intent": "registry_set", "key": "last", "value": "\${a1.output.answer}" },
{ "intent": "while",
  "condition": { "llm_eval": true, "desc": "Processing your response", "instruction": "¿Continuar? (false si despedida)", "data": "\${a3.output.answer}" },
  "actions": [
    { "id": "prev", "intent": "registry_get", "key": "last" },
    { "id": "a2", "intent": "call_llm", "desc": "Thinking of next question", "data": {"answer":"\${prev.output.value}"}, "instruction": "Generate question related to answer" },
    { "id": "a3", "intent": "prompt_user", "question": "\${a2.output.result}" },
    { "intent": "registry_set", "key": "last", "value": "\${a3.output.answer}" },
    { "intent": "print", "message": "Interesante: \${a3.output.answer}" }
  ]
}
CRITICAL: condition.data MUST be the ID from prompt_user INSIDE the loop (a3), NOT from outside (a1)

Available actions:
${actionRegistry.generatePromptDocumentation(agent)}
${hasTeams && agent ? agent.getPeerCapabilitiesAsActions() : ''}

${hasTeams ? `\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.` : ''}

Data chaining with action outputs:
- Use \${a1.output.field} to reference the output of action a1
- Template variables can ONLY be used INSIDE strings
- NEVER use template variables as direct values: { "count": \${a1.output.length} } ❌ WRONG
- ALWAYS quote them: { "count": "\${a1.output.length}" } ✅ CORRECT
- NEVER use the word "undefined" in JSON - use null or a string instead

Examples:
- \${a1.output.count} - Access count field from action a1
- \${a2.output.users} - Access users array from action a2
- \${a3.output.users[0].name} - Access nested field
- After action a5 executes, you can reference \${a5.output} in subsequent actions

CRITICAL: When instructions say "Do NOT add print actions", follow that EXACTLY - only generate the actions listed in the steps.
When using "return" actions with data containing template variables, do NOT add intermediate print actions - they will break the data chain.

REMEMBER: Include print actions for ALL output the user should see, UNLESS the instructions explicitly say not to. Return valid, parseable JSON only.`;

    // Use agent's configured model
    const model = this.model;

    if (process.env.KOI_DEBUG_LLM) {
      const agentInfo = agent ? ` | Agent: ${agent.name}` : '';
      console.error('─'.repeat(80));
      console.error(`[LLM Debug] executeOpenAIStreaming - Model: ${model}${agentInfo}`);
      console.error('System Prompt:');
      console.error(formatPromptForDebug(systemPrompt));
      console.error('============');
      console.error('User Prompt:');
      console.error('============');
      console.error(formatPromptForDebug(prompt));
      console.error('─'.repeat(80));
    }

    // Create streaming completion
    const stream = await this.openai.chat.completions.create(
      this.buildApiParams({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0,
        max_tokens: this.maxTokens,
        stream: true,  // Enable streaming
        response_format: { type: "json_object" }
      })
    );

    // Use incremental parser
    const parser = new IncrementalJSONParser();
    let fullContent = '';
    let streamingStarted = false;

    if (process.env.KOI_DEBUG_LLM) {
      console.error('[LLM Debug] Starting stream processing...');
    }

    // Cola de acciones y ejecutor en paralelo
    const actionQueue = [];
    let streamFinished = false;
    let processingError = null;
    let isExecuting = false;

    // Worker que ejecuta acciones de la cola EN ORDEN (respeta dependencias)
    const processQueue = async () => {
      while (!streamFinished || actionQueue.length > 0) {
        // Esperar si no hay acciones
        if (actionQueue.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }

        const action = actionQueue.shift();
        if (!action) continue;

        // Ejecutar acción EN ORDEN (await para respetar dependencias entre a1, a2, etc.)
        try {
          isExecuting = true;
          await onAction(action);
        } catch (error) {
          console.error('[LLM] Error executing action:', error.message);
          processingError = error;
          break; // Abortar procesamiento en caso de error
        } finally {
          isExecuting = false;
        }
      }
    };

    // Iniciar el worker de procesamiento si hay onAction
    const processingPromise = onAction ? processQueue() : null;

    // Process stream
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;

          // Show single-line "Receiving response..." with animation
          if (process.env.KOI_DEBUG_LLM && !streamingStarted) {
            streamingStarted = true;
            cliLogger.planning('Receiving response');
          }

          // Feed to parser and get any complete actions
          const actions = parser.feed(delta);

          // Añadir acciones a la cola (no ejecutar directamente)
          if (onAction && actions.length > 0) {
            if (process.env.KOI_DEBUG_LLM) {
              console.error(`\n[LLM Debug] 🚀 Found ${actions.length} complete action(s) - adding to queue (queue size: ${actionQueue.length + actions.length})`);
            }
            actionQueue.push(...actions);
          }

          // Si hubo error en el procesamiento, abortar
          if (processingError) {
            throw processingError;
          }
        }
      }

      // Marcar stream como finalizado
      streamFinished = true;

      // Clear streaming indicator
      if (process.env.KOI_DEBUG_LLM && streamingStarted) {
        cliLogger.clear();
      }
    } catch (error) {
      streamFinished = true;
      if (streamingStarted) {
        cliLogger.clear();
      }
      console.error('[LLM] Stream processing error:', error.message);
      if (process.env.KOI_DEBUG_LLM) {
        console.error(error.stack);
      }
      throw error;
    }

    // Finalize parser to catch any remaining actions
    const finalActions = parser.finalize();
    if (onAction && finalActions.length > 0) {
      actionQueue.push(...finalActions);
    }

    // Print response immediately after receiving it
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`\n[LLM Debug] executeOpenAIStreaming Complete (${fullContent.length} chars)`);
      console.error('─'.repeat(80));
      console.error('[LLM Debug] Response:');
      // Format each line with < prefix and gray color
      const lines = fullContent.split('\n');
      for (const line of lines) {
        console.error(`< \x1b[90m${line}\x1b[0m`);
      }
      console.error('─'.repeat(80));
    }

    // Esperar a que se procesen todas las acciones en la cola
    if (processingPromise) {
      await processingPromise;
    }

    // Esperar a que termine la acción actual si está ejecutándose
    while (isExecuting) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Si hubo error durante el procesamiento, lanzarlo ahora
    if (processingError) {
      throw processingError;
    }

    return fullContent;
  }

  /**
   * Execute Anthropic call with streaming and incremental action execution
   * @param {string} prompt - The prompt to send
   * @param {Object} agent - Agent instance
   * @param {Function} onAction - Callback called for each complete action: (action) => void
   * @returns {Promise<string>} - Final response content
   */
  async executeAnthropicStreaming(prompt, agent = null, onAction = null) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in environment');
    }

    // Check if agent has teams for delegation
    const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;

    const systemPrompt = `Convert playbook to JSON actions.

OUTPUT: { "actions": [...] }

CRITICAL RULES:
1. Dynamic content (random/relacionado/based on) → call_llm FIRST, then use \${id.output.result}
2. Loops: "hasta que se despida" → while with llm_eval condition
3. Loop structure: initial question BEFORE while → registry_set BEFORE while → while loop (registry_get → call_llm → prompt_user → registry_set → print)
4. IDs: Add "id" only when you'll reference \${id.output} later
5. Template variables ONLY in strings: "text \${var}" not \${var}
6. Group consecutive prints with \\n
7. User feedback: Add "desc" field in English gerund form WITHOUT trailing dots. Make it natural and conversational, NOT technical/explicit (e.g., "Analyzing your response", "Processing your message", "Understanding what you said"). Avoid exposing implementation details. Animated spinner added automatically. If omitted, shows "Thinking"

WHILE LOOP EXAMPLE:
{ "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
{ "intent": "registry_set", "key": "last", "value": "\${a1.output.answer}" },
{ "intent": "while",
  "condition": { "llm_eval": true, "desc": "Processing your response", "instruction": "¿Continuar? (false si despedida)", "data": "\${a3.output.answer}" },
  "actions": [
    { "id": "prev", "intent": "registry_get", "key": "last" },
    { "id": "a2", "intent": "call_llm", "desc": "Thinking of next question", "data": {"answer":"\${prev.output.value}"}, "instruction": "Generate question related to answer" },
    { "id": "a3", "intent": "prompt_user", "question": "\${a2.output.result}" },
    { "intent": "registry_set", "key": "last", "value": "\${a3.output.answer}" },
    { "intent": "print", "message": "Interesante: \${a3.output.answer}" }
  ]
}
CRITICAL: condition.data MUST be the ID from prompt_user INSIDE the loop (a3), NOT from outside (a1)

Available actions:
${actionRegistry.generatePromptDocumentation(agent)}
${hasTeams && agent ? agent.getPeerCapabilitiesAsActions() : ''}

${hasTeams ? `\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.` : ''}

Data chaining with action outputs:
- Use \${a1.output.field} to reference the output of action a1
- Template variables can ONLY be used INSIDE strings
- NEVER use template variables as direct values: { "count": \${a1.output.length} } ❌ WRONG
- ALWAYS quote them: { "count": "\${a1.output.length}" } ✅ CORRECT
- NEVER use the word "undefined" in JSON - use null or a string instead

Examples:
- \${a1.output.count} - Access count field from action a1
- \${a2.output.users} - Access users array from action a2
- \${a3.output.users[0].name} - Access nested field
- After action a5 executes, you can reference \${a5.output} in subsequent actions

CRITICAL: When instructions say "Do NOT add print actions", follow that EXACTLY - only generate the actions listed in the steps.
When using "return" actions with data containing template variables, do NOT add intermediate print actions - they will break the data chain.

REMEMBER: Include print actions for ALL output the user should see, UNLESS the instructions explicitly say not to. Return valid, parseable JSON only.`;

    if (process.env.KOI_DEBUG_LLM) {
      const agentInfo = agent ? ` | Agent: ${agent.name}` : '';
      console.error('─'.repeat(80));
      console.error(`[LLM Debug] executeAnthropicStreaming - Model: ${this.model}${agentInfo}`);
      console.error('System Prompt:');
      console.error(formatPromptForDebug(systemPrompt));
      console.error('============');
      console.error('User Prompt:');
      console.error('============');
      console.error(formatPromptForDebug(prompt));
      console.error('─'.repeat(80));
    }

    // Create streaming message
    const stream = await this.anthropic.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    });

    // Use incremental parser
    const parser = new IncrementalJSONParser();
    let fullContent = '';
    let streamingStarted = false;

    // Process stream
    stream.on('text', (delta) => {
      fullContent += delta;

      // Show single-line "Receiving response..." with animation
      if (process.env.KOI_DEBUG_LLM && !streamingStarted) {
        streamingStarted = true;
        cliLogger.planning('Receiving response');
      }

      // Feed to parser and get any complete actions
      const actions = parser.feed(delta);

      // Execute each complete action immediately
      if (onAction && actions.length > 0) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`\n[LLM Debug] 🚀 Found ${actions.length} complete action(s) - executing immediately!`);
        }
        for (const action of actions) {
          onAction(action).catch(err => {
            console.error(`[Stream] Error executing action: ${err.message}`);
          });
        }
      }
    });

    // Wait for stream to complete
    const message = await stream.finalMessage();

    // Clear streaming indicator
    if (process.env.KOI_DEBUG_LLM && streamingStarted) {
      cliLogger.clear();
    }

    // Finalize parser to catch any remaining actions
    const finalActions = parser.finalize();

    // Print response immediately after receiving it
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`\n[LLM Debug] executeAnthropicStreaming Complete (${fullContent.length} chars)`);
      console.error('─'.repeat(80));
      console.error('[LLM Debug] Response:');
      // Format each line with < prefix and gray color
      const lines = fullContent.split('\n');
      for (const line of lines) {
        console.error(`< \x1b[90m${line}\x1b[0m`);
      }
      console.error('─'.repeat(80));
    }

    if (onAction && finalActions.length > 0) {
      for (const action of finalActions) {
        await onAction(action);
      }
    }

    return fullContent;
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

    if (this.provider === 'openai' || this.provider === 'anthropic') {
      // Always use OpenAI for embeddings (Anthropic doesn't have embeddings API)
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY required for embeddings');
      }

      if (!this.openai) {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      }

      try {
        const response = await this.openai.embeddings.create({
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
