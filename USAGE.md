# Breeze Code Ontology Generator - Usage Guide

## Prerequisites

Before using this tool, ensure you have the following installed:

### Required
- **Node.js**: Version 20 or above
  - Check your Node.js version: `node --version`
  - Download from: https://nodejs.org/

### Optional (for AI features)
- **API Key** for one of the supported LLM providers:
  - OpenAI (recommended)
  - Anthropic Claude
  - Google Gemini
  - Custom/Private LLM endpoint

---

## Quick Start

### ⚡ Auto Language Detection Mode (Recommended)

**NEW**: The easiest way to analyze your codebase - automatically detects all languages!

Simply omit the `--language` flag to enable auto-detection mode.

```bash
# Basic usage - auto-detects all languages in your repo
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --repo ./path/to/your/repo \
  --out ./output

# With AI-generated descriptions
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --repo ./path/to/your/repo \
  --out ./output \
  --generate-descriptions \
  --api-key sk-your-openai-key

# With descriptions and metadata
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --repo ./path/to/your/repo \
  --out ./output \
  --generate-descriptions \
  --add-metadata \
  --provider openai \
  --api-key sk-your-api-key
```

**What this does:**
- 🔍 Scans your repository for supported file types
- 🌐 Automatically detects: JavaScript, TypeScript, Python, and Java
- 📊 Processes each detected language separately
- 🔄 **Merges all outputs into a single `project-analysis.json` file**
- 🏷️ Adds `projectMetaData` with repository information
- 🚀 No need to run the tool multiple times or specify languages manually

**Supported Languages & File Extensions:**
- **TypeScript**: `.ts`, `.tsx` files only
- **JavaScript**: `.js`, `.jsx` files only
- **Python**: `.py` files
- **Java**: `.java` files

**Note:** Each language is detected and processed independently. If your repository has both TypeScript and JavaScript files, both languages will be detected and included in the merged output.

**Output Structure:**

The auto-detection mode generates a **single merged JSON file** at `./output/project-analysis.json`:

```json
{
  "projectMetaData": {
    "repositoryPath": "/absolute/path/to/repo",
    "repositoryName": "my-project",
    "analyzedLanguages": ["typescript", "python", "java"],
    "totalFiles": 247,
    "generatedAt": "2025-01-12T10:30:00.000Z",
    "toolVersion": "1.0.0"
  },
  "files": [
    {
      "filePath": "src/api/users.ts",
      "language": "typescript",
      "classes": [...],
      "functions": [...],
      "imports": [...]
    },
    {
      "filePath": "scripts/deploy.py",
      "language": "python",
      "classes": [...],
      "functions": [...],
      "imports": [...]
    },
    {
      "filePath": "core/Main.java",
      "language": "java",
      "classes": [...],
      "functions": [...],
      "imports": [...]
    }
  ]
}
```

**Available Options:**
```bash
--repo, -r <path>           Path to repository (required)
--out, -o <path>            Output directory (required)
--generate-descriptions     Generate AI descriptions
--add-metadata             Add metadata using LLM
--provider <name>          LLM provider (openai, claude, gemini, custom)
--api-key <key>            API key for LLM
--model <name>             Model name (optional)
--api-url <url>            Custom API URL
--mode <low|high>          Accuracy mode for metadata
--max-concurrent <num>     Max concurrent API requests
--verbose                  Show detailed processing info
```

---

### Step 1: Generate JSON Tree (Manual Language Selection)

If you want to analyze a specific language only, use the manual mode.

This step analyzes your codebase and generates a JSON file containing the structure of your code (files, classes, functions, imports, etc.).

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ./path/to/your/repo \
  --out ./output
