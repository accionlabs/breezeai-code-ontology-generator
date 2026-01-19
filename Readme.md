# Breeze Code Ontology Generator

> **📖 For complete usage guide, see [USAGE.md](./USAGE.md)**

## ⚡ Quick Start - Auto Language Detection (Recommended)

**NEW**: The tool now automatically detects all languages in your repository!

```bash
# Analyze a multi-language repository (auto-detects JavaScript, TypeScript, Python, Java)
# Simply omit the --language flag to enable auto-detection
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --repo ./my-project \
  --out ./output

# With AI descriptions
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --repo ./my-project \
  --out ./output \
  --generate-descriptions \
  --api-key sk-your-api-key
```

**What it does:**
- 🔍 Automatically scans your repository
- 🌐 Detects all supported languages independently (JavaScript, TypeScript, Python, Java)
- 📊 Merges all outputs into a single `project-analysis.json` file
- 🏷️ Adds `projectMetaData` with repository info and analyzed languages
- 🚀 No need to specify `--language` manually
- ⚡ Each language is detected and processed independently (TypeScript = `.ts/.tsx`, JavaScript = `.js/.jsx`)

**Output Structure:**
```json
{
  "projectMetaData": {
    "repositoryPath": "/path/to/repo",
    "repositoryName": "my-project",
    "analyzedLanguages": ["typescript", "python"],
    "totalFiles": 150,
    "generatedAt": "2025-01-12T10:30:00.000Z",
    "toolVersion": "1.0.0"
  },
  "files": [
    // All analyzed files from all languages
  ]
}
```

---

## 💡 Manual Language Mode

You can still specify a single language to analyze:

```bash
# Analyze only TypeScript files (.ts, .tsx)
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language typescript \
  --repo ./my-project \
  --out ./output

# Analyze only JavaScript files (.js, .jsx)
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language javascript \
  --repo ./my-project \
  --out ./output
```

**Note:** In manual mode, the TypeScript parser will still process any `.js` files it encounters through imports, but the initial detection only looks for `.ts/.tsx` files.

---

## 🧩 Overview

The tool operates in **three stages**:

1. **Code Parsing & JSON Generation**
   Parses a Perl repository and outputs:
   - A **package-to-path mapper JSON** — maps each Perl package to its corresponding file path.
   - A **file dependency tree JSON** — captures which files import or depend on others.

2. **AI-Powered File Descriptions** (Optional)
   Generates natural language descriptions for each file using various LLM providers:
   - Supports OpenAI, Claude (Anthropic), Google Gemini, and custom/private LLMs
   - Adds descriptions to the dependency tree JSON

3. **Import JSON Using Breeze Code Ontology UI**
  1. Create an Ontology
   In the UI:Code Ontology → Create new Ontology
   Provide:
    Ontology Name
    Programming Language
    Optional metadata
    This ontology will hold one or more repositories.

  2. generate description (Optional)
  This step will generate natural-language descriptions for your codebase using OpenAI.
  The CLI will print a command that you can run locally to generate the description JSON file.

  3. Upload Generated JSON File
    Open the ontology and click: Upload JSON File
    Select your:file-dependency-tree.json

    Breeze will:
        Parse the JSON
        Create Neo4j nodes & relationships
        Attach data under the ontology ID
        Handle multiple repositories
        Automatically manage indexing & constraints

    Explore the Graph
      Once imported, the UI enables:
        Interactive graph visualization
        Dependency traversal
        Cluster/community analysis
        Metrics & insights
        Filtering by repo, file, module, dependencies

---

## ⚙️ Prerequisites

- **Node.js v20+**
- **Neo4j Database** (local or remote)
- A `config.json` file containing Neo4j credentials
- Basic understanding of Perl package structure (`.pl` and `.pm` files)

---

## 🗂️ Repository Structure

```
.
├── config.js                         # Contains Neo4j connection details
├── file-tree-mapper.js               # Script to analyze Perl repo and create JSONs
├── generate-file-descriptions.js     # Script to add AI-generated descriptions
├── tree-to-graph.js                  # Script to migrate dependency JSON into Neo4j
├── package-lock.json
├── README.md
└── output/
    ├── package-path-mapper.json
    ├── file-dependency-tree.json
    └── file-dependency-tree-with-descriptions.json
```

---

## ⚙️ Configuration Setup

Before running the scripts, configure your Neo4j connection details in `config.js`:

```json
{ 
    "dbConfig": {
        "dbUrl": "neo4j://localhost:7687",
        "username": "neo4j",
        "password": "12345678",
        "dbName": "codeviz"
    }


}
```

This file will be automatically read by `tree-to-graph.js` for database connection.

