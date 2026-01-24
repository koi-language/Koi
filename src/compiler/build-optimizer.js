/**
 * Build-Time Optimizer
 *
 * Pre-computes expensive operations during compilation to avoid runtime overhead:
 * - Embeddings for agent affordances (with persistent caching)
 * - Static agent metadata
 * - Any other cacheable data
 *
 * Uses SHA-256 content hashing to detect changes and avoid redundant API calls.
 */

import { LLMProvider } from '../runtime/llm-provider.js';
import { CacheManager } from './cache-manager.js';

export class BuildTimeOptimizer {
  constructor(config = {}) {
    this.enableCache = config.cache !== false;
    this.verbose = config.verbose || false;
    this.llmProvider = null;  // For embeddings
    this.chatProvider = null;  // For code introspection
    this.cacheManager = new CacheManager({
      verbose: config.verbose || false
    });
  }

  /**
   * Extract and pre-compute affordances from AST (with cache)
   * @param ast - Abstract syntax tree
   * @param sourceContent - Original source code content (for cache hashing)
   * @param sourcePath - Path to source file (for cache tracking)
   */
  async optimizeAST(ast, sourceContent = '', sourcePath = 'unknown') {
    if (!this.enableCache) {
      if (this.verbose) console.log('[BuildOptimizer] Cache disabled, skipping');
      return null;
    }

    console.log('🔄 [BuildOptimizer] Checking cache...');

    // Check if we have cached data for this exact source content
    const cached = this.cacheManager.get(sourceContent, sourcePath);
    if (cached) {
      const totalAffordances = (cached.metadata.totalAffordances || 0) + (cached.metadata.totalSkillAffordances || 0);
      console.log(`✅ [BuildOptimizer] Using cached embeddings (${totalAffordances} affordances)`);
      console.log(`   Last generated: ${new Date(cached.metadata.generatedAt).toLocaleString()}`);
      console.log(`   💰 Saved API calls!`);
      return cached;
    }

    // Cache miss - generate embeddings
    console.log('🔄 [BuildOptimizer] Cache miss, pre-computing embeddings...');

    const affordances = {};
    const skillAffordances = {};
    let totalEmbeddings = 0;
    let totalSkillEmbeddings = 0;

    // Find all declarations in AST
    for (const decl of ast.declarations) {
      if (decl.type === 'AgentDecl') {
        const agentAffordances = await this.extractAgentAffordances(decl);

        if (agentAffordances && Object.keys(agentAffordances).length > 0) {
          affordances[decl.name.name] = agentAffordances;
          totalEmbeddings += Object.keys(agentAffordances).length;
        }
      } else if (decl.type === 'SkillDecl') {
        const skillData = await this.extractSkillAffordance(decl);

        if (skillData) {
          skillAffordances[decl.name.name] = skillData;
          totalSkillEmbeddings++;
        }
      }
    }

    console.log(`✅ [BuildOptimizer] Pre-computed ${totalEmbeddings + totalSkillEmbeddings} embeddings (${totalEmbeddings} agents, ${totalSkillEmbeddings} skills)`);

    const result = {
      affordances,
      skillAffordances,
      metadata: {
        generatedAt: Date.now(),
        totalAgents: Object.keys(affordances).length,
        totalAffordances: totalEmbeddings,
        totalSkills: Object.keys(skillAffordances).length,
        totalSkillAffordances: totalSkillEmbeddings
      }
    };

    // Store in cache
    this.cacheManager.set(sourceContent, sourcePath, result);

    return result;
  }

  /**
   * Extract and pre-compute affordances from AST (without cache)
   * Generates embeddings but doesn't store them in persistent cache
   * @param ast - Abstract syntax tree
   */
  async optimizeASTWithoutCache(ast) {
    const affordances = {};
    let totalEmbeddings = 0;

    // Find all agent declarations in AST
    for (const decl of ast.declarations) {
      if (decl.type === 'AgentDecl') {
        const agentAffordances = await this.extractAgentAffordances(decl);

        if (agentAffordances && Object.keys(agentAffordances).length > 0) {
          affordances[decl.name.name] = agentAffordances;
          totalEmbeddings += Object.keys(agentAffordances).length;
        }
      }
    }

    console.log(`✅ [BuildOptimizer] Pre-computed ${totalEmbeddings} embeddings (no cache)`);

    return {
      affordances,
      metadata: {
        generatedAt: Date.now(),
        totalAgents: Object.keys(affordances).length,
        totalAffordances: totalEmbeddings
      }
    };
  }

