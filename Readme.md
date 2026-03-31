# Breeze Code Ontology Generator

A static analysis tool that parses source code repositories and produces a structured, compressed ontology describing files, functions, classes, imports, and statements. The output powers BreezeAI's semantic search, impact analysis, and functional graph generation.

> **📖 For complete usage guide, see [USAGE.md](./USAGE.md)**

---

## ⚡ Quick Start — Auto Language Detection (Recommended)

The tool automatically detects all languages present in your repository:

```bash
# Analyze a repository (auto-detects all supported languages)
npx github:accionlabs/breezeai-code-ontology-generator repo-to-json-tree \
  --repo ./my-project \
  --out ./output

# With statement capture
npx github:accionlabs/breezeai-code-ontology-generator repo-to-json-tree \
  --repo ./my-project \
  --out ./output \
  --capture-statements
```

**What it does:**
- 🔍 Automatically scans your repository
- 🌐 Detects all supported languages independently
- 📊 Streams all file records into a single `.ndjson.gz` file
- 🏷️ Appends a `projectMetaData` record with repository info and analyzed languages
- 🚀 No need to specify `--language` manually

---

## 💡 Manual Language Mode

You can still target a single language:

```bash
# Analyze only TypeScript files (.ts, .tsx)
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language typescript \
  --repo ./my-project \
  --out ./output \
  --capture-statements

# Analyze only Python files (.py)
npx github:accionlabs/breeze-code-ontology-generator repo-to-json-tree \
  --language python \
  --repo ./my-project \
  --out ./output \
  --capture-statements
```

---

## 🌐 Supported Languages

| Language | `--language` value | File Extensions |
|---|---|---|
| TypeScript / TSX | `typescript` | `.ts`, `.tsx` |
| JavaScript / JSX | `javascript` | `.js`, `.jsx` |
| Python | `python` | `.py` |
| Java | `java` | `.java` |
| C# | `csharp` | `.cs` |
| Go | `golang` | `.go` |
| PHP | `php` | `.php` |
| VB.NET | `vbnet` | `.vb` |
| Vue | `vue` | `.vue` |
| Salesforce Apex | `salesforce` | `.cls`, `.trigger` |
| Config files | `config` | `.json`, `.yml`, `.yaml`, `Dockerfile`, `.env`, `.ini`, `.toml`, `.xml`, `.gradle`, `Makefile`, and more |

> Auto-detect mode processes all languages found in the repository in a single run.

---

## ⚙️ CLI Options

| Option | Description |
|---|---|
| `-r, --repo <path>` | **(required)** Path to the repository to analyze |
| `-o, --out <path>` | **(required)** Output directory for the generated `.ndjson.gz` file |
| `-l, --language <name>` | Language to analyze (see table above). Omit for auto-detect |
| `--capture-statements` | Capture in-body statements: declarations, returns, API calls, DB queries |
| `--capture-source-code` | Include full source code text for each function |
| `--generate-descriptions` | Generate AI descriptions for files, classes, and functions |
| `--add-metadata` | Add metadata using LLM analysis |
| `--provider <name>` | LLM provider: `openai`, `claude`, `gemini`, `bedrock`, `custom` (default: `openai`) |
| `--model <name>` | LLM model name |
| `--api-url <url>` | Custom API endpoint (required for `custom` provider) |
| `--aws-region <region>` | AWS region for Bedrock (default: `us-west-2`) |
| `--aws-access-key <key>` | AWS access key ID for Bedrock |
| `--aws-secret-key <key>` | AWS secret access key for Bedrock |
| `--mode <low\|high>` | Accuracy mode for metadata generation (default: `low`) |
| `--max-concurrent <num>` | Max concurrent LLM API requests |
| `--upload` | Upload the generated file to BreezeAI after processing |
| `--baseurl <url>` | BreezeAI API base URL (required with `--upload`) |
| `--uuid <uuid>` | Project UUID (required with `--upload`) |
| `--user-api-key <key>` | BreezeAI API key for upload authentication |
| `--llmPlatform <name>` | LLM platform: `OPENAI`, `AWSBEDROCK`, `GEMINI` (default: `AWSBEDROCK`) |
| `--verbose` | Show detailed processing information |

---

## 🧩 How It Works

