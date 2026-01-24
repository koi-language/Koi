/**
 * Agent Router with Intelligent Semantic Matching
 *
 * Uses a hybrid approach:
 * 1. Fast embedding-based similarity search for initial filtering
 * 2. LLM-based disambiguation when needed
 *
 * This allows agents to automatically discover and route tasks to the
 * appropriate agent based on semantic understanding of capabilities.
 */

import { LLMProvider } from './llm-provider.js';
import { cliLogger } from './cli-logger.js';

export class AgentRouter {
  constructor(config = {}) {
    this.agents = new Map(); // Map<agentName, agent>
    this.affordanceEmbeddings = []; // Array of { agent, event, description, embedding, confidence }
    this.embeddingProvider = null;
    this.llmProvider = null;

    // Configuration
    this.similarityThreshold = config.similarityThreshold || 0.4;  // Balanced threshold for semantic matching
    this.highConfidenceThreshold = config.highConfidenceThreshold || 0.85;
    this.useLLMDisambiguation = config.useLLMDisambiguation !== false;
    this.cacheEmbeddings = config.cacheEmbeddings !== false;
    this.verbose = config.verbose || false;
  }

  /**
   * Register an agent and extract its affordances
   * @param agent - The agent to register
   * @param cachedAffordances - Optional pre-computed affordances from build cache
   */
  async register(agent, cachedAffordances = null) {
    if (!agent || !agent.name) {
      return;
    }

    this.agents.set(agent.name, agent);

    // Use cached affordances if available
    if (cachedAffordances) {
      for (const [eventName, aff] of Object.entries(cachedAffordances)) {
        if (!aff.embedding) {
          // Fallback: generate at runtime if cache is incomplete
          if (aff.description && aff.description.trim() !== '') {
            aff.embedding = await this.getEmbedding(aff.description);
          } else {
            console.warn(`⚠️  [Router] Skipping ${agent.name}.${eventName} - empty description`);
            continue;
          }
        }

        this.affordanceEmbeddings.push({
          agent: agent,
          event: eventName,
          description: aff.description,
          embedding: aff.embedding,
          confidence: aff.confidence,
          metadata: { hasPlaybook: aff.hasPlaybook }
        });
      }

      return;
    }

    // No cache: extract and generate affordances at runtime
    const affordances = this.extractAffordances(agent);

    // Generate embeddings for each affordance
    for (const aff of affordances) {
      if (!aff.description || aff.description.trim() === '') {
        console.warn(`⚠️  [Router] Skipping ${agent.name}.${aff.event} - empty description`);
        continue;
      }

      const embedding = await this.getEmbedding(aff.description);

      this.affordanceEmbeddings.push({
        agent: agent,
        event: aff.event,
        description: aff.description,
        embedding: embedding,
        confidence: aff.confidence,
        metadata: aff.metadata
      });
    }
  }

  /**
   * Extract affordances from an agent by analyzing its handlers and playbooks
   */
  extractAffordances(agent) {
    const affordances = [];

    if (!agent.handlers) {
      return affordances;
    }

    for (const [eventName, handler] of Object.entries(agent.handlers)) {
      // Try to infer description from playbook
      const playbook = agent.playbooks?.[eventName];

      let description;
      let confidence;

      if (playbook) {
        description = this.inferIntentFromPlaybook(playbook, eventName);
        confidence = 0.9; // High confidence when we have playbook
      } else {
        description = `Handle ${eventName} event`;
        confidence = 0.5; // Lower confidence without playbook
      }

      affordances.push({
        event: eventName,
        description: description,
        confidence: confidence,
        metadata: {
          hasPlaybook: !!playbook,
          role: agent.role?.name
        }
      });
    }

    return affordances;
  }

  /**
   * Infer the intent/capability from a playbook text
   */
  inferIntentFromPlaybook(playbook, eventName) {
    // Remove template literals and get clean text
    const cleanText = playbook
      .replace(/\$\{[^}]+\}/g, '') // Remove ${...}
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//'))
      .slice(0, 3) // Take first 3 meaningful lines
      .join(' ');

    // If we got something meaningful, use it
    if (cleanText.length > 10 && cleanText.length < 200) {
      return cleanText;
    }

