# Koi Language Support for VS Code & Cursor

**Syntax highlighting and language support for Koi** - Agent-first orchestration language. 🌊

## Features

- ✨ **Syntax Highlighting** - Full syntax highlighting for `.koi` files
- 🔍 **Go to Definition** - Cmd+Click (Mac) or Ctrl+Click (Windows/Linux) to jump to:
  - Skill definitions
  - Agent definitions
  - Role definitions
  - Team definitions
  - Works across imported files!
- 🎨 **Three Custom Themes** - Choose your favorite:
  - **Koi Dark** - Original Koi theme with custom colors
  - **Koi Dark+** - Based on VS Code's Dark+ with Koi colors
  - **Koi Dark Modern** - Based on VS Code's Dark Modern with Koi colors
- 🔤 **Language Configuration** - Auto-closing brackets, comment toggling, indentation
- 📝 **Playbook Support** - Bright yellow color (`#F7DF1E` - JavaScript yellow) for LLM playbooks - uniform color throughout
- 🎯 **Smart Tokens** - Distinct colors for:
  - Agents, Teams, Skills, Roles
  - Events and handlers
  - LLM configurations
  - Playbooks and affordances (uniform gold color)
  - State declarations

## Installation

### Method 1: From VSIX (Recommended)

1. Package the extension:
   ```bash
   cd vscode-koi-extension
   npm install -g @vscode/vsce
   vsce package
   ```

2. Install in VS Code:
   - Open VS Code / Cursor
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "Install from VSIX"
   - Select the generated `koi-lang-1.0.0.vsix` file

### Method 2: Development Mode

1. Copy the extension folder to your VS Code extensions directory:

   **macOS/Linux:**
   ```bash
   cp -r vscode-koi-extension ~/.vscode/extensions/koi-lang
   ```

   **Windows:**
   ```powershell
   xcopy vscode-koi-extension %USERPROFILE%\.vscode\extensions\koi-lang /E /I
   ```

2. Restart VS Code / Cursor

### Method 3: Symlink (Best for Development)

```bash
# For VS Code
ln -s "$(pwd)/vscode-koi-extension" ~/.vscode/extensions/koi-lang

# For Cursor
ln -s "$(pwd)/vscode-koi-extension" ~/.cursor/extensions/koi-lang
```

## Usage

1. Open any `.koi` file
2. Syntax highlighting activates automatically
3. (Optional) Enable "Koi Dark" theme:
   - `Cmd+K Cmd+T` → Select "Koi Dark"

### Go to Definition

Navigate to symbol definitions with Cmd+Click (Mac) or Ctrl+Click (Windows/Linux):

```koi
import "./skills/math-operations.koi"

Agent MyAgent : Worker {
  uses Skill MathOperations  // Cmd+Click on "MathOperations" → jumps to definition
  uses Team MyTeam           // Cmd+Click on "MyTeam" → jumps to definition

  on process(args: Json) {
    const result = await send peers.event("calculate").role(Calculator).any()({...})
                                                            // Cmd+Click on "Calculator" → jumps to role definition
  }
}
```

**Supported Symbols:**
- `uses Skill <name>` → Jumps to Skill definition
- `uses Team <name>` → Jumps to Team definition
- `Agent <name> : <Role>` → Jumps to Role definition
- `role(<Name>)` in send statements → Jumps to Role definition
- Team member references → Jumps to Agent definition

**Works Across Files:** If a symbol is defined in an imported file, the extension will automatically open that file and jump to the definition!

## Syntax Examples

### Highlighted Elements

```koi
// Comments are highlighted
package "demo.koi"

role Worker { can execute }  // Roles in purple

Agent Greeter : Worker {  // Agents in yellow
  llm default = { provider: "openai" }  // LLM config in green

  on greet(args: Json) {  // Events in orange
    playbook """
    Your playbook here in uniform gold color
    Everything here is the same gold color
    """

    const result = "Hello"  // Variables and strings
    return { message: result }
  }
}

Team MyTeam {  // Teams in yellow
  greeter = Greeter
}

run Greeter.greet({})  // Run statements in green
```

## Color Scheme (Koi Dark Theme)

| Element | Color | Example |
|---------|-------|---------|
| Agents/Teams/Skills | Yellow | `Agent Greeter` |
| Roles | Purple | `role Worker` |
| Events/Playbooks Keywords | Orange | `on greet`, `playbook` |
| Playbook Content | Bright Yellow `#F7DF1E` | `"""text"""` (uniform color) |
| Affordance Content | Bright Yellow `#F7DF1E` | `"""text"""` (uniform color) |
| LLM/Run | Green | `llm default`, `run` |
| Functions | Cyan | `greet()`, `send()` |
| Strings | Light Green | `"hello"` |
| Types | Blue | `Json`, `Int` |
| Keywords | Pink | `if`, `return` |

## Configuration

### Custom File Associations

Add to your VS Code `settings.json`:

```json
{
  "files.associations": {
    "*.koi": "koi"
  }
}
```

### Disable Default Theme

If you prefer your current theme:
- The extension works with any theme
- Just skip enabling "Koi Dark"

## Troubleshooting

### Extension Not Working

1. Verify installation:
   ```bash
   ls -la ~/.vscode/extensions/ | grep koi
   # or for Cursor:
   ls -la ~/.cursor/extensions/ | grep koi
   ```

2. Check VS Code output:
   - `Cmd+Shift+U` → Select "Extensions" from dropdown
   - Look for errors related to "koi-lang"

3. Restart VS Code completely:
   - `Cmd+Q` (Mac) or close all windows
   - Reopen

### Syntax Not Highlighting

1. Check file extension is `.koi`
2. Manually set language:
   - Click language indicator (bottom right)
   - Type "Koi" and select

### Theme Not Available

1. Reinstall extension
2. Reload window: `Cmd+Shift+P` → "Reload Window"

## Contributing

Found an issue or want to improve syntax highlighting?

1. Edit `syntaxes/koi.tmLanguage.json`
2. Reload window to test changes
3. Submit feedback or pull request

## Language Reference

For Koi language documentation:
- [Koi README](../README.md)
- [Quick Start](../QUICKSTART.md)
- [Examples](../examples/)

## License

MIT - Same as Koi language

---

**Koi**: Agent-first language. Calm orchestration. 🌊
