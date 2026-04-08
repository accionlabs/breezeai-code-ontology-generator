# Breeze Code Ontology Generator

A static analysis tool that parses source code repositories and produces a structured, compressed ontology describing files, functions, classes, imports, and statements. The output powers BreezeAI's semantic search, impact analysis, and functional graph generation.

> **📖 For complete usage guide, see [USAGE.md](./USAGE.md)**

---

## ⚙️ Prerequisites

- **Node.js v22+**
- Run `npm install` after cloning — a postinstall script rebuilds native tree-sitter grammars

---

## ⚡ Quick Start — Auto Language Detection (Recommended)

The tool automatically detects all languages present in your repository:

```bash
# Analyze a repository (auto-detects all supported languages)
npx github:accionlabs/breezeai-code-ontology-generator repo-to-json-tree \
  --repo ./my-project \
  --out ./output

# With statement capture (API calls, DB queries, declarations)
npx github:accionlabs/breezeai-code-ontology-generator repo-to-json-tree \
  --repo ./my-project \
  --out ./output \
  --capture-statements
```

**What it does:**
- 🔍 Automatically scans and detects all supported languages independently
- 📊 Streams all file records into a single `<repo-name>-project-analysis.ndjson.gz`
- 🏷️ Appends a `projectMetaData` record with repository info, language stats, and config summary
- 🚀 No need to specify `--language` manually

---

## 💡 Manual Language Mode

Target a single language explicitly:

```bash
# Analyze only TypeScript files (.ts, .tsx) — also processes .js/.jsx via TypeScript parser
npx github:accionlabs/breezeai-code-ontology-generator repo-to-json-tree \
  --language typescript \
  --repo ./my-project \
  --out ./output \
  --capture-statements

# Analyze only Python files
npx github:accionlabs/breezeai-code-ontology-generator repo-to-json-tree \
  --language python \
  --repo ./my-project \
  --out ./output \
  --capture-statements
```

> **Note:** In manual mode the output file is named `<language>-imports.ndjson.gz`. In auto-detect mode it is `<repo-name>-project-analysis.ndjson.gz`.

---

## 🌐 Supported Languages

| Language | `--language` value | File Extensions |
|---|---|---|
| TypeScript / TSX | `typescript` | `.ts`, `.tsx` (+ `.js`, `.jsx`) |
| JavaScript / JSX | `javascript` | `.js`, `.jsx` |
| Python | `python` | `.py` |
| Java | `java` | `.java` |
| C# | `csharp` | `.cs` |
| Go | `golang` | `.go` |
| PHP | `php` | `.php` |
| VB.NET | `vbnet` | `.vb` |
| Vue | `vue` | `.vue` |
| Salesforce Apex | `salesforce` | `.cls`, `.trigger` |
| Perl | `perl` | `.pl`, `.pm` |
| Config files | `config` | `.json`, `.yml`, `.yaml`, `Dockerfile`, `.env`, `.ini`, `.toml`, `.xml`, `.gradle`, `Makefile`, and more |

> **TypeScript note:** When `--language typescript` is used, the TypeScript parser also processes any `.js` and `.jsx` files it encounters through imports.

---

## ⚙️ CLI Options

### Core options

| Option | Description |
|---|---|
| `-r, --repo <path>` | **(required)** Path to the repository to analyze |
| `-o, --out <path>` | **(required)** Output directory for the generated `.ndjson.gz` file |
| `-l, --language <name>` | Language to analyze (see table above). Omit for auto-detect |
| `--capture-statements` | Capture in-body statements: declarations, returns, API calls, DB queries |
| `--capture-source-code` | Include source code text for each function (truncated to 200 lines / 10,000 chars) |
| `--verbose` | Show detailed processing information |

### AI description & metadata options

These only take effect when `--generate-descriptions` or `--add-metadata` is passed.