1. **Code Parsing** — Each file is parsed using [tree-sitter](https://tree-sitter.github.io/) grammars for accurate AST-based analysis.
2. **Extraction** — Functions, classes, imports, and (optionally) in-body statements are extracted per file.
3. **Output** — Results are streamed as a gzipped NDJSON file (`.ndjson.gz`) — one JSON object per file, with a project metadata record appended at the end.

### Output Structure

```
<output-dir>/
└── <repo-name>-project-analysis.ndjson.gz   ← one JSON object per line, gzipped
```

**Per-file record:**
```json
{
  "path": "src/services/user-service.ts",
  "type": "code",
  "language": "typescript",
  "loc": 120,
  "importFiles": ["src/lib/api-client.ts"],
  "externalImports": ["react", "axios"],
  "functions": [ ... ],
  "classes": [ ... ],
  "statements": [ ... ]
}
```

**Function record:**
```json
{
  "name": "getUser",
  "type": "arrow_function",
  "kind": "function",
  "visibility": "public",
  "params": [{ "name": "id", "type": "string" }],
  "returnType": "Promise<User>",
  "startLine": 10,
  "endLine": 25,
  "calls": ["apiFetch", "getAuthHeaders"],
  "statements": [ ... ]
}
```

**Project metadata record (last line):**
```json
{
  "__type": "projectMetaData",
  "repositoryName": "my-project",
  "analyzedLanguages": ["typescript", "python"],
  "totalFiles": 376,
  "totalFunctions": 1582,
  "totalClasses": 428,
  "totalLinesOfCode": 98838,
  "generatedAt": "2025-01-12T10:30:00.000Z",
  "toolVersion": "1.0.0"
}
```

---

## 📋 Statements Captured (`--capture-statements`)

When `--capture-statements` is enabled, each function and class body is analyzed for the following statement types.

### 🔤 Variable & Type Declarations

Captured from the direct body of functions and classes.

| Statement Type | Description | Languages |
|---|---|---|
| `lexical_declaration` | `const` / `let` declarations | TypeScript, JavaScript, Java, C#, Go, PHP, Salesforce, Vue |
| `variable_declaration` | `var` declarations | TypeScript, JavaScript, Java, C#, Go, PHP, Salesforce, Vue |
| `public_field_definition` | Class field / property definitions | TypeScript, JavaScript, Java, C#, Go, PHP, Salesforce, Vue |
| `enum_declaration` | Enum type declarations | TypeScript, Java, C#, PHP, Salesforce |
| `type_alias_declaration` | TypeScript `type Foo = ...` aliases | TypeScript only |
| `decorator` | Class/method decorators (`@Injectable`, etc.) | TypeScript only |
| `dim_statement` | VB.NET `Dim` variable declarations | VB.NET only |
| `const_declaration` | VB.NET `Const` declarations | VB.NET only |
| `field_declaration` | Go struct fields / VB.NET field declarations | Go, VB.NET |
| `attribute_block` | VB.NET attribute blocks | VB.NET only |

### ↩️ Return Statements

| Statement Type | Description |
|---|---|
| `return_statement` | Return statements, including those inside nested `if`/`else`, loops, and `try`/`catch` blocks |

---

### 🌐 API Call Statements (`api_call`)

Detected by traversing the full function body for HTTP client calls.

**Supported in:** TypeScript, JavaScript (Node.js), Vue

```json
{
  "type": "api_call",
  "method": "POST",
  "endpoint": "{param}/projects/{param}",
  "text": "apiFetch(url, { method: \"POST\", body: JSON.stringify(body), ... })",
  "startLine": 23,
  "endLine": 30
}
```

| Field | Description | Example |
|---|---|---|
| `method` | HTTP verb | `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `endpoint` | URL or URL template (dynamic segments → `{param}`) | `{param}/users/{param}` |
| `text` | Raw call source (up to 500 chars) | `apiFetch(url, { method: "PUT", ... })` |
| `startLine` / `endLine` | Line range in the source file | `23` / `30` |

**HTTP method resolution order:**
1. Options object `method` field — `apiFetch(url, { method: "POST" })` → `POST`
2. Client method name — `axios.delete(url)` → `DELETE`
3. Default `GET` for bare `fetch`-style calls with no explicit method

**Endpoint resolution:**
- String literal: `fetch('/api/users')` → `/api/users`
- Template string: `` fetch(`/api/users/${id}`) `` → `/api/users/{param}`
- Variable reference: `const url = \`...\`; apiFetch(url, ...)` → resolved from the variable declaration in the same function scope

**Detected HTTP clients:**

| Type | Examples |
|---|---|
| Bare functions | `fetch`, `apiFetch`, `authFetch`, `$fetch`, `useFetch`, `customFetch` |
| Axios | `axios.get()`, `axios.post()`, `axios.put()`, `axios.delete()` |
| Angular HttpClient | `this.http.get()`, `this.$http.post()`, `this.httpClient.request()` |
| Generic clients | `api.get()`, `apiClient.post()`, `httpService.put()`, `restClient.delete()` |
| Other libraries | `got`, `superagent`, `ky`, `ofetch` |
| Python | `requests.get()`, `httpx.post()`, `session.put()` |
| Java/Spring | `restTemplate.getForObject()`, `webClient.post()` |
| C#/.NET | `HttpClient.GetAsync()`, `_httpClient.PostAsync()` |
| PHP | `Http::get()`, `Guzzle::post()`, `$client->put()` |

---

### 🗄️ Database Query Statements (`query_statement`)

Detected by traversing the full function body for DB client calls or raw query strings.

**Supported in:** All languages

```json
{
  "type": "query_statement",
  "db": "sequelize",
  "text": "User.findAll({ where: { id } })",
  "startLine": 45,
  "endLine": 47
}
```

| Field | Description | Example |
|---|---|---|
| `db` | Database / ORM identified | `prisma`, `mongodb`, `redis`, `sequelize` |
| `text` | Raw call expression or query string (up to 500 chars) | `User.findAll({ where: { active: true } })` |
| `startLine` / `endLine` | Line range in the source file | `45` / `47` |

**Detected databases and ORMs:**

| Database / ORM | Detection Method | Key Methods / Patterns |
|---|---|---|
| **SQL (raw)** | String patterns | `SELECT`, `INSERT INTO`, `UPDATE ... SET`, `DELETE FROM`, `CREATE TABLE` |
| **Sequelize** | Method names | `findAll`, `findOne`, `findByPk`, `findOrCreate`, `upsert`, `bulkCreate`, `destroy` |
| **Prisma** | Method names | `findMany`, `findFirst`, `findUnique`, `create`, `update`, `delete`, `upsert` |
| **TypeORM** | Method names | `createQueryBuilder`, `getRepository`, `save`, `findOneBy` |
| **MongoDB** | Method names | `insertOne`, `updateOne`, `deleteOne`, `aggregate`, `findOneAndUpdate`, `bulkWrite` |
| **Neo4j** | Method names | `readTransaction`, `writeTransaction`, `executeRead`, `executeWrite`, `run` |
| **Redis** | Method names | `get`, `set`, `hget`, `hset`, `lpush`, `rpush`, `sadd`, `zadd`, `mset`, `mget` |
| **DynamoDB** | Method names | `getItem`, `putItem`, `deleteItem`, `batchGetItem`, `transactWriteItems`, `scan`, `query` |
| **Firebase** | Method names | `getDocs`, `getDoc`, `setDoc`, `addDoc`, `updateDoc`, `deleteDoc`, `onSnapshot` |
| **Elasticsearch** | Method names | `search`, `index`, `bulk`, `msearch` |
| **CouchDB** | Method names | `allDocs`, `bulkDocs`, `createIndex`, `find` |
| **Entity Framework** | Method names | `ToListAsync`, `SaveChangesAsync`, `FromSqlRaw`, `ExecuteSqlRaw`, `Include`, `AddAsync` |
| **Django ORM** | Method names | `filter`, `exclude`, `select_related`, `prefetch_related`, `get_or_create`, `bulk_update` |
| **SQLAlchemy** | Method names | `query`, `add`, `add_all`, `execute` |
| **Hibernate** | Method names | `findById`, `findAll`, `save`, `delete` |
| **GraphQL** | String patterns | `query { }`, `mutation { }`, `subscription { }` |
| **Cypher (Neo4j)** | String patterns | `MATCH`, `CREATE`, `MERGE`, `DETACH DELETE`, `LOAD CSV` |
| **MongoDB DSL** | String patterns | `$match`, `$group`, `$lookup`, `$unwind`, `$project` |
| **Elasticsearch DSL** | String patterns | `bool`, `must`, `should`, `match`, `term`, `range` |
| **Salesforce SOQL** | AST node type | Inline `soql_expression` nodes (Salesforce only) |
| **Salesforce SOSL** | AST node type | Inline `sosl_expression` nodes (Salesforce only) |

---

## 🚫 Ignore Patterns

Files and directories are excluded from analysis via `.repoignore` files (same syntax as `.gitignore`):

- **Built-in defaults** — `node_modules/`, `dist/`, `build/`, `.git/`, `*.min.js`, lock files, etc.
- **Language defaults** — e.g. `.next/`, `.nuxt/` for TypeScript/JavaScript
- **Repo-level overrides** — place a `.repoignore` file at the root of the target repository to add project-specific exclusions

---

## 🛠️ Other Commands

### Upload documents

```bash
node cli.js upload-docs \
  --path <docs-dir> \
  --baseurl <api-url> \
  --uuid <project-uuid> \
  --user-api-key <key>
```

### Start HTTP server

```bash
node cli.js serve --port 3000
```

---

## ⚙️ Prerequisites

- **Node.js v20+**
- `npm install` to install tree-sitter grammars and other dependencies