---

## 🚀 Usage

### Step 1: Generate the File Tree and Mapper JSONs

Run the following command to analyze your Perl repository:

```bash
node file-tree-mapper.js <path-to-perl-repo> <output-mapper-json-filename> <output-file-tree-json>
```

**Example:**
```bash
node file-tree-mapper.js ./perl-app ./output/package-path-mapper.json ./output/file-dependency-tree.json
```

This will:
- Recursively scan the Perl repository.
- Identify `.pl` and `.pm` files.
- Parse `package`, `use`, and `require` statements.
- Generate:
  - `package-path-mapper.json` — maps package names to file paths.
  - `file-dependency-tree.json` — shows which files depend on which.

---

### Step 2 (Optional): Generate AI Descriptions for Files

You can enrich your file tree with AI-generated descriptions using various LLM providers. The script scans the repository directly and updates the JSON file in-place:

#### Using OpenAI (GPT-4, GPT-3.5, etc.)

```bash
node generate-file-descriptions.js <repo-path> <tree-json-file> \
  --provider openai \
  --api-key sk-your-openai-key \
  --model gpt-4o-mini
```

#### Using Claude (Anthropic)

```bash
node generate-file-descriptions.js <repo-path> <tree-json-file> \
  --provider claude \
  --api-key sk-ant-your-claude-key \
  --model claude-3-5-sonnet-20241022
```

#### Using Google Gemini

```bash
node generate-file-descriptions.js <repo-path> <tree-json-file> \
  --provider gemini \
  --api-key your-gemini-key \
  --model gemini-2.5-flash
```

#### Using Custom/Private LLM

```bash
node generate-file-descriptions.js <repo-path> <tree-json-file> \
  --provider custom \
  --api-key your-api-key \
  --api-url http://localhost:8080/v1/chat/completions \
  --model llama3.2
```

**Example:**
```bash
node generate-file-descriptions.js ./perl-app ./output/file-dependency-tree.json \
  --provider openai \
  --api-key sk-xxx \
  --model gpt-4o-mini
```

**Available Options:**
- `--provider`: LLM provider (openai, claude, gemini, custom)
- `--api-key`: Your API key
- `--model`: Model name (defaults: gpt-4o-mini, claude-3-5-sonnet-20241022, gemini-2.5-flash)
- `--api-url`: Custom API endpoint (required for custom provider)
- `--max-concurrent`: Maximum concurrent API requests (default: 5)
- `--max-file-size`: Maximum file size in KB to process (default: 500)

This will:
- Scan the repository for Perl files (.pl and .pm)
- Load existing JSON file (if it exists) to preserve metadata
- Generate concise descriptions using the specified LLM
- Add a `description` field to each file entry
- Update the JSON file in-place (saves progress after each batch)
- Skip files that already have descriptions

---

### Step 3: Migrate the Dependency Tree to Neo4j

Once the JSON is generated, run the graph migration command:

```bash
node tree-to-graph.js <path-to-file-dependency-tree-json>
```

**Example:**
```bash
node tree-to-graph.js ./output/file-dependency-tree.json
```

This script will:
- Read Neo4j credentials from `config/config.json`.
- Connect to your Neo4j database.
- Create `File` nodes and `IMPORTS` relationships.
- Populate the graph for exploration.

---

## 🧠 Example Neo4j Queries

View all file relationships:

```cypher
MATCH (f:File)-[:IMPORTS]->(d:File)
RETURN f, d
```

List files that are not imported by any other file:

```cypher
MATCH (f:File)
WHERE NOT ()-[:IMPORTS]->(f)
RETURN f
```

---

## 🧱 Data Model

**Node Labels:**
- `File` — represents a `.pl` or `.pm` file.

**Relationships:**
- `[:IMPORTS]` — indicates one file depends on another.

---

## ⚠️ Notes

- Ensure the Neo4j database is running before executing the migration script.
- Update credentials in `config/config.json` instead of editing scripts.
- The parser assumes standard Perl module naming conventions (`Package::SubPackage → Package/SubPackage.pm`).


## Generating local connected grraphs community

Run these queries in neo4jDB

// Drop any existing graph with the same name to avoid conflict
CALL gds.graph.drop('importsGraph', false) YIELD graphName;

// Create a new graph projection
CALL gds.graph.project(
  'importsGraph',
  'File',                   // node label
  {
    IMPORTS: {
      type: 'IMPORTS',
      orientation: 'UNDIRECTED' // Louvain works best on undirected graphs
    }
  }
);

CALL gds.louvain.write('importsGraph', {
  writeProperty: 'communityId'
})
YIELD communityCount, modularity, modularities;