| Option | Description |
|---|---|
| `--generate-descriptions` | Generate AI descriptions for files, classes, and functions (resume-safe) |
| `--add-metadata` | Add role/metadata tags using LLM analysis (resume-safe, saves every 10 files) |
| `--provider <name>` | LLM provider: `openai`, `claude`, `gemini`, `bedrock`, `custom` (default: `openai`) |
| `--model <name>` | LLM model name (defaults: `gpt-4o-mini` / `claude-3-5-sonnet-20241022` / `gemini-2.5-flash`) |
| `--api-url <url>` | Custom API endpoint (required for `custom` provider) |
| `--mode <low\|high>` | Accuracy mode — only used with `--add-metadata` (default: `low`) |
| `--max-concurrent <num>` | Max concurrent LLM API requests — used with `--generate-descriptions` and `--add-metadata` |
| `--max-file-size <kb>` | Max file size to process for descriptions (default: 500 KB) |
| `--node-types <types>` | Comma-separated node types for metadata: `file`, `class`, `function` |

When `--provider bedrock` is specified, the following AWS credentials are also required:

| Option | Description |
|---|---|
| `--aws-region <region>` | AWS region (default: `us-west-2`) |
| `--aws-access-key <key>` | AWS access key ID |
| `--aws-secret-key <key>` | AWS secret access key |

### Upload options

| Option | Description |
|---|---|
| `--upload` | Upload the generated `.ndjson.gz` to BreezeAI after processing |
| `--baseurl <url>` | BreezeAI API base URL (required with `--upload`) |
| `--uuid <uuid>` | Project UUID (required with `--upload`) |
| `--user-api-key <key>` | BreezeAI API key for upload authentication |
| `--llmPlatform <name>` | LLM platform: `OPENAI`, `AWSBEDROCK`, `GEMINI` (default: `AWSBEDROCK`) |

---

## 🧩 How It Works