```

**What this does:**
- Scans your repository at `./path/to/your/repo`
- Identifies all files of the specified language
- Extracts code structure (classes, functions, imports)
- Saves the results to `./output/<language>-imports.json`

**Supported Languages:**
- `javascript` - Parses `.js` and `.jsx` files only
- `typescript` - Parses `.ts`, `.tsx`, `.js`, and `.jsx` files (includes JavaScript!)
- `python` - Parses `.py` files
- `java` - Parses `.java` files

> **💡 Tip:** Use `--language typescript` for projects that contain both TypeScript and JavaScript files. The TypeScript parser will automatically handle both file types.

**Example Output:**
```
./output/javascript-imports.json
or
./output/typescript-imports.json (includes both TS and JS files)
```

---

### Step 2: Add AI-Generated Descriptions (Optional)

This step uses an LLM to generate human-readable descriptions for files, classes, and functions.

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ./path/to/your/repo \
  --out ./output \
  --generate-descriptions \
  --provider openai \
  --api-key sk-your-api-key
```

**What this does:**
- Performs Step 1 (generates JSON tree)
- Reads each file's source code
- Sends code to the LLM for analysis
- Adds `description` fields to files, classes, and functions
- Updates the JSON file in-place

**Available Providers:**
- `openai` (default model: gpt-4o-mini)
- `claude` (default model: claude-3-5-sonnet-20241022)
- `gemini` (default model: gemini-2.5-flash)
- `custom` (requires `--api-url`)

**Additional Options:**
- `--model <name>`: Specify a different model
- `--max-concurrent <num>`: Max concurrent API requests (default: 5)
- `--max-file-size <kb>`: Skip files larger than this (default: 500KB)

---

### Step 3: Add Metadata (Optional)

This step uses LLM analysis to categorize and add metadata about architectural roles (Service, Controller, Repository, etc.).

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ./path/to/your/repo \
  --out ./output \
  --add-metadata \
  --provider openai \
  --api-key sk-your-api-key
```

**What this does:**
- Performs Step 1 (generates JSON tree)
- Analyzes each file/class/function for architectural patterns
- Adds `roles` and `metadata` fields with structured information
- Updates the JSON file in-place

**Metadata Categories:**
- **Backend**: Service, Controller, Repository, DTO, Entity, API
- **Frontend**: Component, Page, Hook, Store, EventEmitter
- **Cross-cutting**: Utility, Constants, Types, Error, Test

**Additional Options:**
- `--mode <low|high>`:
  - `low`: Analyze JSON structure only (faster, cheaper)
  - `high`: Include source code in analysis (more accurate)
- `--node-types <types>`: Comma-separated list: `file,class,function` (default: all)
- `--max-concurrent <num>`: Max concurrent requests (default: 3)

---

## Complete Workflow (All Steps Combined)

Run all steps in a single command:

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ./my-app \
  --out ./output \
  --generate-descriptions \
  --add-metadata \
  --provider openai \
  --api-key sk-your-api-key \
  --mode high
```

**Execution Flow:**
1. Generate JSON tree structure
2. Add AI descriptions for all code elements
3. Add architectural metadata
4. Save final enhanced JSON file

---

## Examples

### Example 1: TypeScript Project with JavaScript Files

TypeScript projects often contain both `.ts` and `.js` files. Use `--language typescript` to parse both:

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language typescript \
  --repo ../my-ts-project \
  --out ./analysis
```

**Output:** `./analysis/typescript-imports.json` (contains both TypeScript and JavaScript files)

---

### Example 2: Analyze a Pure JavaScript Project

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ../my-node-app \
  --out ./analysis
```

**Output:** `./analysis/javascript-imports.json`

---

### Example 3: Python Project with Descriptions (OpenAI)

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language python \
  --repo ../my-python-app \
  --out ./analysis \
  --generate-descriptions \
  --provider openai \
  --api-key sk-proj-xxxxx \
  --model gpt-4o-mini
```

**Output:** `./analysis/python-imports.json` (with descriptions)

---

### Example 4: TypeScript Project with Full Analysis (Claude)

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language typescript \
  --repo ../my-ts-app \
  --out ./analysis \
  --generate-descriptions \
  --add-metadata \
  --provider claude \
  --api-key sk-ant-xxxxx \
  --model claude-3-5-sonnet-20241022 \
  --mode high
```