  /**
   * Extract affordances for a single agent
   */
  async extractAgentAffordances(agentNode) {
    const affordances = {};

    // Find event handlers
    const eventHandlers = agentNode.body.filter(b => b.type === 'EventHandler');

    if (eventHandlers.length === 0) {
      return affordances;
    }

    if (this.verbose) {
      console.log(`  [Agent:${agentNode.name.name}] Extracting ${eventHandlers.length} affordances...`);
    }

    for (const handler of eventHandlers) {
      const eventName = handler.event.name;

      // Try to find playbook
      const playbook = this.findPlaybookForHandler(handler);

      let description;
      let confidence;
      let hasPlaybook = false;

      if (playbook) {
        // Extract description from playbook
        description = this.inferIntentFromPlaybook(playbook, eventName);
        confidence = 0.9;
        hasPlaybook = true;
      } else {
        // No playbook - use code introspection
        description = await this.introspectHandlerCode(handler, eventName);
        confidence = 0.8; // High confidence since we analyzed the actual code
        hasPlaybook = false;
      }

      // Validate description
      if (!description || description.trim() === '') {
        console.warn(`⚠️  [BuildOptimizer] Empty description for ${agentNode.name.name}.${eventName}, skipping embedding`);
        description = `Handler: ${eventName}`;
      }

      // Generate embedding
      const embedding = await this.generateEmbedding(description);

      affordances[eventName] = {
        description: description,
        embedding: embedding,
        confidence: confidence,
        hasPlaybook: hasPlaybook
      };

      if (this.verbose) {
        console.log(`    ✓ ${eventName}: "${description.substring(0, 50)}..."`);
      }
    }

    return affordances;
  }

  /**
   * Find playbook for an event handler
   */
  findPlaybookForHandler(handler) {
    // Check if handler has a playbook statement
    for (const stmt of handler.body) {
      if (stmt.type === 'PlaybookStatement') {
        return stmt.content.value;
      }
    }

    return null;
  }

  /**
   * Infer intent from playbook text
   */
  inferIntentFromPlaybook(playbook, eventName) {
    // Handle non-string playbooks
    if (!playbook || typeof playbook !== 'string') {
      return this.humanizeEventName(eventName);
    }

    // Remove template literals
    const cleanText = playbook
      .replace(/\$\{[^}]+\}/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//') && !line.startsWith('Return'))
      .slice(0, 3) // Take first 3 lines
      .join(' ');

    if (cleanText.length > 10 && cleanText.length < 200) {
      return cleanText;
    }

    // Fallback
    return this.humanizeEventName(eventName);
  }

  /**
   * Introspect handler code using LLM to understand what it does
   * @param handler - Event handler AST node
   * @param eventName - Name of the event
   * @returns Description of what the handler does
   */
  async introspectHandlerCode(handler, eventName) {
    // Serialize the handler body to source code
    const codeLines = [];

    for (const stmt of handler.body) {
      const code = this.serializeStatement(stmt);
      if (code) {
        codeLines.push(code);
      }
    }

    const sourceCode = codeLines.join('\n');

    // If no code, fallback to event name
    if (!sourceCode || sourceCode.trim().length === 0) {
      return this.humanizeEventName(eventName);
    }

    // Use LLM to analyze the code
    if (!this.chatProvider) {
      this.initChatProvider();
    }

    const introspectionPrompt = `Analyze this event handler code and provide a concise description (1-2 sentences) of what it does.

Event name: ${eventName}

Code:
\`\`\`javascript
${sourceCode}
\`\`\`

Focus on:
- What operations it performs
- What data it processes or returns
- Its main purpose or capability

Return ONLY the description text, no markdown, no explanations, no prefix like "This handler...". Just a direct description.`;

    try {
      const response = await this.chatProvider.executeOpenAI(introspectionPrompt, false);

      // Clean up the response
      const description = response
        .replace(/^(This handler|This event handler|This function|The handler|The function)\s*/i, '')
        .replace(/^(handles?|processes?|performs?)\s*/i, '')
        .trim();

      if (description && description.length > 10) {
        return description;
      }
    } catch (error) {
      console.warn(`[BuildOptimizer] Code introspection failed for ${eventName}:`, error.message);
    }

    // Fallback to humanized event name
    return this.humanizeEventName(eventName);
  }