1. **Code Parsing** — Each file is parsed using [tree-sitter](https://tree-sitter.github.io/) grammars for accurate AST-based analysis.
2. **Extraction** — Functions, classes, imports, and (optionally) in-body statements are extracted per file.
3. **Streaming Output** — Results are streamed to a gzipped NDJSON file as they are produced — the full dataset is never held in memory. A `projectMetaData` record is appended last.

### Output structure

```
<output-dir>/
└── <repo-name>-project-analysis.ndjson.gz    ← auto-detect mode
└── <language>-imports.ndjson.gz              ← manual language mode
```

### Per-file record

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

- **`importFiles`** — local files resolved to repo-relative paths
- **`externalImports`** — npm packages / external module names
- **`statements`** — top-level module/file-scope declarations (when `--capture-statements` is enabled)

### Function record

```json
{
  "name": "getUser",
  "type": "arrow_function",
  "kind": "function",
  "visibility": "public",
  "params": [{ "name": "id", "type": "string" }],
  "returnType": "Promise<User>",
  "generics": "<T>",
  "startLine": 10,
  "endLine": 25,
  "calls": [{ "name": "apiFetch", "path": "src/lib/api-client.ts" }],
  "statements": [ ... ]
}
```

- **`type`** — AST node type: `arrow_function`, `function_declaration`, `method_definition`, `function_signature`, etc.
- **`kind`** — `function`, `instance`, or `static`
- **`generics`** — TypeScript only (e.g., `<T extends BaseEntity>`)
- **`receiver`** — Go only (receiver type name for methods)
- Functions with no resolvable name (anonymous, unassigned) are excluded from output

### Class record

```json
{
  "name": "UserService",
  "type": "class",
  "visibility": "public",
  "isAbstract": false,
  "generics": "<T extends BaseEntity>",
  "extends": "BaseService",
  "implements": ["IUserService", "IDisposable"],
  "constructorParams": ["userRepo", "emailService"],
  "methods": ["createUser", "deleteUser", "findById"],
  "statements": [ ... ],
  "startLine": 10,
  "endLine": 80
}
```

- Go uses `type: "struct"` or `type: "interface"` (no `extends`, `implements`, or `isAbstract`)
- Go struct fields are listed in `constructorParams`
- TypeScript also extracts `interface_declaration` as `type: "interface"`

### Project metadata record (last line)

```json
{
  "__type": "projectMetaData",
  "repositoryPath": "/absolute/path/to/repo",
  "repositoryName": "my-project",
  "analyzedLanguages": ["typescript", "python"],
  "totalFiles": 376,
  "totalFunctions": 1582,
  "totalClasses": 428,
  "totalLinesOfCode": 98838,
  "configs": {
    "totalConfigFiles": 12,
    "byType": { "json": 3, "yaml": 2, "docker": 1, "env": 1, "typescript": 45 },
    "packageManagers": ["npm"],
    "dockerInfo": {
      "hasDockerfile": true,
      "hasDockerCompose": false,
      "services": [],
      "exposedPorts": ["3000"]
    },
    "buildTools": ["typescript"],
    "dependencies": { "total": 72, "production": 50, "development": 22 }
  },
  "generatedAt": "2025-01-12T10:30:00.000Z",
  "toolVersion": "1.0.0"
}
```

### Config file analysis

Config files are scanned at the repository root level and produce per-file metadata records with `type: "config"`. Key data extracted per type:

| File | Fields extracted |
|---|---|
| `package.json` | `name`, `version`, `scripts`, `dependencies`, `devDependencies` |
| `tsconfig.json` / `jsconfig.json` | `target`, `module`, `outDir`, `rootDir`, `strict`, `include`, `exclude` |
| `docker-compose.yml` | `services`, `serviceCount`, `exposedPorts`, `volumes` |
| `Dockerfile` | `baseImages`, `exposedPorts`, `volumes`, `workdir`, `entrypoint`, `env` variable names |
| `.env` | Variable names only (not values), `variableCount` |
| `pom.xml` | `groupId`, `artifactId`, `version`, `dependencyCount` |
| `requirements.txt` / `setup.py` | Package names, `dependencyCount` |
| `build.gradle` | `dependencyCount`, `isKotlinDSL` |

---

## 📋 Statements Captured (`--capture-statements`)

When `--capture-statements` is enabled, each function, class, and file scope is analyzed for the following statement types. Statement text is truncated to prevent oversized output.

| Context | Default text limit |
|---|---|
| Variable / type declarations | 1,000 chars (200 chars if the value is a function — already captured in `functions[]`) |
| Return statements | 200 chars |
| `query_statement` and `api_call` | 500 chars |

### 🔤 Variable & Type Declarations

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
| `return_statement` | Return statements — including those inside nested `if`/`else`, loops, and `try`/`catch` blocks |

---

### 🌐 API Call Statements (`api_call`)

Detected by traversing the full function body for HTTP client calls.

**Supported in:** TypeScript, JavaScript (Node.js), Vue

```json
{
  "type": "api_call",
  "method": "POST",
  "endpoint": "{param}/projects/{param}",
  "text": "apiFetch(url, { method: \"POST\", body: JSON.stringify(body) })",
  "startLine": 23,
  "endLine": 30
}
```

| Field | Description | Example |
|---|---|---|
| `method` | HTTP verb | `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `endpoint` | URL template (dynamic segments → `{param}`) | `{param}/users/{param}` |
| `text` | Raw call source (up to 500 chars) | `apiFetch(url, { method: "PUT", ... })` |
| `startLine` / `endLine` | Line range in the source file | `23` / `30` |

**HTTP method resolution order:**
1. Options object `method` field — `apiFetch(url, { method: "POST" })` → `POST`
2. Client method name — `axios.delete(url)` → `DELETE`
3. Default `GET` for bare `fetch`-style calls with no explicit method

**Endpoint resolution:**
- String literal: `fetch('/api/users')` → `/api/users`
- Template string: `` fetch(`/api/users/${id}`) `` → `/api/users/{param}`
- Variable reference: `const url = \`${base}/users\`; apiFetch(url, ...)` → resolved from the variable declaration in the same function scope

**Detected HTTP clients:**

| Type | Examples |
|---|---|
| Bare functions | `fetch`, `apiFetch`, `authFetch`, `$fetch`, `useFetch`, `customFetch` |
| Axios | `axios.get()`, `axios.post()`, `axios.put()`, `axios.delete()` |
| Angular HttpClient | `this.http.get()`, `this.$http.post()`, `this.httpClient.request()` |
| Generic clients | `api.get()`, `apiClient.post()`, `httpService.put()`, `restClient.delete()` |
| Other JS libraries | `got`, `superagent`, `ky`, `ofetch` |
| Python | `requests.get()`, `httpx.post()`, `session.put()` |
| Java / Spring | `restTemplate.getForObject()`, `webClient.post()` |
| C# / .NET | `HttpClient.GetAsync()`, `_httpClient.PostAsync()` |
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
| `text` | Raw call or query string (up to 500 chars) | `User.findAll({ where: { active: true } })` |
| `startLine` / `endLine` | Line range in the source file | `45` / `47` |

**Detected databases and ORMs:**

| Database / ORM | Detection | Key Methods / Patterns |
|---|---|---|
| **SQL (raw)** | String patterns | `SELECT`, `INSERT INTO`, `UPDATE ... SET`, `DELETE FROM`, `CREATE TABLE` |
| **Sequelize** | Method names | `findAll`, `findOne`, `findByPk`, `findOrCreate`, `upsert`, `bulkCreate`, `destroy` |
| **Prisma** | Method names | `findMany`, `findFirst`, `findUnique`, `create`, `update`, `delete`, `upsert` |
| **TypeORM** | Method names | `createQueryBuilder`, `getRepository`, `save`, `findOneBy` |
| **MongoDB** | Method names | `insertOne`, `updateOne`, `deleteOne`, `aggregate`, `findOneAndUpdate`, `bulkWrite` |
| **Neo4j** | Method names | `readTransaction`, `writeTransaction`, `executeRead`, `executeWrite` |
| **Redis** | Method names | `get`, `set`, `hget`, `hset`, `lpush`, `rpush`, `sadd`, `zadd`, `mset`, `mget` |
| **DynamoDB** | Method names | `getItem`, `putItem`, `deleteItem`, `batchGetItem`, `transactWriteItems`, `scan` |
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
| **Salesforce SOQL** | AST node | Inline `soql_expression` nodes (Salesforce only) |
| **Salesforce SOSL** | AST node | Inline `sosl_expression` nodes (Salesforce only) |

---

## 🌍 Language-Specific Behaviours

### TypeScript / JavaScript

- TypeScript path aliases (e.g. `@/`, `~/`) are resolved via `tsconfig.json` `compilerOptions.paths`.
- `--language typescript` also processes `.js` / `.jsx` files using the TypeScript grammar.
- TypeScript adds `generics` field to function and class records.
- TypeScript classes include `interface_declaration` as `type: "interface"`.
- `function_signature` nodes (interface method signatures) are extracted as functions with `statements: []`.

### Python

- Visibility is derived from naming convention: `__name` (not dunder) → `private`; `_name` → `protected`; all others → `public`.
- `self` and `cls` parameters are excluded from `params`.
- No `returnType` field is emitted (Python lacks static return type enforcement).

### Go

- Visibility is determined by capitalisation: exported (uppercase first letter) → `public`; unexported → `private`.
- Method records include a `receiver` field with the receiver type name.
- Go module imports are resolved against `go.mod` for local path mapping.
- Struct fields appear in `constructorParams`; embedded fields are listed as `_embedded_TypeName`.

### C\#

- Default visibility is `private` (not `public`).
- Supports `internal` visibility in addition to `public`, `private`, `protected`.
- Local functions (`local_function_statement`) are extracted as `type: "local_function"`.

### Vue

- `<script>` and `<script setup>` blocks are extracted and parsed with the JavaScript grammar.
- `<script lang="ts">` blocks are **skipped** — TypeScript-flavored Vue scripts are not currently analyzed.
- Line numbers in the output refer to the original `.vue` file, not the extracted script block.
- Path alias `@/` and `~/` are both resolved to `src/`.

### Perl

- File extensions: `.pl`, `.pm`.
- Both `subroutine_declaration_statement` and `subroutine_definition` nodes are extracted as functions.
- Visibility is derived from naming convention: `__name` (not dunder) → `private`; `_name` → `protected`; all others → `public`.
- Subroutines defined after a `package` statement are tagged with `kind: "method"`; otherwise `kind: "function"`.
- Function records include a `prototype` field when a Perl prototype is declared.
- Imports are resolved from `use`, `require`, and `do` statements. `use lib "..."` entries are recorded with `isLib: true`; `do "file"` entries are recorded with `isDo: true`. Imported symbol lists from `use Module qw(...)` are captured in `imported`.
- Direct calls extracted include `function_call_expression`, `ambiguous_function_call_expression`, and `method_call_expression` (with object resolution against imported modules).

### Salesforce Apex

- The `global` Apex keyword is mapped to `public` visibility; default is `private`.
- SOQL/SOSL queries are captured both via AST node type and string-literal pattern matching.
- Class references are resolved across all Apex files in the repository (cross-file call paths).

---

## 🚫 Ignore Patterns

Files and directories are excluded from analysis via `.repoignore` files (same syntax as `.gitignore`). Three layers of patterns are applied:

1. **Built-in defaults** (always active) — covers common noise across all languages:
   - VCS: `.git/`, `.svn/`, `.hg/`
   - Dependencies: `node_modules/`, `vendor/`, `bower_components/`, `site-packages/`
   - Build output: `dist/`, `build/`, `out/`, `target/`, `bin/`, `obj/`
   - Virtual envs: `venv/`, `.venv/`
   - Caches: `.gradle/`, `.m2/`, `.nuget/`, `.cache/`, `__pycache__/`
   - Docs / assets: `docs/`, `*.svg`, `*.png`, `*.jpg`, `*.pdf`, font files, video/audio files
   - Large data: `*.csv`, `*.parquet`, `*.h5`, model weights (`*.pt`, `*.onnx`)
   - Secrets: `.env`, `.env.*`, `*.secret`, `*.local`
   - Logs / temp: `*.log`, `*.tmp`, `*.lock`, `*.bak`
   - ⚠️ **Test files are excluded by default**: `tests/`, `test/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, `*.snap`

2. **Language-specific defaults** — extra patterns per language folder (e.g. `.next/`, `.nuxt/`, `*.min.js` for TypeScript/JavaScript; `*.pyc`, `.pytest_cache/` for Python; `*.pb.go`, `*_generated.go` for Go; `*.designer.cs`, `*.generated.cs` for C#).

3. **Repo-level overrides** — place a `.repoignore` file at the root of the target repository to add project-specific exclusions.

> **Important:** To include test files in the analysis, add negation overrides in a repo-level `.repoignore`.

---

## 🛠️ Other Commands

### Upload documents

Uploads files from a local directory to the BreezeAI documents API. Supported formats: `.pdf`, `.txt`, `.md`, `.png`, `.jpg`.

```bash
node cli.js upload-docs \
  --path <docs-dir> \
  --baseurl <api-url> \
  --uuid <project-uuid> \
  --user-api-key <key>
```

### HTTP server

Starts a local HTTP server for programmatic access to the analyzer.

```bash
node cli.js serve --port 3000
# Port can also be set via the PORT environment variable
```

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns `{ "status": "ok" }` |
| `POST` | `/api/analyze` | Analyze files passed as `{ files: [{ path, content }] }` in the request body. Returns parsed JSON directly (not `.ndjson.gz`). |
| `POST` | `/api/analyze-diff` | Fetch and analyze only changed files between two Git commits via GitHub API. Streams result as `.ndjson.gz` directly to S3 and notifies BreezeAI. |

**Environment variables used by the server:**

| Variable | Description |
|---|---|
| `PORT` | HTTP server port (default: `3000`) |
| `BREEZE_API_URL` | BreezeAI backend URL for stream-ingest notifications (required for `/api/analyze-diff`) |
| `AWS_S3_BUCKET` | S3 bucket for diff analysis output (required for `/api/analyze-diff`) |
| `AWS_ACCESS_KEY` | AWS access key ID |
| `AWS_SECRET_KEY` | AWS secret access key |
| `AWS_REGION` | AWS region (default: `us-west-2`) |
| `OPENAI_API_KEY` | OpenAI API key |
| `CLAUDE_API_KEY` | Anthropic Claude API key |
| `GEMINI_API_KEY` | Google Gemini API key |

---

## 🐳 Docker Deployment

A `Dockerfile` is included for containerised deployment:

```bash
docker build -t breeze-code-ontology-generator .
docker run -p 3000:3000 \
  -e BREEZE_API_URL=https://api.breezeai.com \
  -e AWS_S3_BUCKET=my-bucket \
  -e AWS_ACCESS_KEY=... \
  -e AWS_SECRET_KEY=... \
  breeze-code-ontology-generator
```

A Kubernetes deployment manifest (`breezeai-code-ontology-generator-deploy.yaml`) is also available in the repository root.
