# Koi

**Agent-first language. Calm orchestration.** 🌊

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-koi--language%2Fkoi-6495ED?logo=github)](https://github.com/koi-language/koi)
[![VSCode Extension](https://img.shields.io/badge/VSCode-Extension-007ACC?logo=visualstudiocode)](vscode-koi-extension/)
[![Syntax Highlighting](https://img.shields.io/badge/GitHub-Syntax_Highlighting-6495ED?logo=github)](LINGUIST.md)

Koi is a multi-agent orchestration language with role-based routing.

> **🚀 New to Koi?** Check out the [Quick Start Guide](QUICKSTART.md) for a 2-minute setup!
>
> **📚 Complete Documentation**: See the [doc/](doc/) directory for comprehensive guides

## Architecture

### Key Concepts

- **Playbook**: Natural language instructions that define agent behavior
- **Agent**: Autonomous worker with a role, executes playbooks
- **Role**: Abstract capabilities (can delegate, can execute, can critique)
- **Team**: Agent composition that enables collaboration
- **Skill**: Reusable capability with internal logic and agents
- **Registry**: Shared data store for agent coordination and state persistence
- **Automatic Routing**: Routes by role+capability, NEVER by agent name

### 🆕 Automatic Intelligent Routing + Task Chaining

Write agent behavior in **natural language** - the system handles everything else:

- **Playbook-driven** - Write WHAT you want in plain language, not HOW to do it
- **Automatic decomposition** - Complex tasks break into atomic actions automatically
- **Task chaining** - Output of each action becomes input for the next
- **Intelligent routing** - Each action finds the right agent via semantic matching
- **Zero orchestration** - No manual wiring, no hardcoded workflows
- **Self-organizing** - Agents discover and collaborate automatically

See [doc/07-routing.md](doc/07-routing.md) and [doc/08-task-chaining.md](doc/08-task-chaining.md) for details.

### Execution Flow

1. **Playbook Execution**: Agent receives natural language instructions
2. **Automatic Planning**: System decomposes complex tasks into atomic actions
3. **Action Resolution**: For each action, cascading logic determines execution:
   - Can I handle it myself? (check own handlers)
   - Do I have a skill for this? (check local skills)
   - Is it simple enough to execute directly? (direct execution)
   - Can a team member handle it? (intelligent semantic routing)
4. **Result Chaining**: Output from each action flows to the next automatically

## Installation

### Local Development

For working on Koi itself:

```bash
npm install
npm run build:grammar
```

**Development with local runtime:**

When developing Koi, use `KOI_RUNTIME_PATH` to point to your local runtime without reinstalling:

```bash
# Set environment variable
export KOI_RUNTIME_PATH=/path/to/koi/src/runtime

# Or use .env.development file (copy and edit)
cp .env.development .env
# Edit KOI_RUNTIME_PATH to point to your local Koi installation

# Now run projects - they'll use your local runtime
koi run examples/hello-world.koi
```

This allows you to modify the runtime and test changes immediately without `npm install -g` each time.

### Global Installation

Install Koi as a global command:

```bash
npm install -g .
```

Or from npm (when published):

```bash
npm install -g koi-lang
```

After global installation, you can use `koi` directly:

```bash
koi run examples/hello-world.koi
koi compile examples/simple.koi
koi init my-project
koi version
koi help
```

### Uninstall

```bash
npm uninstall -g koi-lang
```

## Editor Support

### VS Code & Cursor Extension

Get **syntax highlighting** and language support for `.koi` files:

```bash
# Quick install (from project root)
cd vscode-koi-extension
ln -s "$(pwd)" ~/.vscode/extensions/koi-lang  # VS Code
ln -s "$(pwd)" ~/.cursor/extensions/koi-lang  # Cursor

# Then restart your editor
```

**Features:**
- ✨ Full syntax highlighting
- 🎨 Custom "Koi Dark" theme
- 🔤 Auto-closing brackets and quotes
- 📝 Special playbook highlighting
- 🎯 Semantic token colors

See [vscode-koi-extension/README.md](vscode-koi-extension/README.md) for details.

## GitHub Syntax Highlighting

KOI code blocks in markdown files (README, Issues, PRs) automatically get syntax highlighting on GitHub!

````markdown
```koi
Agent Hello : Worker {
  on greet(args: Json) {
    console.log("Hello from KOI!")
  }
}
```
````

**Status:**
- ✅ **Current**: Using JavaScript highlighting (very similar syntax)
- 🚀 **Soon**: Native KOI highlighting (PR submitted to [github/linguist](https://github.com/github/linguist))

Once the PR is merged, GitHub will recognize `.koi` files with:
- 🎨 Cornflower Blue (#6495ED) in language statistics
- ✨ Full syntax highlighting for code blocks
- 📊 Language detection in repositories

See [LINGUIST.md](LINGUIST.md) for technical details and contribution status.

## Usage

### With Global Installation

If you installed Koi globally, use the `koi` command directly:

```bash
koi compile examples/simple.koi
koi run examples/simple.koi
koi init my-project
```

### With Local Development

If working on Koi itself, use `node src/cli/koi.js`:

```bash
node src/cli/koi.js compile examples/simple.koi
node src/cli/koi.js run examples/simple.koi
```

Or use npm scripts:

```bash
npm run compile examples/simple.koi
npm run run examples/simple.koi
```

### Debugging

To run with Node.js inspector:

```bash
npm run dev examples/simple.koi
# or
node --inspect src/cli/koi.js run examples/simple.koi
```

Then open Chrome DevTools at `chrome://inspect`.

## Syntax

### Define Roles

```koi
role Worker   { can execute, can propose }
role Reviewer { can critique, can approve }
role Lead     { can delegate, can decide }
```

### Define Agents

Agents describe their behavior in natural language using **playbooks**:

```koi
Agent Analyzer : Worker {
  uses Skill DataAnalysis
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on analyze(args: Json) {
    playbook """
    Analyze the data: ${args.data}

    Look for patterns, trends, and anomalies.
    Provide actionable insights.

    Return JSON: { insights: [...], summary: "...", confidence: 0-1 }
    """
  }
}
```

**For technical operations** (like fetching data), use procedural code:
```koi
Agent DataFetcher : Worker {
  on fetch(args: Json) {
    const response = await fetch(args.url)
    const data = await response.json()
    return { data: data }
  }
}
```

### Define Teams

```koi
Team Development {
  analyzer   = Analyzer
  calculator = Calculator
}
```

### Role-based Routing

```koi
Agent Orchestrator : Lead {
  uses Team Development
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on start(args: Json) {
    playbook """
    Task: ${args.task}

    Work with the development team to complete this task.
    Coordinate with team members based on their capabilities.
    """
  }
}
```

Agents automatically route to appropriate team members - no hardcoded names needed!

### MCP (Model Context Protocol) Support

Reference remote agents and services using MCP addresses:

```koi
Team HybridTeam {
  local = LocalAgent
  remote = mcp://agent.local/processor
  skill = mcp://skills.local/sentiment
}

Agent Orchestrator : Worker {
  uses Team HybridTeam

  on start(args: Json) {
    // Executes on local or remote agent transparently
    const result =
      await send peers.event("process").role(Worker).any()(args)
    return result
  }
}
```

See [MCP_GUIDE.md](MCP_GUIDE.md) for complete documentation.

### Define Skills

```koi
Skill SentimentAnalysis {
  affordance """
  Analyzes text sentiment and returns positive/neutral/negative.
  """

  Agent Analyst : Worker {
    llm default = { provider: "openai", model: "gpt-4o-mini" }

    on analyze(args: Json) {
      playbook """
      Text: ${args.text}

      Analyze the sentiment of this text:
      - Determine overall tone (positive, neutral, negative)
      - Rate emotional intensity (0.0 to 1.0)
      - Identify key emotional indicators

      Return JSON: {
        "sentiment": "positive|neutral|negative",
        "score": 0.0-1.0,
        "keywords": ["word1", "word2", ...],
        "rationale": "brief explanation"
      }
      """
    }
  }

  Team Internal {
    analyst = Analyst
  }

  export async function run(input: any): Promise<any> {
    const result = await send Internal.event("analyze").role(Worker).any()(input)
    return result
  }
}
```

### Using Skills in Agents

Agents can use skills for technical operations while keeping behavior in natural language:

```koi
import "./skills/email-reader.koi"  // Skill for IMAP email operations

Agent EmailAssistant : Worker {
  uses Skill EmailReader
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on processInbox(args: Json) {
    playbook """
    Lee los últimos mensajes de correo y contesta aquellos que
    vengan de proveedores automáticamente.

    Para cada email de proveedor:
    - Analiza el contenido y el remitente
    - Genera una respuesta profesional apropiada
    - Marca como procesado

    Ignora emails personales o de clientes.
    """
  }
}
```

**Skills** = Technical operations (IMAP, databases, APIs)
**Playbooks** = Natural language behavior

### Execute

```koi
run EmailAssistant.processInbox({ email: "user@company.com", since: "2024-01-01" })
```

## Examples

### 🆕 Task Chaining (Recommended Start)

Shows how outputs automatically chain into inputs between tasks:

```bash
koi run examples/task-chaining-demo.koi
```

Example: "Translate to French and count words"
- Action 1: Translate → `{ translated: "bonjour monde" }`
- Action 2: Count words on `${previousResult.translated}` → `{ wordCount: 2 }`

See [TASK_CHAINING_GUIDE.md](TASK_CHAINING_GUIDE.md) for details.

### 🆕 Automatic Routing

Shows how ANY agent can automatically decompose and delegate tasks:

```bash
koi run examples/auto-routing-demo.koi
```

Key concepts:
- Regular agents receiving complex tasks
- Automatic decomposition by LLM
- Cascading resolution (own handlers → skills → team routing)
- Intelligent semantic matching via embeddings

See [AUTO_ROUTING_GUIDE.md](AUTO_ROUTING_GUIDE.md) for explanation.

### Simple

Minimal example showing agent communication:

```bash
koi run examples/simple.koi
```

### Counter

Stateful agent with counter operations:

```bash
koi run examples/counter.koi
```

### Calculator

Basic calculator with multiple operations:

```bash
koi run examples/calculator.koi
```

### Pipeline

Multi-stage data processing pipeline:

```bash
koi run examples/pipeline.koi
```

### Sentiment Analysis

Sentiment analysis skill with 2 internal agents:

```bash
koi run examples/sentiment.koi
```

### MCP Integration

Example showing MCP (Model Context Protocol) address support:

```bash
koi run examples/mcp-example.koi
```

### Automatic Planning

Demonstrates automatic planning system where agents can decompose complex goals:

```bash
koi run examples/planning-demo.koi
```

### Planning with Actions

Shows how LLM can plan and generate executable actions:

```bash
koi run examples/planning-with-actions.koi
```

See [PLANNING_GUIDE.md](PLANNING_GUIDE.md) for detailed planning system documentation.

## Source Maps

Koi generates source maps automatically. Runtime errors show the location in the original `.koi` source, not the generated JavaScript.

## Project Structure

```
.
├── package.json
├── README.md
├── src/
│   ├── grammar/
│   │   └── koi.pegjs              # PEG grammar
│   ├── compiler/
│   │   ├── parser.js              # Generated parser (auto)
│   │   └── transpiler.js          # Transpiler to JS + source maps
│   ├── runtime/
│   │   ├── agent.js               # Agent runtime
│   │   ├── team.js                # Team runtime
│   │   ├── skill.js               # Skill runtime
│   │   ├── role.js                # Role runtime
│   │   ├── runtime.js             # Main runtime
│   │   └── index.js               # Exports
│   └── cli/
│       └── koi.js                 # Main CLI
└── examples/
    ├── simple.koi                 # Simple example
    ├── counter.koi                # Counter example
    ├── calculator.koi             # Calculator example
    ├── pipeline.koi               # Pipeline example
    └── sentiment.koi              # Sentiment analysis
```

## Documentation

Comprehensive documentation is available in the [doc/](doc/) directory:

- **[Getting Started](doc/00-getting-started.md)** - Installation and your first agent
- **[Core Concepts](doc/01-core-concepts.md)** - Understanding Roles, Agents, Teams, Skills
- **[Syntax Basics](doc/02-syntax-basics.md)** - Variables, types, control flow
- **[Agents Guide](doc/03-agents.md)** - Creating and using agents
- **[Roles & Teams](doc/04-roles-and-teams.md)** - Multi-agent systems
- **[Skills](doc/05-skills.md)** - Reusable capabilities
- **[LLM Integration](doc/06-llm-integration.md)** - Using real LLMs with playbooks
- **[Automatic Routing](doc/07-routing.md)** - Intelligent agent selection
- **[Task Chaining](doc/08-task-chaining.md)** - Output-to-input chaining
- **[Planning System](doc/09-planning.md)** - Automatic task decomposition
- **[MCP Protocol](doc/10-mcp-integration.md)** - Remote agents and services
- **[TypeScript Imports](doc/11-typescript-imports.md)** - Using npm packages
- **[Testing](doc/12-testing.md)** - Unit testing with Jest
- **[Caching](doc/13-caching.md)** - Persistent LLM response caching
- **[Examples](doc/14-examples.md)** - Complete working examples
- **[Advanced Topics](doc/15-advanced.md)** - Debugging, performance, production
- **[Registry](doc/16-registry.md)** - Shared data store for agent coordination

## Roadmap

- [X] MCP (Model Context Protocol) addresses support
- [X] Real LLM integration with OpenAI/Anthropic
- [X] **Full MCP protocol implementation** (WebSocket/HTTP2)
  - [X] Real protocol support (WebSocket & HTTP/2)
  - [X] Authentication and authorization
  - [X] Server discovery
  - [X] Connection pooling and load balancing
  - [X] Retry logic and failover
  - [X] Streaming responses
  - [X] MCP tools integration
- [X] Automatic planning system for agents
  - [X] LLM-based goal decomposition
  - [X] Sequential step execution
  - [X] Automatic re-planning on failure
  - [X] Context passing between steps
  - [X] Execution tracking and summaries
- [X] TypeScript/JavaScript import support
- [X] Unit testing with Jest
- [X] VSCode/Cursor extension with syntax highlighting
- [X] GitHub syntax highlighting support
- [ ] Skills registry and marketplace
- [ ] Visual debugging
- [ ] Hot reload in development

## Contributing

Contributions are welcome! Here are some ways you can help:

- 🐛 Report bugs and issues
- 💡 Suggest new features or improvements
- 📝 Improve documentation
- 🎨 Help with GitHub Linguist PR (see [LINGUIST.md](LINGUIST.md))
- 🔧 Submit pull requests

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Resources

- **Documentation**: [doc/](doc/) - Comprehensive guides
- **Quick Start**: [QUICKSTART.md](QUICKSTART.md) - 2-minute setup
- **Examples**: [examples/](examples/) - Working code samples
- **VSCode Extension**: [vscode-koi-extension/](vscode-koi-extension/)
- **AI Assistant Guide**: [CLAUDE.md](CLAUDE.md) - Architecture and patterns
- **Syntax Highlighting**: [LINGUIST.md](LINGUIST.md) - GitHub support status

## Community

- **Issues**: [github.com/koi-language/koi/issues](https://github.com/koi-language/koi/issues)
- **Discussions**: [github.com/koi-language/koi/discussions](https://github.com/koi-language/koi/discussions)

## License

MIT
