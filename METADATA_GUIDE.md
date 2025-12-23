# Metadata Generation Guide

## Overview

The `add-metadata.js` script uses LLM to automatically add semantic roles and metadata to your code graph JSON output. It analyzes files, classes, and functions to identify their architectural roles and extract relevant metadata.

## Features

- **Multiple LLM Providers**: OpenAI, Claude (Anthropic), Google Gemini, and custom endpoints
- **Dual Accuracy Modes**:
  - **Low**: Fast, analyzes JSON structure only
  - **High**: Slower but accurate, includes actual source code
- **Concurrent Processing**: Process multiple nodes in parallel with rate limiting
- **Incremental Saving**: Saves progress every 10 files (resume-friendly)
- **Flexible Node Selection**: Process files, classes, and/or functions
- **Multiple Roles**: Each node can have multiple architectural roles

## Installation

No additional dependencies needed beyond the base project.

## Basic Usage

### 1. OpenAI (GPT-4o-mini)

```bash
node add-metadata.js output.json /path/to/repo \
  --provider openai \
  --api-key sk-proj-xxxxxxxxxx \
  --mode low
```

### 2. Claude (Anthropic)

```bash
node add-metadata.js output.json /path/to/repo \
  --provider claude \
  --api-key sk-ant-xxxxxxxxxx \
  --mode low
```

### 3. Gemini

```bash
node add-metadata.js output.json /path/to/repo \
  --provider gemini \
  --api-key AIzaSyxxxxxxxxxx \
  --mode low
```

### 4. Custom/Local LLM (Ollama, vLLM, etc.)

```bash
node add-metadata.js output.json /path/to/repo \
  --provider custom \
  --api-url http://localhost:11434/v1/chat/completions \
  --model llama3.2 \
  --mode low
```

## Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--provider` | LLM provider: `openai`, `claude`, `gemini`, `custom` | `openai` |
| `--api-key` | API key for the provider | Required (except custom) |
| `--model` | Model name to use | Auto-selected per provider |
| `--mode` | Accuracy mode: `low` or `high` | `low` |
| `--api-url` | Custom API endpoint (for custom provider) | - |
| `--max-concurrent` | Maximum concurrent API requests | `3` |
| `--node-types` | Node types to process: `file,class,function` | All |

## Default Models

- **OpenAI**: `gpt-4o-mini`
- **Claude**: `claude-3-5-haiku-20241022`
- **Gemini**: `gemini-2.0-flash-exp`
- **Custom**: `llama3.2`

## Accuracy Modes

### Low Accuracy Mode (`--mode low`)
- **Pros**: Fast, cheap, no file I/O
- **Cons**: Less accurate, relies only on extracted metadata
- **Best for**: Quick analysis, large codebases, initial exploration

### High Accuracy Mode (`--mode high`)
- **Pros**: Very accurate, analyzes actual source code
- **Cons**: Slower, more expensive, requires file access
- **Best for**: Final analysis, critical projects, detailed documentation

## Supported Roles and Metadata

### Backend Roles

#### Service
- **Metadata**: `domain`, `responsibility`, `usedBy`, `stateless`
- **Example**:
  ```json
  {
    "domain": "user-management",
    "responsibility": "Handle user CRUD operations",
    "usedBy": ["UserController", "AuthService"],
    "stateless": true
  }
  ```

#### Controller
- **Metadata**: `framework`, `basePath`, `routes`, `authRequired`, `version`
- **Example**:
  ```json
  {
    "framework": "Express",
    "basePath": "/api/users",
    "routes": ["/", "/:id", "/:id/orders"],
    "authRequired": true,
    "version": "v1"
  }
  ```

#### Repository
- **Metadata**: `entity`, `dbType`, `operations`, `transactional`
- **Example**:
  ```json
  {
    "entity": "User",
    "dbType": "PostgreSQL",
    "operations": ["create", "read", "update", "delete"],
    "transactional": true
  }
  ```