  /**
   * Serialize an AST statement to source code (simplified)
   */
  serializeStatement(stmt) {
    if (!stmt) return '';

    switch (stmt.type) {
      case 'ConstDeclaration':
        return `const ${stmt.name.name} = ...`;

      case 'ReturnStatement':
        if (stmt.value && stmt.value.type === 'ObjectLiteral') {
          // Extract object keys
          const keys = stmt.value.properties?.map(p => p.key?.name || p.key).join(', ') || '';
          return `return { ${keys} }`;
        }
        return 'return ...';

      case 'SendStatement':
        const role = stmt.role?.name || 'Role';
        const event = stmt.event?.name || 'event';
        return `send to ${role}.${event}()`;

      case 'ExpressionStatement':
        if (stmt.expression?.type === 'CallExpression') {
          const callee = stmt.expression.callee?.name || stmt.expression.callee?.property?.name || 'function';
          return `${callee}(...)`;
        }
        return '...';

      default:
        return `// ${stmt.type}`;
    }
  }

  /**
   * Extract affordance for a skill
   */
  async extractSkillAffordance(skillNode) {
    // Skills have an explicit affordance field
    const affordanceText = skillNode.affordance?.value || skillNode.affordance || '';

    if (!affordanceText || affordanceText.trim().length === 0) {
      // No affordance defined - use skill name as fallback
      const description = this.humanizeEventName(skillNode.name.name);
      return {
        description,
        embedding: await this.generateEmbedding(description),
        confidence: 0.5
      };
    }

    // Clean up affordance text (remove extra whitespace/newlines)
    let cleanDescription = affordanceText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join(' ')
      .trim();

    // Validate description is not empty
    if (!cleanDescription || cleanDescription.length === 0) {
      cleanDescription = this.humanizeEventName(skillNode.name.name);
    }

    // Generate embedding for the affordance
    const embedding = await this.generateEmbedding(cleanDescription);

    if (this.verbose) {
      console.log(`    ✓ Skill ${skillNode.name.name}: "${cleanDescription.substring(0, 50)}..."`);
    }

    return {
      description: cleanDescription,
      embedding: embedding,
      confidence: 0.9
    };
  }

  /**
   * Humanize event name
   */
  humanizeEventName(eventName) {
    return eventName
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .toLowerCase()
      .trim();
  }

  /**
   * Initialize chat LLM provider for code introspection
   */
  initChatProvider() {
    this.chatProvider = new LLMProvider({
      provider: 'openai',
      model: 'gpt-4o-mini',  // Fast and cheap model for code analysis
      temperature: 0.1,
      maxTokens: 150
    });
  }

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text) {
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider({
        provider: 'openai',
        model: 'text-embedding-3-small'
      });
    }

    try {
      return await this.llmProvider.getEmbedding(text);
    } catch (error) {
      console.warn(`[BuildOptimizer] Failed to generate embedding: ${error.message}`);
      return null;
    }
  }

  /**
   * Generate JavaScript code for cached data
   */
  generateCacheCode(cacheData) {
    if (!cacheData) {
      return '';
    }

    const totalAffordances = (cacheData.metadata.totalAffordances || 0) + (cacheData.metadata.totalSkillAffordances || 0);

    const code = `
// ============================================================
// Pre-computed Affordances (Build-time Cache)
// Generated at: ${new Date(cacheData.metadata.generatedAt).toISOString()}
// Total agents: ${cacheData.metadata.totalAgents || 0}
// Total agent affordances: ${cacheData.metadata.totalAffordances || 0}
// Total skills: ${cacheData.metadata.totalSkills || 0}
// Total skill affordances: ${cacheData.metadata.totalSkillAffordances || 0}
// ============================================================

const CACHED_AFFORDANCES = ${JSON.stringify(cacheData.affordances || {}, null, 2)};

const CACHED_SKILL_AFFORDANCES = ${JSON.stringify(cacheData.skillAffordances || {}, null, 2)};

`;

    return code;
  }
}
