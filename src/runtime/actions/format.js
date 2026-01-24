/**
 * Format Action - Use LLM to transform/format data dynamically
 */

export default {
  type: 'format',
  intent: 'format',
  description: 'Use LLM to format/transform data according to instructions → Returns: { formatted: "result text" }. Access with ${id.output.formatted}. IMPORTANT: format action MUST have an "id" to save the result!',
  permission: 'execute',

  schema: {
    type: 'object',
    properties: {
      data: {
        description: 'Data to format (any type: object, array, string, etc.)'
      },
      instruction: {
        type: 'string',
        description: 'Natural language instruction describing how to format the data'
      }
    },
    required: ['data', 'instruction']
  },

  examples: [
    {
      type: 'format',
      data: '${previousResult.users}',
      instruction: 'Generate a markdown table with columns: Sr/Sra (deduce from name), Name, Age'
    }
  ],

  async execute(action, agent) {
    const { data, instruction } = action;

    if (!instruction) {
      throw new Error('Format action requires an instruction');
    }

    if (!agent.llmProvider) {
      throw new Error('Agent does not have an LLM provider configured');
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent] 🎨 Formatting data with LLM (instruction: "${instruction.substring(0, 50)}...")`);
      console.error(`[Agent] 📊 Data received:`, JSON.stringify(data, null, 2));
    }

    try {
      // Call OpenAI directly for a simple formatting task
      const completion = await agent.llmProvider.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: `You are a data formatter. Your job is to transform data according to user instructions.

CRITICAL RULES:
1. Return ONLY the formatted output - NO explanations, NO markdown wrapping, NO code blocks, NO JSON
2. Follow the instruction exactly as specified
3. NEVER generate template variables (\${...}) or placeholders ([name], {x}, [DD]) - use ACTUAL VALUES from data
4. When calculations are needed (dates, time differences, derived values), perform them accurately
5. Use the most authoritative data source available (e.g., birthdate over age field, timestamps over derived dates)
6. Current date for any time-based calculations: ${new Date().toISOString().split('T')[0]}
7. If instruction says "generate emails", "generate text", "format as", output formatted TEXT - NOT JSON or arrays
8. Default output should be human-readable text unless instruction explicitly asks for JSON/table/specific format

CALCULATION REQUIREMENTS:
- Parse all date/time fields carefully, supporting multiple formats
- For derived values (age, days remaining, time elapsed), calculate accurately from source data
- When calculating age: current_year - birth_year, then subtract 1 if birthday hasn't occurred yet this year
- Use birthdate field as authoritative source, ignore any "age" field as it may be stale
- Verify results make logical sense (e.g., age should be positive and reasonable)

EMAIL/TEXT GENERATION:
- When generating emails or personalized text, create properly formatted text for each item
- Include salutations, body text, and sign-offs as appropriate
- Separate multiple emails/items with blank lines
- Use natural, human-friendly language
- Infer formatting details from context (e.g., "Estimado" vs "Estimada" based on names ending in 'a')`
          },
          {
            role: 'user',
            content: `IMPORTANT: Today's date is ${new Date().toISOString().split('T')[0]}. Use this for all date calculations.

Data:
${JSON.stringify(data, null, 2)}

Instruction:
${instruction}

Output (formatted result only):`
          }
        ]
      });

      let formattedText = completion.choices[0].message.content.trim();

      // Clean up any markdown code blocks that might have leaked through
      formattedText = formattedText.replace(/^```[\w]*\n/gm, '').replace(/\n```$/gm, '');
      formattedText = formattedText.trim();

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Agent] ✅ Formatted ${formattedText.length} characters`);
      }

      return { formatted: formattedText };
    } catch (error) {
      console.error(`[Agent] ❌ Format action failed: ${error.message}`);
      throw error;
    }
  }
};