#### DTO (Data Transfer Object)
- **Metadata**: `fields`, `usedIn`, `validationRules`
- **Example**:
  ```json
  {
    "fields": ["email", "password", "name"],
    "usedIn": ["UserController", "AuthService"],
    "validationRules": ["email format", "password min 8 chars"]
  }
  ```

#### Entity
- **Metadata**: `tableName`, `fields`, `primaryKey`, `relations`
- **Example**:
  ```json
  {
    "tableName": "users",
    "fields": ["id", "email", "password", "createdAt"],
    "primaryKey": "id",
    "relations": ["hasMany:Order", "hasOne:Profile"]
  }
  ```

#### API
- **Metadata**: `httpMethod`, `path`, `requestDTO`, `responseDTO`, `statusCodes`
- **Example**:
  ```json
  {
    "httpMethod": "POST",
    "path": "/api/users",
    "requestDTO": "CreateUserDTO",
    "responseDTO": "UserDTO",
    "statusCodes": [200, 400, 409]
  }
  ```

### Frontend Roles

#### Component
- **Metadata**: `props`, `stateUsed`, `children`, `hooksUsed`
- **Example**:
  ```json
  {
    "props": ["user", "onUpdate", "isLoading"],
    "stateUsed": ["isEditing", "formData"],
    "children": ["UserAvatar", "EditButton"],
    "hooksUsed": ["useState", "useEffect", "useUser"]
  }
  ```

#### Page
- **Metadata**: `route`, `layout`, `seo`, `protected`
- **Example**:
  ```json
  {
    "route": "/dashboard",
    "layout": "DashboardLayout",
    "seo": {"title": "Dashboard", "description": "User dashboard"},
    "protected": true
  }
  ```

#### Hook
- **Metadata**: `returns`, `sideEffects`, `dependencies`
- **Example**:
  ```json
  {
    "returns": {"user": "User", "loading": "boolean", "error": "Error"},
    "sideEffects": ["fetches user data", "updates cache"],
    "dependencies": ["userService", "cacheStore"]
  }
  ```

#### Store
- **Metadata**: `storeType`, `stateShape`, `actions`, `persistence`
- **Example**:
  ```json
  {
    "storeType": "Redux",
    "stateShape": {"users": "User[]", "currentUser": "User"},
    "actions": ["fetchUsers", "updateUser", "deleteUser"],
    "persistence": "localStorage"
  }
  ```

#### EventEmitter
- **Metadata**: `eventType`, `target`, `sideEffects`
- **Example**:
  ```json
  {
    "eventType": "userUpdated",
    "target": "UserStore",
    "sideEffects": ["invalidates cache", "triggers notification"]
  }
  ```

### Cross-Cutting Roles

#### Utility
- **Metadata**: `pure`, `category`, `reusedBy`
- **Example**:
  ```json
  {
    "pure": true,
    "category": "string-manipulation",
    "reusedBy": ["UserService", "AuthService", "EmailService"]
  }
  ```

#### Constants
- **Metadata**: `values`, `scope`
- **Example**:
  ```json
  {
    "values": ["MAX_RETRIES: 3", "TIMEOUT: 5000"],
    "scope": "application-wide"
  }
  ```

#### Types
- **Metadata**: `typeKind`, `usedBy`
- **Example**:
  ```json
  {
    "typeKind": "interface",
    "usedBy": ["UserService", "UserController", "UserRepository"]
  }
  ```

#### Error
- **Metadata**: `errorCode`, `httpStatus`, `recoverable`
- **Example**:
  ```json
  {
    "errorCode": "USER_NOT_FOUND",
    "httpStatus": 404,
    "recoverable": false
  }
  ```

#### Test
- **Metadata**: `testType`, `covers`, `mockedDependencies`
- **Example**:
  ```json
  {
    "testType": "unit",
    "covers": ["UserService.createUser", "UserService.updateUser"],
    "mockedDependencies": ["UserRepository", "EmailService"]
  }
  ```