**Output:** `./analysis/typescript-imports.json` (with descriptions + metadata)

---

### Example 5: Using Custom/Local LLM

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ../my-app \
  --out ./analysis \
  --generate-descriptions \
  --provider custom \
  --api-key dummy \
  --api-url http://localhost:11434/v1/chat/completions \
  --model llama3.2
```

---

### Example 6: Using Gemini

```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language java \
  --repo ../my-java-app \
  --out ./analysis \
  --generate-descriptions \
  --add-metadata \
  --provider gemini \
  --api-key your-gemini-api-key \
  --model gemini-2.5-flash
```

---

## Command Reference

### Main Command: `repo-to-json-tree`

```
repo-to-json-tree --language <lang> --repo <path> --out <path> [options]
```

**Required Arguments:**
| Argument | Alias | Description |
|----------|-------|-------------|
| `--language <lang>` | `-l` | Programming language (javascript, typescript, python, perl, java) |
| `--repo <path>` | `-r` | Path to repository to analyze |
| `--out <path>` | `-o` | Output directory for JSON files |

**Optional Arguments:**
| Argument | Description | Default |
|----------|-------------|---------|
| `--generate-descriptions` | Enable AI description generation | false |
| `--add-metadata` | Enable AI metadata analysis | false |
| `--provider <name>` | LLM provider (openai, claude, gemini, custom) | openai |
| `--api-key <key>` | API key for LLM provider | (required if using AI features) |
| `--model <name>` | Specific model to use | Provider default |
| `--api-url <url>` | Custom API endpoint URL | (required for custom provider) |
| `--mode <low\|high>` | Metadata accuracy mode | low |
| `--max-concurrent <num>` | Max concurrent API requests | 5 (descriptions), 3 (metadata) |

---

## Troubleshooting

### Issue: "Node.js version too old"
**Solution:** Upgrade to Node.js 18 or above
```bash
node --version  # Check current version
# Visit https://nodejs.org/ to download latest version
```

### Issue: "Could not determine executable to run"
**Solution:** Make sure you're using the exact command format:
```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree [args]
```
Note the space between the package name and `repo-to-json-tree`.

### Issue: "API key required"
**Solution:** Add `--api-key` flag when using `--generate-descriptions` or `--add-metadata`
```bash
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ./my-app \
  --out ./output \
  --generate-descriptions \
  --provider openai \
  --api-key sk-your-key-here
```

### Issue: Rate limiting or timeout errors
**Solution:** Reduce concurrent requests:
```bash
--max-concurrent 2
```

### Issue: Large files causing errors
**Solution:** Reduce max file size for descriptions:
```bash
--max-file-size 200
```

---

## Tips and Best Practices

1. **Start Simple**: Begin with just the JSON tree generation, then add AI features incrementally
2. **Cost Management**: Use `gpt-4o-mini` or `gemini-2.5-flash` for cost-effective analysis
3. **Accuracy vs Cost**: Use `--mode low` for faster/cheaper metadata, `--mode high` for better accuracy
4. **Incremental Processing**: Scripts save progress incrementally, so you can safely interrupt and resume
5. **Large Codebases**: Start with `--max-file-size 100` to skip large files

---

## Output Format

The generated JSON file contains an array of file objects:

```json
[
  {
    "path": "src/services/UserService.js",
    "description": "Service for managing user operations including CRUD and authentication",
    "roles": ["Service", "API"],
    "metadata": {
      "Service": {
        "domain": "users",
        "responsibility": "user management",
        "stateless": true
      }
    },
    "classes": [
      {
        "name": "UserService",
        "description": "Handles user-related business logic",
        "startLine": 5,
        "endLine": 50
      }
    ],
    "functions": [
      {
        "name": "createUser",
        "description": "Creates a new user account with validation",
        "startLine": 10,
        "endLine": 20
      }
    ],
    "imports": [
      {
        "source": "./UserRepository",
        "specifiers": ["UserRepository"]
      }
    ]
  }
]
```