    // Fallback to event name processing
    return this.humanizeEventName(eventName);
  }

  /**
   * Convert camelCase/snake_case event names to readable descriptions
   */
  humanizeEventName(eventName) {
    return eventName
      .replace(/([A-Z])/g, ' $1') // camelCase
      .replace(/_/g, ' ') // snake_case
      .toLowerCase()
      .trim();
  }

  /**
   * Get embedding for text (with caching)
   */
  async getEmbedding(text) {
    if (!this.embeddingProvider) {
      this.embeddingProvider = new LLMProvider({
        provider: 'openai',
        model: 'text-embedding-3-small'
      });
    }

    return await this.embeddingProvider.getEmbedding(text);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      return 0;
    }

    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Find matching agents using hybrid approach (embeddings + optional LLM)
   */
  async findMatches(intent, topK = 3) {
    if (this.affordanceEmbeddings.length === 0) {
      return [];
    }

    // Validate intent
    if (!intent || typeof intent !== 'string' || intent.trim() === '') {
      return [];
    }

    // Phase 1: Embedding-based similarity search
    const intentEmbedding = await this.getEmbedding(intent);

    const similarities = this.affordanceEmbeddings.map(aff => ({
      ...aff,
      similarity: this.cosineSimilarity(intentEmbedding, aff.embedding)
    }));

    // Sort by similarity descending
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Filter by threshold
    const candidates = similarities
      .filter(s => s.similarity >= this.similarityThreshold)
      .slice(0, Math.max(topK, 5)); // Get at least top 5 for LLM phase

    if (candidates.length === 0) {
      return [];
    }

    // Phase 2: High confidence early exit
    if (candidates[0].similarity >= this.highConfidenceThreshold) {
      return [candidates[0]];
    }

    // Phase 3: LLM disambiguation if multiple similar candidates
    if (this.useLLMDisambiguation && candidates.length > 1) {
      const topCandidates = candidates.slice(0, topK);

      // Check if top candidates are close in similarity (ambiguous)
      const similarityRange = topCandidates[0].similarity - topCandidates[topCandidates.length - 1].similarity;

      if (similarityRange < 0.15) { // Within 15% similarity - ambiguous
        return await this.disambiguateWithLLM(intent, topCandidates);
      }
    }

    // Return top candidate
    return [candidates[0]];
  }

  /**
   * Use LLM to disambiguate between similar candidates
   */
  async disambiguateWithLLM(intent, candidates) {
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider({
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 300
      });
    }

    const candidateDescriptions = candidates.map((c, idx) => ({
      id: idx,
      agent: c.agent.name,
      event: c.event,
      description: c.description,
      similarity: (c.similarity * 100).toFixed(1) + '%',
      role: c.metadata?.role
    }));

    const prompt = `You are a task router. Select the BEST agent to handle this specific task.

Task intent: "${intent}"

Available agents (pre-filtered by semantic similarity):
${JSON.stringify(candidateDescriptions, null, 2)}

Which agent is the BEST match? Consider:
- Semantic meaning and nuances of the task
- Agent descriptions and capabilities
- Task-specific requirements

Return ONLY valid JSON (no markdown):
{
  "best_match_id": <id from 0 to ${candidates.length - 1}>,
  "confidence": <number 0-1>,
  "reasoning": "brief 1-sentence explanation"
}`;

    try {
      const result = await this.llmProvider.executePlaybook(prompt, {});

      if (typeof result.best_match_id === 'number' && result.best_match_id >= 0 && result.best_match_id < candidates.length) {
        const selected = candidates[result.best_match_id];

        return [{
          ...selected,
          similarity: result.confidence,
          reasoning: result.reasoning,
          llmDisambiguated: true
        }];
      } else {
        return [candidates[0]];
      }
    } catch (error) {
      return [candidates[0]];
    }
  }

  /**
   * Check if any agent can handle this intent
   */
  async canHandle(intent) {
    const matches = await this.findMatches(intent, 1);
    return matches.length > 0;
  }

  /**
   * Get list of agents that can handle this intent
   */
  async whoCanHandle(intent, topK = 3) {
    const matches = await this.findMatches(intent, topK);
    return matches.map(m => ({
      agent: m.agent.name,
      event: m.event,
      description: m.description,
      similarity: m.similarity,
      confidence: m.confidence,
      reasoning: m.reasoning
    }));
  }

  /**
   * Route a task to the best matching agent
   */
  async route(task) {
    const intent = task.intent || task.description || task.type;

    if (!intent) {
      throw new Error('[Router] Task must have an intent, description, or type');
    }

    const matches = await this.findMatches(intent, 1);

    if (matches.length === 0) {
      throw new Error(`[Router] No agent can handle: "${intent}"`);
    }

    const best = matches[0];

    // Execute the task on the selected agent
    return await best.agent.handle(best.event, task.data || {});
  }

  /**
   * Get summary of registered agents and their capabilities
   */
  getSummary() {
    const agentSummaries = [];

    for (const [name, agent] of this.agents) {
      const affordances = this.affordanceEmbeddings
        .filter(aff => aff.agent === agent)
        .map(aff => ({
          event: aff.event,
          description: aff.description,
          confidence: aff.confidence
        }));

      agentSummaries.push({
        name: name,
        role: agent.role?.name,
        affordances: affordances
      });
    }

    return {
      totalAgents: this.agents.size,
      totalAffordances: this.affordanceEmbeddings.length,
      agents: agentSummaries
    };
  }

  /**
   * Clear all registered agents (useful for testing)
   */
  clear() {
    this.agents.clear();
    this.affordanceEmbeddings = [];
  }
}

// Singleton instance for global use
export const agentRouter = new AgentRouter();