## Output Format

The script adds `roles` and `metadata` fields to each node:

### Before
```json
{
  "path": "services/UserService.js",
  "functions": [{
    "name": "createUser",
    "type": "function",
    "params": ["userData"],
    "startLine": 10,
    "endLine": 25
  }]
}
```

### After
```json
{
  "path": "services/UserService.js",
  "roles": ["Service"],
  "metadata": {
    "Service": {
      "domain": "user-management",
      "responsibility": "User CRUD operations",
      "usedBy": ["UserController"],
      "stateless": true
    }
  },
  "functions": [{
    "name": "createUser",
    "type": "function",
    "params": ["userData"],
    "startLine": 10,
    "endLine": 25,
    "roles": ["Service", "API"],
    "metadata": {
      "Service": {
        "domain": "user-management",
        "responsibility": "Create new user account",
        "usedBy": ["UserController"],
        "stateless": false
      },
      "API": {
        "httpMethod": null,
        "path": null,
        "requestDTO": "CreateUserDTO",
        "responseDTO": "UserDTO",
        "statusCodes": [201, 400, 409]
      }
    }
  }]
}
```

## Examples

### Process Only Functions (Fast)
```bash
node add-metadata.js output.json /repo \
  --provider openai \
  --api-key sk-xxx \
  --node-types function \
  --mode low
```

### High Accuracy for Critical Files
```bash
node add-metadata.js output.json /repo \
  --provider claude \
  --api-key sk-ant-xxx \
  --mode high \
  --max-concurrent 2
```

### Use Local Ollama (Free)
```bash
node add-metadata.js output.json /repo \
  --provider custom \
  --api-url http://localhost:11434/v1/chat/completions \
  --model llama3.2 \
  --mode low
```

### Process Only Classes
```bash
node add-metadata.js output.json /repo \
  --provider gemini \
  --api-key AIza-xxx \
  --node-types class \
  --mode low
```

## Performance Tips

1. **Start with low mode**: Test with `--mode low` first
2. **Adjust concurrency**: Use `--max-concurrent 1` for free tiers, `10` for paid
3. **Process incrementally**: Use `--node-types` to process files, then classes, then functions
4. **Use local LLM**: For large codebases, use Ollama with a small model
5. **Monitor costs**: OpenAI gpt-4o-mini is ~$0.15/1M tokens

## Cost Estimation

For a typical codebase (100 files, 500 functions):

| Provider | Mode | Est. Cost |
|----------|------|-----------|
| OpenAI (gpt-4o-mini) | low | $0.50 - $2 |
| OpenAI (gpt-4o-mini) | high | $2 - $10 |
| Claude (haiku) | low | $0.50 - $2 |
| Gemini (flash) | low | $0.10 - $0.50 |
| Ollama (local) | any | $0 (free) |

## Troubleshooting

### Rate Limits
Reduce `--max-concurrent`:
```bash
--max-concurrent 1
```

### Out of Memory
Process incrementally:
```bash
# First files
node add-metadata.js output.json /repo --node-types file ...

# Then classes
node add-metadata.js output.json /repo --node-types class ...

# Finally functions
node add-metadata.js output.json /repo --node-types function ...
```

### Inaccurate Results
Switch to high mode:
```bash
--mode high
```

### Custom Endpoint Not Working
Ensure your endpoint is OpenAI-compatible. For Ollama:
```bash
ollama serve
# Then use: http://localhost:11434/v1/chat/completions
```

## Resume Capability

The script saves progress every 10 files. If interrupted, simply run again - it will continue from where it left off (nodes without `roles` field will be processed).

## Integration with Neo4j

After adding metadata, import to Neo4j:
```bash
node tree-to-graph.js output.json
```

Query by role:
```cypher
MATCH (n {roles: ['Service']})
RETURN n.path, n.metadata.Service.domain
```

## Support

For issues or questions, check the main project README.
