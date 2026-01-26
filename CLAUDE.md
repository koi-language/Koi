# CLAUDE.md - Knowledge Base for KOI Language

> This document captures architectural insights, patterns, and lessons learned from working with the KOI language codebase. Useful for AI assistants and developers working on KOI.

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Key Patterns](#key-patterns)
4. [LLM Integration](#llm-integration)
5. [Recent Improvements](#recent-improvements)
6. [Lessons Learned](#lessons-learned)
7. [Best Practices](#best-practices)
8. [Common Pitfalls](#common-pitfalls)

---

## Project Overview

**KOI** is an agent-first orchestration language that enables multi-agent systems with natural language playbooks and LLM integration.

### Core Concepts
- **Agents**: Autonomous entities that handle events and execute playbooks
- **Roles**: Define permissions (execute, delegate, registry access)
- **Teams**: Groups of agents that work together
- **Playbooks**: Natural language instructions that LLMs convert to executable actions
- **Skills**: Reusable functions that agents can import and use
- **Registry**: Shared key-value store for agent communication

### Tech Stack
- **Language**: JavaScript (ESM modules)
- **Transpiler**: PEG.js grammar → JavaScript
- **LLM Providers**: OpenAI (GPT-4o-mini, GPT-4o), Anthropic (Claude)
- **Registry Backends**: SQLite (Keyv), In-memory
- **File Extension**: `.koi`
- **CLI**: `koi run`, `koi compile`, `koi test`

---

## Architecture

### Directory Structure
```
koi/
├── src/
│   ├── cli/koi.js              # CLI entry point
│   ├── compiler/
│   │   ├── transpiler.js       # .koi → .js transpiler
│   │   ├── parser.js           # PEG.js generated parser
│   │   ├── cache-manager.js    # Embeddings cache for routing
│   │   └── import-resolver.js  # Handle imports
│   ├── runtime/
│   │   ├── agent.js            # Agent class
│   │   ├── llm-provider.js     # LLM integration (OpenAI, Anthropic)
│   │   ├── router.js           # Semantic routing between agents
│   │   ├── registry.js         # Key-value store
│   │   ├── action-registry.js  # Available actions
│   │   └── actions/            # Built-in actions (generate, print, etc.)
│   └── grammar/koi.pegjs       # Language grammar
├── examples/                    # Example .koi files
├── tests/                       # Test suite
├── vscode-koi-extension/        # VSCode syntax highlighting
└── doc/                         # Documentation
```

### Execution Flow

1. **Compile Phase** (`koi run example.koi`)
   - Parse `.koi` file with PEG.js grammar
   - Transpile to JavaScript
   - Cache embeddings for agent intents (used for routing)
   - Output to `.build/` directory

2. **Runtime Phase**
   - Load transpiled JavaScript
   - Initialize agents with their event handlers
   - Execute `run` statement (e.g., `run MyAgent.start({})`)

3. **Playbook Execution**
   - Agent receives event
   - Playbook text sent to LLM with system prompt
   - LLM returns JSON array of actions
   - Actions executed sequentially (with streaming support)
   - Results chained via template variables (`${a1.output}`)

---

## Key Patterns

### 1. Action Format
All LLM responses follow this structure:
```json
{
  "actions": [
    {
      "id": "a1",
      "actionType": "delegate",
      "intent": "createUser",
      "data": { "name": "Alice", "id": "001" }
    },
    {
      "actionType": "direct",
      "intent": "print",
      "message": "Created user: ${a1.output.name}"
    }
  ]
}
```

**Key Rules:**
- `id` field only needed if output will be referenced later
- `actionType`: `"direct"` (built-in) or `"delegate"` (to team member)
- Template variables use `${actionId.output.field}` syntax
- Actions execute sequentially, maintaining dependency order

### 2. Semantic Routing
When an agent delegates with `intent`, the router:
1. Computes embedding for the intent string
2. Compares against cached agent intent embeddings
3. Routes to most semantically similar agent
4. No explicit agent names needed!

```koi
// Agent doesn't need to know "UserManager" exists
{ "intent": "create user", "data": {...} }
// Router finds UserManager based on semantic similarity
```

### 3. Registry Operations
Shared state between agents via key-value store:

```javascript
// Direct actions in playbooks
{ "intent": "registry_set", "key": "user:001", "value": {...} }
{ "intent": "registry_get", "key": "user:001" }
{ "intent": "registry_search", "query": { "age": { "$gte": 18 } } }
{ "intent": "registry_delete", "key": "user:001" }
```

**Query operators:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`

---

## LLM Integration

### System Prompt Architecture
The system prompt in `src/runtime/llm-provider.js` is **critical**. It defines:
- How to convert natural language → JSON actions
- Efficiency rules (grouping prints, batch operations)
- Template variable syntax
- Data chaining between actions
- Available actions (dynamically injected)

### Key Efficiency Rules

#### Rule #6: Group Print Actions
```javascript
// ❌ WRONG - Multiple prints
{ "intent": "print", "message": "Line 1" },
{ "intent": "print", "message": "Line 2" },
{ "intent": "print", "message": "Line 3" }

// ✅ RIGHT - Single print with \n
{ "intent": "print", "message": "Line 1\nLine 2\nLine 3" }
```

#### Rule #6b/11: Batch Operations ⭐ NEW
```javascript
// ❌ WRONG - 6 separate calls
{ "id": "a1", "intent": "createUser", "data": { "name": "Alice", ... } },
{ "id": "a2", "intent": "createUser", "data": { "name": "Bob", ... } },
// ... 4 more

// ✅ RIGHT - Single batch call
{
  "id": "a1",
  "intent": "createAllUser",
  "data": {
    "users": [
      { "name": "Alice", ... },
      { "name": "Bob", ... },
      // ... all users
    ]
  }
}
```

**Rationale:** Same principle as print grouping - fewer network calls, better performance, cleaner sequences.

### LLM Provider Methods

| Method | Streaming | Use Case |
|--------|-----------|----------|
| `executeOpenAI` | No | Standard execution |
| `executeOpenAIStreaming` | Yes | Real-time action execution |
| `executeOpenAIWithTools` | No | When agent has skills |
| `executeAnthropic` | No | Standard execution (Claude) |
| `executeAnthropicStreaming` | Yes | Real-time (Claude) |

**Streaming behavior:**
- Actions parsed incrementally as JSON streams in
- Actions execute as soon as they're complete (don't wait for full response)
- Queue system maintains execution order (critical for dependencies)

---

## Recent Improvements

### Batch Operations Efficiency Rule (2024)

**Problem:** LLM was generating 6 individual `createUser` calls when a batch `createAllUser` existed.

**Solution:** Added efficiency rule #6b/11 to system prompts:
- Instructs LLM to look for plural/batch intent names
- Prefer `createAllUser` over multiple `createUser`
- Applies to ANY repeated operation with a batch alternative

**Impact:**
- Reduces network overhead
- Cleaner action sequences
- Consistent with existing print grouping pattern

**Files Modified:**
- `src/runtime/llm-provider.js` (all 4 execution methods)

**Testing:**
```bash
koi run examples/registry-playbook-demo.koi --debug
# Now uses createAllUser instead of 6 createUser calls
```

### Template Variable Resolution for Question Field (2026)

**Problem:** Template variables like `${a3.output.result}` were showing as literal text instead of being resolved when used in the `question` field of `prompt_user` actions. The LLM was correctly generating `call_llm` actions, but the template variable resolution wasn't working for the `question` field.

**Root Cause:** The `resolveActionReferences` method in `src/runtime/agent.js` was resolving template variables in fields like `message`, `text`, `data`, `key`, `value`, etc., but was missing the `question` field used by `prompt_user` action.

**Solution:** Added `question` field resolution to the `resolveActionReferences` method (line 621-623):
```javascript
// Resolve references in question field (for prompt_user action)
if (resolved.question !== undefined) {
  resolved.question = this.resolveObjectReferences(resolved.question, context);
}
```

**Impact:**
- `prompt_user` actions now correctly resolve template variables in their `question` field
- Enables dynamic question generation in loops and conditional flows
- Fixes iteration demos where questions depend on previous user responses

**Files Modified:**
- `src/runtime/agent.js` (resolveActionReferences method)

**Testing:**
```bash
koi run examples/iteration-demo.koi
# Now correctly resolves ${a2.output.result} in prompt_user questions
```

### System Prompt Simplification (2026)

**Problem:** System prompts in `llm-provider.js` were over 400 lines long with repetitive rules and conflicting examples, making them inefficient and error-prone.

**Solution:** Drastically simplified system prompts from ~400 lines to ~10-15 core rules:
1. Rule for when to use `call_llm` (keywords: "random", "relacionado", "based on")
2. Rule for loops with semantic conditions ("hasta que se despida")
3. Rule for data persistence (registry_set/registry_get)
4. Output format specification

**Impact:**
- Reduced token usage for every playbook execution
- Clearer, more focused instructions for LLM
- Fewer conflicting examples leading to better action generation
- Maintained all critical functionality while removing redundancy

**Files Modified:**
- `src/runtime/llm-provider.js` (all 4 execution methods: executeOpenAI, executeAnthropic, executeOpenAIStreaming, executeAnthropicStreaming)

### While Loop Structure with Initial Questions (2026)

**Problem:** When playbooks said "Empieza preguntando X. En cada iteración, pregunta algo relacionado...", the LLM was putting ALL questions (including the initial one) inside the while loop, causing the initial question to repeat on every iteration.

**User Report:**
```
¿Cuál es tu nombre?  ← Asked
> Antonio
...
¿Cuál es tu nombre?  ← Repeated!
> Antonio
...
¿Cuál es tu nombre?  ← Repeated again!
```

**Root Cause:** The system prompt rule #2 only showed a simple while loop structure without clarifying that "empieza" (starts by) means the action should be BEFORE the while, not inside it.

**Solution:** Enhanced rule #2 in system prompt to explicitly show the pattern:
```javascript
// ✅ CORRECT structure
{ "id": "a1", "intent": "prompt_user", "question": "¿Cuál es tu nombre?" },  // BEFORE while
{ "intent": "registry_set", "key": "last_answer", "value": "${a1.output.answer}" },
{ "intent": "while",
  "condition": { "llm_eval": true, "instruction": "¿Continuar? (false si despide)", "data": "${a3.output.answer}" },
  "actions": [
    { "id": "prev", "intent": "registry_get", "key": "last_answer" },
    { "id": "a2", "intent": "call_llm", "data": {"prev":"${prev.output.value}"}, "instruction": "Random question based on {prev}" },
    { "id": "a3", "intent": "prompt_user", "question": "${a2.output.result}" },
    { "intent": "registry_set", "key": "last_answer", "value": "${a3.output.answer}" },
    { "intent": "print", "message": "Interesante: ${a3.output.answer}" }
  ]
}

// ❌ WRONG: Putting "empieza" question INSIDE while (repeats every time!)
```

**Impact:**
- Initial questions are now correctly placed BEFORE the while loop
- Only dynamic/related questions are generated inside the loop using `call_llm`
- Registry is used to maintain context between iterations
- Fixes `examples/iteration-demo.koi` where name was asked repeatedly

**Files Modified:**
- `src/runtime/llm-provider.js` (rule #2 in all 4 execution methods)

**Testing:**
```bash
koi run examples/iteration-demo.koi
# Input: Antonio -> me gusta programar -> adios
# Output:
#   ¿Cuál es tu nombre? (asked ONCE)
#   ¿Qué te inspira más sobre la vida de Antonio? (dynamic, based on name)
#   ...then asks about programming (dynamic, based on previous answer)
```

---

## Lessons Learned

### 1. System Prompts are Architecture
The LLM system prompt is not just instructions—it's **architectural documentation** that shapes how agents behave. Changes to prompts can have cascading effects on performance and correctness.

### 2. Template Variables Require Careful Handling
- Only valid inside strings: `"${a1.output}"` ✅
- NOT as direct values: `${a1.output}` ❌
- Complex transformations need `call_llm` action (dates, arrays, calculations, dynamic content)

### 3. Streaming Adds Complexity
- Actions must execute in order despite arriving asynchronously
- Queue system prevents race conditions
- Parse incrementally with `IncrementalJSONParser`

### 4. Registry is Critical for Multi-Agent State
- Agents are stateless between events
- Registry enables persistence and communication
- Query operators make it powerful beyond simple key-value

### 5. Semantic Routing is Magic... and Fragile
- Embedding cache must be fresh (watch for cache invalidation)
- Intent strings need to be clear and descriptive
- Similar intents can confuse routing (e.g., "create user" vs "register user")

### 6. Debug Flags are Essential
```bash
export KOI_DEBUG_LLM=1  # Show all LLM prompts and responses
koi run example.koi --debug
```

---

## Best Practices

### Writing Playbooks

**DO:**
```koi
on createUsers(args: Json) {
  playbook """
  Create all users from args.users array.
  Use createAllUser with the complete array.
  Return: { "success": true, "count": <number created> }
  """
}
```

**DON'T:**
```koi
on createUsers(args: Json) {
  playbook """
  Create each user one by one.  // ❌ Encourages individual calls
  """
}
```

### Agent Design

**Single Responsibility:**
```koi
Agent UserManager : Worker {
  on createUser(args: Json) { ... }
  on getUser(args: Json) { ... }
  on listUsers(args: Json) { ... }
}

Agent EmailSender : Worker {
  on sendEmail(args: Json) { ... }
}
```

**Avoid God Agents:**
```koi
// ❌ WRONG - Too many responsibilities
Agent Everything : Worker {
  on createUser(args: Json) { ... }
  on sendEmail(args: Json) { ... }
  on processPayment(args: Json) { ... }
  on generateReport(args: Json) { ... }
}
```

### Error Handling in Playbooks

```koi
playbook """
EXACT STEPS:
1. Use registry_get with key "user:${args.id}", store with ID "a1"
2. If a1.output is null, return: { "error": "User not found" }
3. Otherwise, return the user data

DO NOT add print actions - just return the data.
"""
```

---

## Common Pitfalls

### 1. Hardcoding Dynamic Values
```javascript
// ❌ WRONG
{ "intent": "print", "message": "✅ 6 users created" }

// ✅ RIGHT
{ "intent": "print", "message": "✅ ${a1.output.count} users created" }
```

### 2. Using .map() in Template Variables
```javascript
// ❌ WRONG - Nested templates can't be evaluated
"${users.map(u => `| ${u.name} | ${u.age} |`).join('\n')}"

// ✅ RIGHT - Use call_llm action
{ "id": "result", "intent": "call_llm", "data": "${users}", "instruction": "Generate markdown table..." }
{ "intent": "print", "message": "${result.output.result}" }
```

### 3. Forgetting to Read Files Before Editing
The Edit and Write tools require reading files first to prevent data loss.

### 4. Missing IDs on Data-Producing Actions
```javascript
// ❌ WRONG - Can't reference later
{ "intent": "getUser", "data": { "id": "001" } }
{ "intent": "print", "message": "${a1.output.name}" }  // a1 undefined!

// ✅ RIGHT
{ "id": "a1", "intent": "getUser", "data": { "id": "001" } }
{ "intent": "print", "message": "${a1.output.name}" }
```

### 5. Environment Variables
Always use `KOI_DEBUG_LLM` (not `HARL_DEBUG_LLM` or others):
```bash
export KOI_DEBUG_LLM=1
```

---

## Future Improvements

### Potential Areas for Enhancement

1. **Type Safety**
   - Current: Relies on LLM to match data shapes
   - Future: TypeScript definitions for agent interfaces

2. **Error Recovery**
   - Current: Errors halt execution
   - Future: Retry logic, fallback handlers

3. **Performance Monitoring**
   - Current: Basic console logging
   - Future: Metrics on routing accuracy, LLM latency, action execution time

4. **Multi-Model Routing**
   - Current: Single model per agent
   - Future: Fast model for simple tasks, powerful model for complex ones

5. **Parallel Execution**
   - Current: Sequential action execution
   - Future: Detect independent actions and parallelize

6. **Registry Transactions**
   - Current: Individual operations
   - Future: Atomic multi-operation transactions

7. **Better Cache Invalidation**
   - Current: Hash-based cache for embeddings
   - Future: Smart invalidation when agent intents change

---

## Quick Reference

### File Extensions
- `.koi` - KOI source files
- `.js` - Transpiled output (in `.build/`)
- `.js.map` - Source maps for debugging

### Environment Variables
```bash
OPENAI_API_KEY=sk-...           # Required for OpenAI
ANTHROPIC_API_KEY=sk-ant-...    # Required for Claude
KOI_DEBUG_LLM=1                 # Show all LLM interactions
```

### CLI Commands
```bash
koi run <file.koi>              # Compile and run
koi run <file.koi> --debug      # With debug output
koi compile <file.koi>          # Transpile only
koi test                        # Run test suite
npm run build:grammar           # Rebuild PEG.js parser
```

### Important Directories
- `.koi-cache/` - Embedding cache (gitignored)
- `.build/` - Transpiled JavaScript (gitignored)
- `.koi-registry/` - Local registry data (gitignored)

---

## Contributing

When making changes to KOI:

1. **Test with debug enabled:** `export KOI_DEBUG_LLM=1`
2. **Check both providers:** Test with OpenAI and Anthropic
3. **Verify examples:** Run `examples/registry-playbook-demo.koi`
4. **Update this file:** Document new patterns or lessons learned
5. **Never commit:** `.env`, API keys, `.koi-cache/`, `.build/`

---

## Resources

- **Repository:** https://github.com/koi-language/Koi
- **Documentation:** `doc/` directory
- **Examples:** `examples/` directory
- **VSCode Extension:** `vscode-koi-extension/`

---

*Last Updated: 2024*
*Maintainer: Claude (Anthropic)*
