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
    this.model = config.model || 'gpt-4o-mini';
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

  async executePlanning(prompt) {
    // Simple, fast planning call without all the overhead
    // ALWAYS use the fastest model for planning
    try {
      let response;

      if (this.provider === 'openai') {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',  // Force fastest model for planning
          messages: [
            {
              role: 'system',
              content: 'Planning assistant. JSON only.'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0,  // Use 0 for maximum determinism
          max_tokens: 800
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

    const systemPrompt = `You are a Koi agent executor. Your job is to convert user instructions into a precise sequence of executable actions.

CRITICAL RULES:
1. Execute EVERY instruction in the user's request - do not skip any steps
2. Return ONLY raw JSON - NO markdown, NO wrapping, NO "result" field
3. Follow the EXACT order of instructions given by the user
4. NEVER hardcode dynamic data - ALWAYS use template variables:
   - ❌ WRONG: "✅ 6 users created" (hardcoded count)
   - ✅ RIGHT: "✅ \${a1.output.count + a2.output.count + ...} users created" (dynamic)
   - ❌ WRONG: "| Sr | Alice | 30 |" (hardcoded name/age)
   - ✅ RIGHT: "| \${a8.output.users[0].name.endsWith('a') ? 'Sra' : 'Sr'} | \${a8.output.users[0].name} | \${a8.output.users[0].age} |"
   - If you see "X users created" where X is dynamic, replace X with a template expression ONLY for simple arithmetic
   - If you see "{el nombre del usuario}" in instructions, use \${actionId.output.name}, NOT a hardcoded value
   - CRITICAL RULE - COMPLEX CALCULATIONS: If text has placeholders like {x}, {age}, {días}, {dd/mm/yyyy} that need:
     * Age calculations from birthdates
     * Date formatting
     * Time differences
     * Any arithmetic involving dates
     → MANDATORY: Use format action, NEVER generate template expressions with Date/time calculations
     → ❌ ABSOLUTELY WRONG: \${new Date(...).getFullYear() - ...} or any Date arithmetic in templates
     → ✅ ALWAYS RIGHT: { "id": "formatted", "intent": "format", "data": "\${usersArray}", "instruction": "For each user calculate age from birthdate and generate email..." }, then print \${formatted.output.formatted}
5. NEVER use .map() or arrow functions with nested template literals in template variables:
   - ❌ WRONG: \${array.map(item => \`text \${item.field}\`).join('\\n')} (nested templates cannot be evaluated)
   - ✅ RIGHT: Use format action to transform array data into display text
   - When displaying tables/lists from array data: { "id": "aX", "intent": "format", "data": "\${arrayActionId.output.users}", "instruction": "Format as markdown table with columns: Sr/Sra, Name, Age. Deduce gender from name ending in 'a'" }
   - Then print the formatted result: { "intent": "print", "message": "\${aX.output.formatted}" }
6. When iterating over arrays, generate actions for ALL elements dynamically
   - NEVER hardcode a fixed number of rows/items when the actual array size might differ
7. EXTRACT ALL DATA FROM NATURAL LANGUAGE - Parse specifications carefully to get EVERY field:
   - "Alice: id=001, age=30, email=alice@example.com" → { "name": "Alice", "id": "001", "age": 30, "email": "alice@example.com" }
   - "Bob: id=002, de 17 años, bob@example.com" → { "name": "Bob", "id": "002", "age": 17, "email": "bob@example.com" }
   - Pattern: "NAME: property1, property2..." means text before colon is the name
   - Convert natural language ages: "de 17 años" → age: 17, "age is 35" → age: 35
   - NEVER omit fields! If you see a name in the spec, include it in the data object
8. Use "print" actions to display ALL requested output to the user
9. ALWAYS use valid JSON - all values must be proper JSON types (strings, numbers, objects, arrays, booleans, null)
10. EFFICIENCY: Group consecutive print actions into a single print using \\n for line breaks
   - WRONG: Three separate prints for header lines
   - RIGHT: One print with "Line1\\nLine2\\nLine3"
11. EFFICIENCY - Batch Operations: When performing the same operation on multiple items, check if a batch/plural version exists:
   - Look for plural intent names in available delegation actions: createAllUser/createAllUsers (batch) vs createUser (single)
   - ❌ WRONG: Six separate createUser calls for 6 users
   - ✅ RIGHT: One createAllUser call with array of all 6 users: { "actionType": "delegate", "intent": "createAllUser", "data": { "users": [{name: "Alice", id: "001", ...}, {name: "Bob", id: "002", ...}, ...] } }
   - Apply this principle to ANY repeated operation where a batch version exists
   - Benefits: Fewer network calls, better performance, cleaner action sequences
12. ACTION IDs - CRITICAL: Add "id" field ONLY to actions that return DATA you need later
   - ✅ PUT IDs ON: delegate actions, registry_get, registry_keys, registry_search (they return data)
   - ❌ NEVER PUT IDs ON: print, log, format, update_state, registry_set, registry_delete (no useful output)
   - Sequential IDs: a1, a2, a3, ... starting fresh for each playbook execution
   - The "id" field goes on THE ACTION THAT PRODUCES THE DATA, not on the action that uses it!

   EXAMPLES:
   ❌ WRONG - ID on print action:
   { "id": "a1", "actionType": "direct", "intent": "print", "message": "Creating user" },
   { "actionType": "delegate", "intent": "createUser", "data": {...} },
   { "actionType": "direct", "intent": "print", "message": "Name: \${a1.output.name}" } ← a1 is print, has no name field!

   ✅ RIGHT - ID on data-producing action:
   { "actionType": "direct", "intent": "print", "message": "Fetching user..." },
   { "id": "a1", "actionType": "delegate", "intent": "getUser", "data": {"id": "001"} },
   { "actionType": "direct", "intent": "print", "message": "Name: \${a1.output.name}" } ← a1 is getUser, has name field!

13. RETURN vs FORMAT ACTIONS - CRITICAL: Know when to return raw data vs formatted output:
   - If playbook says "Return: { count, users: [array] }" → MUST return actual JSON array, NOT a formatted string
   - "Transform results to extract user data" from registry_search means reference the .results array directly
   - NEVER use format action before return when the playbook asks for an array
   - Use format action ONLY for final display output to users, NEVER for returning data structures

   When playbook says "Transform results to extract user data" + "Return: { count, users: [array] }":
   ❌ WRONG:
   { "id": "a1", "intent": "registry_search", "query": {} },
   { "id": "a2", "intent": "format", "data": "\${a1.output.results}", "instruction": "..." },
   { "intent": "return", "data": { "users": "\${a2.output.formatted}" } }  ← Returns STRING!

   ✅ RIGHT:
   { "id": "a1", "intent": "registry_search", "query": {} },
   { "intent": "return", "data": { "count": "\${a1.output.count}", "users": "\${a1.output.results}" } }  ← Returns actual array!

   - registry_search already returns { results: [{key, value}, ...] }, just use that array directly
   - The caller can access individual users with \${actionId.output.users[0].value.name}
   - Only use format when explicitly asked to display/print formatted output

14. PROMPT_USER WITH OPTIONS - CRITICAL: Detect when questions have limited/boolean answers:
   - ALWAYS analyze the question context to determine if it's boolean or has limited options
   - Questions like "quiere continuar", "do you want", "yes or no", "acepta" → Use options: ["Sí", "No"] or ["Yes", "No"]
   - Questions with 2-3 obvious choices → Use options array for interactive menu with arrow keys
   - Questions asking for open text (name, age, description) → NO options (text input mode)

   CRITICAL DETECTION RULES:
   - Keywords that indicate boolean: "quiere", "desea", "acepta", "want", "do you", "would you", "continuar"
   - Questions with "o" / "or" indicating choices: "norte o sur", "male or female" → Extract options
   - Questions asking about preferences with limited set: "color favorito" → ["Rojo", "Azul", "Verde", "Amarillo"]
   - Geographic binaries: "norte o sur", "north or south" → ["Norte", "Sur"]

   EXAMPLES:
   ❌ WRONG - Boolean question without options:
   { "intent": "prompt_user", "question": "¿Quieres continuar?" }  ← Missing options!

   ✅ RIGHT - Boolean with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] }

   ❌ WRONG - Limited choices without options:
   { "intent": "prompt_user", "question": "¿Eres del norte o del sur?" }  ← Missing options!

   ✅ RIGHT - Limited choices with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Eres del norte o del sur?", "options": ["Norte", "Sur"] }

   ✅ RIGHT - Open text (no options):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" }  ← Text input OK
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }  ← Text input OK

15. IF ACTION FOR CONDITIONAL LOGIC - CRITICAL: Use "if" action when execution depends on user choices:
   - NEVER generate all actions upfront when some depend on conditions
   - Use "if" action to branch based on runtime values (especially prompt_user responses)

   STRUCTURE:
   {
     "intent": "if",
     "condition": "\${actionId.output.answer} === 'expected value'",
     "then": [ array of actions to execute if true ],
     "else": [ array of actions to execute if false ]
   }

   EXAMPLES:
   Prompt: "Ask if user wants to continue, if yes ask their age, if no say goodbye"

   ✅ RIGHT - Using if action:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a1.output.answer} === 'Sí'",
     "then": [
       { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "Tienes \${a2.output.answer} años" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego!" }
     ]
   }

   ❌ WRONG - Generating all actions without conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },  ← Always asks!
   { "intent": "print", "message": "..." }

16. CONDITIONAL "FINALLY" ACTIONS - CRITICAL: When playbook says "finalmente" (finally) with actions that depend on conditional data:
   - ANALYZE: Does the "finally" action need data that only exists in the "then" branch?
   - If YES: Put the "finally" action INSIDE the "then" branch, create appropriate alternative for "else"
   - If NO: Put the "finally" action after the if statement

   EXAMPLE SCENARIO:
   Playbook: "Pregunta si quiere continuar, si quiere pregunta su edad. Finalmente saluda y bromea sobre su edad."
   Translation: "Ask if they want to continue, if yes ask their age. Finally greet and joke about their age."

   ANALYSIS: "bromea sobre su edad" (joke about age) needs age data, which only exists in "then" branch!

   ✅ RIGHT - "Finally" action inside conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [
       { "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "¡Hola \${a1.output.answer}! Tienes \${a3.output.answer} años, ¡qué joven!" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego, \${a1.output.answer}! Espero que tengas un gran día." }
     ]
   }

   ❌ WRONG - "Finally" action outside conditional (will fail when user says "No"):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [{ "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }],
     "else": []
   },
   { "intent": "print", "message": "¡Hola! Tienes \${a3.output.answer} años" }  ← a3 doesn't exist if user said "No"!

${delegationNote}${teamDelegationNote}

RESPONSE FORMAT (ALWAYS use this):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Display this to user" },
    { "actionType": "direct", "intent": "return", "data": {...} }
  ]
}

CORRECT EXAMPLES:

Example 1 - NEVER hardcode dynamic values (CRITICAL - Follow Rule #4):
User prompt: "Create 2 users, then show 'X users created' where X is the count"
❌ WRONG - Hardcoded count:
{ "actionType": "direct", "intent": "print", "message": "✅ 2 users created" }

✅ RIGHT - Dynamic count:
{ "id": "a1", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "id": "a2", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "actionType": "direct", "intent": "print", "message": "✅ \${a1.output.success && a2.output.success ? 2 : (a1.output.success || a2.output.success ? 1 : 0)} users created" }

Example 2 - Extracting names from natural language (CRITICAL - Follow Rule #6):
User prompt: "Create Alice: id=001, age=30, email=alice@example.com"
❌ WRONG - Missing name: { "data": { "id": "001", "age": 30, "email": "alice@example.com" } }
✅ RIGHT - Include name: { "data": { "name": "Alice", "id": "001", "age": 30, "email": "alice@example.com" } }

Example 3 - Delegate with ID:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User: \${a1.output.name}, age \${a1.output.age}" }
  ]
}

Example 4 - Multiple actions with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "listUsers" },
    { "actionType": "direct", "intent": "print", "message": "Found \${a1.output.count} users" },
    { "id": "a2", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "First user: \${a2.output.name}" }
  ]
}

Example 5 - Registry operations with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "direct", "intent": "registry_get", "key": "user:001" },
    { "actionType": "direct", "intent": "print", "message": "Name: \${a1.output.value.name}" }
  ]
}

Example 6 - Without IDs (when results aren't needed):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Hello" },
    { "actionType": "delegate", "intent": "deleteUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User deleted" }
  ]
}

CRITICAL: ALWAYS include "actionType" field in EVERY action (either "direct" or "delegate")

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


    // Use fastest model for delegated work or short playbooks
    const model = fromDelegation || promptLength < 500 ? 'gpt-4o-mini' : this.model;

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

    const completion = await this.openai.chat.completions.create({
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
    });

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

    // Use fastest model for delegated work or short prompts
    const model = fromDelegation || promptLength < 500 ? 'gpt-4o-mini' : this.model;

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
    let completion = await this.openai.chat.completions.create({
      model,
      messages,
      tools: openAITools,
      tool_choice: 'auto',
      temperature: 0, // Always use 0 for maximum determinism
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" } // Force valid JSON responses
    });

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
      completion = await this.openai.chat.completions.create({
        model,  // Use same model as initial call
        messages,
        temperature: 0, // Always use 0 for maximum determinism
        max_tokens: this.maxTokens,
        response_format: { type: "json_object" } // Force valid JSON responses
      });

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

    const systemPrompt = `You are a Koi agent executor. Your job is to convert user instructions into a precise sequence of executable actions.

CRITICAL RULES:
1. Execute EVERY instruction in the user's request - do not skip any steps
2. Return ONLY raw JSON - NO markdown, NO wrapping, NO "result" field
3. Follow the EXACT order of instructions given by the user
4. Use "print" actions to display ALL requested output to the user
5. ALWAYS use valid JSON - all values must be proper JSON types (strings, numbers, objects, arrays, booleans, null)
6. EFFICIENCY: Group consecutive print actions into a single print using \\n for line breaks
   - WRONG: Three separate prints for header lines
   - RIGHT: One print with "Line1\\nLine2\\nLine3"
6b. EFFICIENCY - Batch Operations: When performing the same operation on multiple items, check if a batch/plural version exists:
   - Look for plural intent names in available delegation actions: createAllUser/createAllUsers (batch) vs createUser (single)
   - ❌ WRONG: Six separate createUser calls for 6 users
   - ✅ RIGHT: One createAllUser call with array of all 6 users: { "actionType": "delegate", "intent": "createAllUser", "data": { "users": [{name: "Alice", id: "001", ...}, {name: "Bob", id: "002", ...}, ...] } }
   - Apply this principle to ANY repeated operation where a batch version exists
   - Benefits: Fewer network calls, better performance, cleaner action sequences
7. ACTION IDs (OPTIONAL): Use "id" field ONLY when you need to reference the result later
   - Add "id": "a1" only if you'll use \${a1.output} in a future action
   - Actions without "id" won't save their output (use for print, one-time actions)
   - Sequential IDs: a1, a2, a3, ... (only for actions that need saving)
   - Example: { "id": "a1", "intent": "getUser" } → later use \${a1.output.name}
8. CRITICAL - DYNAMIC/CREATIVE CONTENT GENERATION: Use format action when content must be generated based on analyzing data:

   A) DATE/AGE CALCULATIONS - If playbook has {age}, {días}, {dd/mm/yyyy} or date placeholders:
      - NEVER generate template expressions with Date arithmetic
      - MANDATORY: Use format action with the data array
      - ❌ ABSOLUTELY WRONG: print with "\${2023 - new Date(birthdate).getFullYear()}"
      - ✅ RIGHT: { "id": "formatted", "intent": "format", "data": "\${usersArray}", "instruction": "Calculate age from birthdate..." }

   B) CREATIVE/ADAPTIVE CONTENT - If playbook requests content that must adapt to data values:
      - DETECT keywords: "bromea", "joke", "personaliza", "personalize", "comenta", "comment", "genera", "generate", "apropiado", "appropriate"
      - If text should be DIFFERENT based on data (e.g., different joke for age 20 vs age 80), use format action
      - NEVER hardcode creative content during planning - generate it at runtime based on actual data

      ❌ WRONG - Static creative content (same joke for any age):
      { "intent": "print", "message": "Tienes \${a3.output.answer} años, ¡no te preocupes, la edad es solo un número!" }

      ✅ RIGHT - Dynamic creative content (adapts to actual age):
      { "id": "a4", "intent": "format", "data": { "nombre": "\${a1.output.answer}", "edad": "\${a3.output.answer}" }, "instruction": "Genera un saludo personalizado para {nombre} y una broma creativa sobre tener {edad} años. La broma debe ser apropiada y diferente según la edad específica." },
      { "intent": "print", "message": "\${a4.output.formatted}" }

   C) COMPLEX TEMPLATES - Copy COMPLETE template from playbook to format instruction:
      - Keep ALL conditional logic (e.g., "Estimado o Estimada si es chica, deducelo por el nombre")
      - Preserve ALL line breaks/spacing (use \n in instruction string)
      - Keep original language and exact wording
      - Don't simplify, paraphrase, or omit any part
9. NEVER use .map() or arrow functions with nested template literals in template variables:
   - ❌ ABSOLUTELY WRONG: \${array.map(item => \`text \${item.field}\`).join('\\n')} (nested templates CANNOT be evaluated)
   - ❌ WRONG: print with "\${users.map(u => \`| \${u.name} | \${u.age} |\`).join('\\n')}" (will print literal template string)
   - ✅ MANDATORY: Use format action for ANY iteration over arrays
   - For markdown tables: { "id": "aX", "intent": "format", "data": "\${arrayId.output.users}", "instruction": "Generate markdown table with columns: Sr/Sra (deduce from name), Name, Age. Include header row with | Sr/Sra | Name | Age | and separator |--------|------|-----|" }
   - For lists: { "id": "aX", "intent": "format", "data": "\${arrayId.output.items}", "instruction": "Format each item as: - {name}: {description}" }
   - Then print: { "intent": "print", "message": "\${aX.output.formatted}" }

10. PROMPT_USER WITH OPTIONS - CRITICAL: Detect when questions have limited/boolean answers:
   - ALWAYS analyze the question context to determine if it's boolean or has limited options
   - Questions like "quiere continuar", "do you want", "yes or no", "acepta" → Use options: ["Sí", "No"] or ["Yes", "No"]
   - Questions with 2-3 obvious choices → Use options array for interactive menu with arrow keys
   - Questions asking for open text (name, age, description) → NO options (text input mode)

   CRITICAL DETECTION RULES:
   - Keywords that indicate boolean: "quiere", "desea", "acepta", "want", "do you", "would you", "continuar"
   - Questions with "o" / "or" indicating choices: "norte o sur", "male or female" → Extract options
   - Questions asking about preferences with limited set: "color favorito" → ["Rojo", "Azul", "Verde", "Amarillo"]
   - Geographic binaries: "norte o sur", "north or south" → ["Norte", "Sur"]

   EXAMPLES:
   ❌ WRONG - Boolean question without options:
   { "intent": "prompt_user", "question": "¿Quieres continuar?" }  ← Missing options!

   ✅ RIGHT - Boolean with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] }

   ❌ WRONG - Limited choices without options:
   { "intent": "prompt_user", "question": "¿Eres del norte o del sur?" }  ← Missing options!

   ✅ RIGHT - Limited choices with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Eres del norte o del sur?", "options": ["Norte", "Sur"] }

   ✅ RIGHT - Open text (no options):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" }  ← Text input OK
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }  ← Text input OK

11. IF ACTION FOR CONDITIONAL LOGIC - CRITICAL: Use "if" action when execution depends on user choices:
   - NEVER generate all actions upfront when some depend on conditions
   - Use "if" action to branch based on runtime values (especially prompt_user responses)

   STRUCTURE:
   {
     "intent": "if",
     "condition": "\${actionId.output.answer} === 'expected value'",
     "then": [ array of actions to execute if true ],
     "else": [ array of actions to execute if false ]
   }

   EXAMPLES:
   Prompt: "Ask if user wants to continue, if yes ask their age, if no say goodbye"

   ✅ RIGHT - Using if action:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a1.output.answer} === 'Sí'",
     "then": [
       { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "Tienes \${a2.output.answer} años" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego!" }
     ]
   }

   ❌ WRONG - Generating all actions without conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },  ← Always asks!
   { "intent": "print", "message": "..." }

16. CONDITIONAL "FINALLY" ACTIONS - CRITICAL: When playbook says "finalmente" (finally) with actions that depend on conditional data:
   - ANALYZE: Does the "finally" action need data that only exists in the "then" branch?
   - If YES: Put the "finally" action INSIDE the "then" branch, create appropriate alternative for "else"
   - If NO: Put the "finally" action after the if statement

   EXAMPLE SCENARIO:
   Playbook: "Pregunta si quiere continuar, si quiere pregunta su edad. Finalmente saluda y bromea sobre su edad."
   Translation: "Ask if they want to continue, if yes ask their age. Finally greet and joke about their age."

   ANALYSIS: "bromea sobre su edad" (joke about age) needs age data, which only exists in "then" branch!

   ✅ RIGHT - "Finally" action inside conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [
       { "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "¡Hola \${a1.output.answer}! Tienes \${a3.output.answer} años, ¡qué joven!" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego, \${a1.output.answer}! Espero que tengas un gran día." }
     ]
   }

   ❌ WRONG - "Finally" action outside conditional (will fail when user says "No"):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [{ "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }],
     "else": []
   },
   { "intent": "print", "message": "¡Hola! Tienes \${a3.output.answer} años" }  ← a3 doesn't exist if user said "No"!

RESPONSE FORMAT (ALWAYS use this):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Display this to user" },
    { "actionType": "direct", "intent": "return", "data": {...} }
  ]
}

CORRECT EXAMPLES:

Example 1 - NEVER hardcode dynamic values (CRITICAL - Follow Rule #4):
User prompt: "Create 2 users, then show 'X users created' where X is the count"
❌ WRONG - Hardcoded count:
{ "actionType": "direct", "intent": "print", "message": "✅ 2 users created" }

✅ RIGHT - Dynamic count:
{ "id": "a1", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "id": "a2", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "actionType": "direct", "intent": "print", "message": "✅ \${a1.output.success && a2.output.success ? 2 : (a1.output.success || a2.output.success ? 1 : 0)} users created" }

Example 2 - Extracting names from natural language (CRITICAL - Follow Rule #6):
User prompt: "Create Alice: id=001, age=30, email=alice@example.com"
❌ WRONG - Missing name: { "data": { "id": "001", "age": 30, "email": "alice@example.com" } }
✅ RIGHT - Include name: { "data": { "name": "Alice", "id": "001", "age": 30, "email": "alice@example.com" } }

Example 3 - Delegate with ID:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User: \${a1.output.name}, age \${a1.output.age}" }
  ]
}

Example 4 - Multiple actions with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "listUsers" },
    { "actionType": "direct", "intent": "print", "message": "Found \${a1.output.count} users" },
    { "id": "a2", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "First user: \${a2.output.name}" }
  ]
}

Example 5 - Registry operations with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "direct", "intent": "registry_get", "key": "user:001" },
    { "actionType": "direct", "intent": "print", "message": "Name: \${a1.output.value.name}" }
  ]
}

Example 6 - Without IDs (when results aren't needed):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Hello" },
    { "actionType": "delegate", "intent": "deleteUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User deleted" }
  ]
}

CRITICAL: ALWAYS include "actionType" field in EVERY action (either "direct" or "delegate")

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
    const systemPrompt = `You are a Koi agent executor. Your job is to convert user instructions into a precise sequence of executable actions.

CRITICAL RULES:
1. Execute EVERY instruction in the user's request - do not skip any steps
2. Return ONLY raw JSON - NO markdown, NO wrapping, NO "result" field
3. Follow the EXACT order of instructions given by the user
4. Use "print" actions to display ALL requested output to the user
5. ALWAYS use valid JSON - all values must be proper JSON types (strings, numbers, objects, arrays, booleans, null)
6. EFFICIENCY: Group consecutive print actions into a single print using \\n for line breaks
   - WRONG: Three separate prints for header lines
   - RIGHT: One print with "Line1\\nLine2\\nLine3"
6b. EFFICIENCY - Batch Operations: When performing the same operation on multiple items, check if a batch/plural version exists:
   - Look for plural intent names in available delegation actions: createAllUser/createAllUsers (batch) vs createUser (single)
   - ❌ WRONG: Six separate createUser calls for 6 users
   - ✅ RIGHT: One createAllUser call with array of all 6 users: { "actionType": "delegate", "intent": "createAllUser", "data": { "users": [{name: "Alice", id: "001", ...}, {name: "Bob", id: "002", ...}, ...] } }
   - Apply this principle to ANY repeated operation where a batch version exists
   - Benefits: Fewer network calls, better performance, cleaner action sequences
7. ACTION IDs (OPTIONAL): Use "id" field ONLY when you need to reference the result later
   - Add "id": "a1" only if you'll use \${a1.output} in a future action
   - Actions without "id" won't save their output (use for print, one-time actions)
   - Sequential IDs: a1, a2, a3, ... (only for actions that need saving)
   - Example: { "id": "a1", "intent": "getUser" } → later use \${a1.output.name}
8. CRITICAL - DYNAMIC/CREATIVE CONTENT GENERATION: Use format action when content must be generated based on analyzing data:

   A) DATE/AGE CALCULATIONS - If playbook has {age}, {días}, {dd/mm/yyyy} or date placeholders:
      - NEVER generate template expressions with Date arithmetic
      - MANDATORY: Use format action with the data array
      - ❌ ABSOLUTELY WRONG: print with "\${2023 - new Date(birthdate).getFullYear()}"
      - ✅ RIGHT: { "id": "formatted", "intent": "format", "data": "\${usersArray}", "instruction": "Calculate age from birthdate..." }

   B) CREATIVE/ADAPTIVE CONTENT - If playbook requests content that must adapt to data values:
      - DETECT keywords: "bromea", "joke", "personaliza", "personalize", "comenta", "comment", "genera", "generate", "apropiado", "appropriate"
      - If text should be DIFFERENT based on data (e.g., different joke for age 20 vs age 80), use format action
      - NEVER hardcode creative content during planning - generate it at runtime based on actual data

      ❌ WRONG - Static creative content (same joke for any age):
      { "intent": "print", "message": "Tienes \${a3.output.answer} años, ¡no te preocupes, la edad es solo un número!" }

      ✅ RIGHT - Dynamic creative content (adapts to actual age):
      { "id": "a4", "intent": "format", "data": { "nombre": "\${a1.output.answer}", "edad": "\${a3.output.answer}" }, "instruction": "Genera un saludo personalizado para {nombre} y una broma creativa sobre tener {edad} años. La broma debe ser apropiada y diferente según la edad específica." },
      { "intent": "print", "message": "\${a4.output.formatted}" }

   C) COMPLEX TEMPLATES - Copy COMPLETE template from playbook to format instruction:
      - Keep ALL conditional logic (e.g., "Estimado o Estimada si es chica, deducelo por el nombre")
      - Preserve ALL line breaks/spacing (use \n in instruction string)
      - Keep original language and exact wording
      - Don't simplify, paraphrase, or omit any part
9. NEVER use .map() or arrow functions with nested template literals in template variables:
   - ❌ ABSOLUTELY WRONG: \${array.map(item => \`text \${item.field}\`).join('\\n')} (nested templates CANNOT be evaluated)
   - ❌ WRONG: print with "\${users.map(u => \`| \${u.name} | \${u.age} |\`).join('\\n')}" (will print literal template string)
   - ✅ MANDATORY: Use format action for ANY iteration over arrays
   - For markdown tables: { "id": "aX", "intent": "format", "data": "\${arrayId.output.users}", "instruction": "Generate markdown table with columns: Sr/Sra (deduce from name), Name, Age. Include header row with | Sr/Sra | Name | Age | and separator |--------|------|-----|" }
   - For lists: { "id": "aX", "intent": "format", "data": "\${arrayId.output.items}", "instruction": "Format each item as: - {name}: {description}" }
   - Then print: { "intent": "print", "message": "\${aX.output.formatted}" }

10. PROMPT_USER WITH OPTIONS - CRITICAL: Detect when questions have limited/boolean answers:
   - ALWAYS analyze the question context to determine if it's boolean or has limited options
   - Questions like "quiere continuar", "do you want", "yes or no", "acepta" → Use options: ["Sí", "No"] or ["Yes", "No"]
   - Questions with 2-3 obvious choices → Use options array for interactive menu with arrow keys
   - Questions asking for open text (name, age, description) → NO options (text input mode)

   CRITICAL DETECTION RULES:
   - Keywords that indicate boolean: "quiere", "desea", "acepta", "want", "do you", "would you", "continuar"
   - Questions with "o" / "or" indicating choices: "norte o sur", "male or female" → Extract options
   - Questions asking about preferences with limited set: "color favorito" → ["Rojo", "Azul", "Verde", "Amarillo"]
   - Geographic binaries: "norte o sur", "north or south" → ["Norte", "Sur"]

   EXAMPLES:
   ❌ WRONG - Boolean question without options:
   { "intent": "prompt_user", "question": "¿Quieres continuar?" }  ← Missing options!

   ✅ RIGHT - Boolean with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] }

   ❌ WRONG - Limited choices without options:
   { "intent": "prompt_user", "question": "¿Eres del norte o del sur?" }  ← Missing options!

   ✅ RIGHT - Limited choices with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Eres del norte o del sur?", "options": ["Norte", "Sur"] }

   ✅ RIGHT - Open text (no options):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" }  ← Text input OK
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }  ← Text input OK

11. IF ACTION FOR CONDITIONAL LOGIC - CRITICAL: Use "if" action when execution depends on user choices:
   - NEVER generate all actions upfront when some depend on conditions
   - Use "if" action to branch based on runtime values (especially prompt_user responses)

   STRUCTURE:
   {
     "intent": "if",
     "condition": "\${actionId.output.answer} === 'expected value'",
     "then": [ array of actions to execute if true ],
     "else": [ array of actions to execute if false ]
   }

   EXAMPLES:
   Prompt: "Ask if user wants to continue, if yes ask their age, if no say goodbye"

   ✅ RIGHT - Using if action:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a1.output.answer} === 'Sí'",
     "then": [
       { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "Tienes \${a2.output.answer} años" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego!" }
     ]
   }

   ❌ WRONG - Generating all actions without conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },  ← Always asks!
   { "intent": "print", "message": "..." }

16. CONDITIONAL "FINALLY" ACTIONS - CRITICAL: When playbook says "finalmente" (finally) with actions that depend on conditional data:
   - ANALYZE: Does the "finally" action need data that only exists in the "then" branch?
   - If YES: Put the "finally" action INSIDE the "then" branch, create appropriate alternative for "else"
   - If NO: Put the "finally" action after the if statement

   EXAMPLE SCENARIO:
   Playbook: "Pregunta si quiere continuar, si quiere pregunta su edad. Finalmente saluda y bromea sobre su edad."
   Translation: "Ask if they want to continue, if yes ask their age. Finally greet and joke about their age."

   ANALYSIS: "bromea sobre su edad" (joke about age) needs age data, which only exists in "then" branch!

   ✅ RIGHT - "Finally" action inside conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [
       { "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "¡Hola \${a1.output.answer}! Tienes \${a3.output.answer} años, ¡qué joven!" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego, \${a1.output.answer}! Espero que tengas un gran día." }
     ]
   }

   ❌ WRONG - "Finally" action outside conditional (will fail when user says "No"):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [{ "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }],
     "else": []
   },
   { "intent": "print", "message": "¡Hola! Tienes \${a3.output.answer} años" }  ← a3 doesn't exist if user said "No"!

RESPONSE FORMAT (ALWAYS use this):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Display this to user" },
    { "actionType": "direct", "intent": "return", "data": {...} }
  ]
}

CORRECT EXAMPLES:

Example 1 - NEVER hardcode dynamic values (CRITICAL - Follow Rule #4):
User prompt: "Create 2 users, then show 'X users created' where X is the count"
❌ WRONG - Hardcoded count:
{ "actionType": "direct", "intent": "print", "message": "✅ 2 users created" }

✅ RIGHT - Dynamic count:
{ "id": "a1", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "id": "a2", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "actionType": "direct", "intent": "print", "message": "✅ \${a1.output.success && a2.output.success ? 2 : (a1.output.success || a2.output.success ? 1 : 0)} users created" }

Example 2 - Extracting names from natural language (CRITICAL - Follow Rule #6):
User prompt: "Create Alice: id=001, age=30, email=alice@example.com"
❌ WRONG - Missing name: { "data": { "id": "001", "age": 30, "email": "alice@example.com" } }
✅ RIGHT - Include name: { "data": { "name": "Alice", "id": "001", "age": 30, "email": "alice@example.com" } }

Example 3 - Delegate with ID:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User: \${a1.output.name}, age \${a1.output.age}" }
  ]
}

Example 4 - Multiple actions with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "listUsers" },
    { "actionType": "direct", "intent": "print", "message": "Found \${a1.output.count} users" },
    { "id": "a2", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "First user: \${a2.output.name}" }
  ]
}

Example 5 - Registry operations with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "direct", "intent": "registry_get", "key": "user:001" },
    { "actionType": "direct", "intent": "print", "message": "Name: \${a1.output.value.name}" }
  ]
}

Example 6 - Without IDs (when results aren't needed):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Hello" },
    { "actionType": "delegate", "intent": "deleteUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User deleted" }
  ]
}

CRITICAL: ALWAYS include "actionType" field in EVERY action (either "direct" or "delegate")

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

    // Use fastest model for delegated work or short playbooks
    const model = fromDelegation || promptLength < 500 ? 'gpt-4o-mini' : this.model;

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
    const stream = await this.openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      max_tokens: this.maxTokens,
      stream: true,  // Enable streaming
      response_format: { type: "json_object" }
    });

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

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[LLM Debug] executeOpenAIStreaming Complete (${fullContent.length} chars)`);
      console.error('─'.repeat(80));
      console.error('[LLM Debug] Response:');
      // Format each line with < prefix and gray color
      const lines = fullContent.split('\n');
      for (const line of lines) {
        console.error(`< \x1b[90m${line}\x1b[0m`);
      }
      console.error('─'.repeat(80));
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

    const systemPrompt = `You are a Koi agent executor. Your job is to convert user instructions into a precise sequence of executable actions.

CRITICAL RULES:
1. Execute EVERY instruction in the user's request - do not skip any steps
2. Return ONLY raw JSON - NO markdown, NO wrapping, NO "result" field
3. Follow the EXACT order of instructions given by the user
4. Use "print" actions to display ALL requested output to the user
5. ALWAYS use valid JSON - all values must be proper JSON types (strings, numbers, objects, arrays, booleans, null)
6. EFFICIENCY: Group consecutive print actions into a single print using \\n for line breaks
   - WRONG: Three separate prints for header lines
   - RIGHT: One print with "Line1\\nLine2\\nLine3"
6b. EFFICIENCY - Batch Operations: When performing the same operation on multiple items, check if a batch/plural version exists:
   - Look for plural intent names in available delegation actions: createAllUser/createAllUsers (batch) vs createUser (single)
   - ❌ WRONG: Six separate createUser calls for 6 users
   - ✅ RIGHT: One createAllUser call with array of all 6 users: { "actionType": "delegate", "intent": "createAllUser", "data": { "users": [{name: "Alice", id: "001", ...}, {name: "Bob", id: "002", ...}, ...] } }
   - Apply this principle to ANY repeated operation where a batch version exists
   - Benefits: Fewer network calls, better performance, cleaner action sequences
7. ACTION IDs (OPTIONAL): Use "id" field ONLY when you need to reference the result later
   - Add "id": "a1" only if you'll use \${a1.output} in a future action
   - Actions without "id" won't save their output (use for print, one-time actions)
   - Sequential IDs: a1, a2, a3, ... (only for actions that need saving)
   - Example: { "id": "a1", "intent": "getUser" } → later use \${a1.output.name}
8. CRITICAL - DYNAMIC/CREATIVE CONTENT GENERATION: Use format action when content must be generated based on analyzing data:

   A) DATE/AGE CALCULATIONS - If playbook has {age}, {días}, {dd/mm/yyyy} or date placeholders:
      - NEVER generate template expressions with Date arithmetic
      - MANDATORY: Use format action with the data array
      - ❌ ABSOLUTELY WRONG: print with "\${2023 - new Date(birthdate).getFullYear()}"
      - ✅ RIGHT: { "id": "formatted", "intent": "format", "data": "\${usersArray}", "instruction": "Calculate age from birthdate..." }

   B) CREATIVE/ADAPTIVE CONTENT - If playbook requests content that must adapt to data values:
      - DETECT keywords: "bromea", "joke", "personaliza", "personalize", "comenta", "comment", "genera", "generate", "apropiado", "appropriate"
      - If text should be DIFFERENT based on data (e.g., different joke for age 20 vs age 80), use format action
      - NEVER hardcode creative content during planning - generate it at runtime based on actual data

      ❌ WRONG - Static creative content (same joke for any age):
      { "intent": "print", "message": "Tienes \${a3.output.answer} años, ¡no te preocupes, la edad es solo un número!" }

      ✅ RIGHT - Dynamic creative content (adapts to actual age):
      { "id": "a4", "intent": "format", "data": { "nombre": "\${a1.output.answer}", "edad": "\${a3.output.answer}" }, "instruction": "Genera un saludo personalizado para {nombre} y una broma creativa sobre tener {edad} años. La broma debe ser apropiada y diferente según la edad específica." },
      { "intent": "print", "message": "\${a4.output.formatted}" }

   C) COMPLEX TEMPLATES - Copy COMPLETE template from playbook to format instruction:
      - Keep ALL conditional logic (e.g., "Estimado o Estimada si es chica, deducelo por el nombre")
      - Preserve ALL line breaks/spacing (use \n in instruction string)
      - Keep original language and exact wording
      - Don't simplify, paraphrase, or omit any part
9. NEVER use .map() or arrow functions with nested template literals in template variables:
   - ❌ ABSOLUTELY WRONG: \${array.map(item => \`text \${item.field}\`).join('\\n')} (nested templates CANNOT be evaluated)
   - ❌ WRONG: print with "\${users.map(u => \`| \${u.name} | \${u.age} |\`).join('\\n')}" (will print literal template string)
   - ✅ MANDATORY: Use format action for ANY iteration over arrays
   - For markdown tables: { "id": "aX", "intent": "format", "data": "\${arrayId.output.users}", "instruction": "Generate markdown table with columns: Sr/Sra (deduce from name), Name, Age. Include header row with | Sr/Sra | Name | Age | and separator |--------|------|-----|" }
   - For lists: { "id": "aX", "intent": "format", "data": "\${arrayId.output.items}", "instruction": "Format each item as: - {name}: {description}" }
   - Then print: { "intent": "print", "message": "\${aX.output.formatted}" }

10. PROMPT_USER WITH OPTIONS - CRITICAL: Detect when questions have limited/boolean answers:
   - ALWAYS analyze the question context to determine if it's boolean or has limited options
   - Questions like "quiere continuar", "do you want", "yes or no", "acepta" → Use options: ["Sí", "No"] or ["Yes", "No"]
   - Questions with 2-3 obvious choices → Use options array for interactive menu with arrow keys
   - Questions asking for open text (name, age, description) → NO options (text input mode)

   CRITICAL DETECTION RULES:
   - Keywords that indicate boolean: "quiere", "desea", "acepta", "want", "do you", "would you", "continuar"
   - Questions with "o" / "or" indicating choices: "norte o sur", "male or female" → Extract options
   - Questions asking about preferences with limited set: "color favorito" → ["Rojo", "Azul", "Verde", "Amarillo"]
   - Geographic binaries: "norte o sur", "north or south" → ["Norte", "Sur"]

   EXAMPLES:
   ❌ WRONG - Boolean question without options:
   { "intent": "prompt_user", "question": "¿Quieres continuar?" }  ← Missing options!

   ✅ RIGHT - Boolean with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] }

   ❌ WRONG - Limited choices without options:
   { "intent": "prompt_user", "question": "¿Eres del norte o del sur?" }  ← Missing options!

   ✅ RIGHT - Limited choices with options:
   { "id": "a1", "intent": "prompt_user", "question": "¿Eres del norte o del sur?", "options": ["Norte", "Sur"] }

   ✅ RIGHT - Open text (no options):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" }  ← Text input OK
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }  ← Text input OK

11. IF ACTION FOR CONDITIONAL LOGIC - CRITICAL: Use "if" action when execution depends on user choices:
   - NEVER generate all actions upfront when some depend on conditions
   - Use "if" action to branch based on runtime values (especially prompt_user responses)

   STRUCTURE:
   {
     "intent": "if",
     "condition": "\${actionId.output.answer} === 'expected value'",
     "then": [ array of actions to execute if true ],
     "else": [ array of actions to execute if false ]
   }

   EXAMPLES:
   Prompt: "Ask if user wants to continue, if yes ask their age, if no say goodbye"

   ✅ RIGHT - Using if action:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a1.output.answer} === 'Sí'",
     "then": [
       { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "Tienes \${a2.output.answer} años" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego!" }
     ]
   }

   ❌ WRONG - Generating all actions without conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "id": "a2", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },  ← Always asks!
   { "intent": "print", "message": "..." }

16. CONDITIONAL "FINALLY" ACTIONS - CRITICAL: When playbook says "finalmente" (finally) with actions that depend on conditional data:
   - ANALYZE: Does the "finally" action need data that only exists in the "then" branch?
   - If YES: Put the "finally" action INSIDE the "then" branch, create appropriate alternative for "else"
   - If NO: Put the "finally" action after the if statement

   EXAMPLE SCENARIO:
   Playbook: "Pregunta si quiere continuar, si quiere pregunta su edad. Finalmente saluda y bromea sobre su edad."
   Translation: "Ask if they want to continue, if yes ask their age. Finally greet and joke about their age."

   ANALYSIS: "bromea sobre su edad" (joke about age) needs age data, which only exists in "then" branch!

   ✅ RIGHT - "Finally" action inside conditional:
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [
       { "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" },
       { "intent": "print", "message": "¡Hola \${a1.output.answer}! Tienes \${a3.output.answer} años, ¡qué joven!" }
     ],
     "else": [
       { "intent": "print", "message": "¡Hasta luego, \${a1.output.answer}! Espero que tengas un gran día." }
     ]
   }

   ❌ WRONG - "Finally" action outside conditional (will fail when user says "No"):
   { "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },
   { "id": "a2", "intent": "prompt_user", "question": "¿Quieres continuar?", "options": ["Sí", "No"] },
   { "intent": "if",
     "condition": "\${a2.output.answer} === 'Sí'",
     "then": [{ "id": "a3", "intent": "prompt_user", "question": "¿Cuántos años tienes?" }],
     "else": []
   },
   { "intent": "print", "message": "¡Hola! Tienes \${a3.output.answer} años" }  ← a3 doesn't exist if user said "No"!

RESPONSE FORMAT (ALWAYS use this):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Display this to user" },
    { "actionType": "direct", "intent": "return", "data": {...} }
  ]
}

CORRECT EXAMPLES:

Example 1 - NEVER hardcode dynamic values (CRITICAL - Follow Rule #4):
User prompt: "Create 2 users, then show 'X users created' where X is the count"
❌ WRONG - Hardcoded count:
{ "actionType": "direct", "intent": "print", "message": "✅ 2 users created" }

✅ RIGHT - Dynamic count:
{ "id": "a1", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "id": "a2", "actionType": "delegate", "intent": "createUser", "data": {...} },
{ "actionType": "direct", "intent": "print", "message": "✅ \${a1.output.success && a2.output.success ? 2 : (a1.output.success || a2.output.success ? 1 : 0)} users created" }

Example 2 - Extracting names from natural language (CRITICAL - Follow Rule #6):
User prompt: "Create Alice: id=001, age=30, email=alice@example.com"
❌ WRONG - Missing name: { "data": { "id": "001", "age": 30, "email": "alice@example.com" } }
✅ RIGHT - Include name: { "data": { "name": "Alice", "id": "001", "age": 30, "email": "alice@example.com" } }

Example 3 - Delegate with ID:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User: \${a1.output.name}, age \${a1.output.age}" }
  ]
}

Example 4 - Multiple actions with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "delegate", "intent": "listUsers" },
    { "actionType": "direct", "intent": "print", "message": "Found \${a1.output.count} users" },
    { "id": "a2", "actionType": "delegate", "intent": "getUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "First user: \${a2.output.name}" }
  ]
}

Example 5 - Registry operations with IDs:
{
  "actions": [
    { "id": "a1", "actionType": "direct", "intent": "registry_get", "key": "user:001" },
    { "actionType": "direct", "intent": "print", "message": "Name: \${a1.output.value.name}" }
  ]
}

Example 6 - Without IDs (when results aren't needed):
{
  "actions": [
    { "actionType": "direct", "intent": "print", "message": "Hello" },
    { "actionType": "delegate", "intent": "deleteUser", "data": { "id": "001" } },
    { "actionType": "direct", "intent": "print", "message": "User deleted" }
  ]
}

CRITICAL: ALWAYS include "actionType" field in EVERY action (either "direct" or "delegate")

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
    if (onAction && finalActions.length > 0) {
      for (const action of finalActions) {
        await onAction(action);
      }
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[LLM Debug] executeAnthropicStreaming Complete (${fullContent.length} chars)`);
      console.error('─'.repeat(80));
      console.error('[LLM Debug] Response:');
      // Format each line with < prefix and gray color
      const lines = fullContent.split('\n');
      for (const line of lines) {
        console.error(`< \x1b[90m${line}\x1b[0m`);
      }
      console.error('─'.repeat(80));
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
