# File Description Generator - Complete Guide

## Overview

The `generate-file-descriptions.js` script uses AI to automatically generate natural language descriptions for each file in your codebase. It scans the repository directly (like file-tree-mapper.js) and updates the JSON file in-place. It supports multiple LLM providers and can work with both cloud-based and self-hosted models.

## Features

- **Direct Repository Scanning**: Reads files directly from the folder (no need for pre-generated JSON)
- **In-Place Updates**: Updates the JSON file incrementally (preserves existing data)
- **Multiple LLM Providers**: OpenAI, Claude (Anthropic), Google Gemini, Amazon Bedrock, and custom endpoints
- **Concurrent Processing**: Process multiple files in parallel with rate limiting
- **File Size Filtering**: Skip files that are too large to process efficiently
- **Smart Skip Logic**: Skips files that already have descriptions
- **Incremental Saving**: Saves progress after each batch (resume-friendly)
- **Error Handling**: Continue processing even if individual files fail
- **Progress Tracking**: Real-time progress updates during processing
- **Flexible Configuration**: Command-line arguments for all options

## Installation

No additional dependencies are required beyond the base project dependencies. The script uses Node.js built-in modules for HTTP/HTTPS requests.

## Basic Usage

### 1. OpenAI (GPT-4, GPT-3.5-Turbo)

```bash
node generate-file-descriptions.js ./my-repo ./output/tree.json \
  --provider openai \
  --api-key sk-proj-xxxxxxxxxxxxxxxxx \
  --model gpt-4o-mini
```

**Available Models:**
- `gpt-4o` - Most capable, slower, more expensive
- `gpt-4o-mini` - Fast, cost-effective (recommended, default)
- `gpt-3.5-turbo` - Fastest, cheapest

**API Key:** Get from https://platform.openai.com/api-keys

---

### 2. Claude (Anthropic)

```bash
node generate-file-descriptions.js ./my-repo ./output/tree.json \
  --provider claude \
  --api-key sk-ant-xxxxxxxxxxxxxxxxx \
  --model claude-3-5-sonnet-20241022
```

**Available Models:**
- `claude-3-5-sonnet-20241022` - Best balance of speed and quality (recommended, default)
- `claude-3-5-haiku-20241022` - Fastest, most cost-effective
- `claude-3-opus-20240229` - Most capable, slower

**API Key:** Get from https://console.anthropic.com/settings/keys

---

### 3. Google Gemini

```bash
node generate-file-descriptions.js ./my-repo ./output/tree.json \
  --provider gemini \
  --api-key AIzaSyxxxxxxxxxxxxxxxxx \
  --model gemini-2.5-flash
```

**Available Models:**
- `gemini-2.5-flash` - Fast and efficient (recommended, default)
- `gemini-1.5-pro` - More capable, slower
- `gemini-2.0-flash-exp` - Experimental, latest features

**API Key:** Get from https://aistudio.google.com/app/apikey

---

### 4. Amazon Bedrock

```bash
node generate-file-descriptions.js ./my-repo ./output/tree.json \
  --provider bedrock \
  --aws-region us-east-1 \
  --aws-access-key AKIAXXXXXXXXXXXXXXXX \
  --aws-secret-key xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --model anthropic.claude-3-5-sonnet-20241022-v2:0
```

**Available Models:**
- `anthropic.claude-3-5-sonnet-20241022-v2:0` - Claude 3.5 Sonnet (recommended, default)
- `anthropic.claude-3-5-haiku-20241022-v1:0` - Claude 3.5 Haiku (faster, cheaper)
- `anthropic.claude-3-opus-20240229-v1:0` - Claude 3 Opus (most capable)
- `amazon.titan-text-express-v1` - Amazon Titan Text Express
- `meta.llama3-70b-instruct-v1:0` - Meta Llama 3 70B
- `mistral.mistral-large-2407-v1:0` - Mistral Large

**AWS Credentials:**
- Create IAM user with `bedrock:InvokeModel` permission
- Get access key and secret key from AWS IAM Console
- Ensure the model is enabled in your AWS Bedrock console

**Regions:** Bedrock is available in: `us-east-1`, `us-west-2`, `eu-west-1`, `ap-northeast-1`, etc.

---

### 5. Custom/Private LLM

For self-hosted models (Ollama, vLLM, LocalAI, etc.):

```bash
node generate-file-descriptions.js ./my-repo ./output/tree.json \
  --provider custom \
  --api-key your-api-key-if-needed \
  --api-url http://localhost:11434/v1/chat/completions \
  --model llama3.2
```

**Compatible Endpoints:**
- **Ollama**: `http://localhost:11434/v1/chat/completions`
- **vLLM**: `http://localhost:8000/v1/chat/completions`
- **LocalAI**: `http://localhost:8080/v1/chat/completions`
- **Text Generation WebUI**: `http://localhost:5000/v1/chat/completions`
- **LM Studio**: `http://localhost:1234/v1/chat/completions`

The endpoint should be OpenAI-compatible (accepts the same request/response format).

---

## Advanced Options

### Control Concurrency

Limit the number of simultaneous API requests to respect rate limits:

```bash
node generate-file-descriptions.js ./my-repo ./input.json ./output.json \
  --provider openai \
  --api-key sk-xxx \
  --max-concurrent 3
```

Default: 5 concurrent requests

### Set Maximum File Size

Skip files larger than a certain size (in KB):

```bash
node generate-file-descriptions.js ./my-repo ./input.json ./output.json \
  --provider openai \
  --api-key sk-xxx \
  --max-file-size 200
```

Default: 500 KB

Large files will be skipped with a note in the description field.

---

## Complete Example Workflow

Here's a full workflow from repository scanning to description generation:

```bash
# Step 1: Generate the file tree (optional - script can work without this)
node file-tree-mapper.js ./perl-app ./output/mapper.json ./output/tree.json

# Step 2: Add AI descriptions (reads repo directly and updates tree.json in-place)
node generate-file-descriptions.js ./perl-app ./output/tree.json \
  --provider openai \
  --api-key sk-proj-your-key \
  --model gpt-4o-mini \
  --max-concurrent 5 \
  --max-file-size 500

# Step 3: Import to Neo4j (if desired)
node tree-to-graph.js ./output/tree.json
```

**Note:** The script can now work with or without a pre-existing JSON file:
- **With existing JSON**: Loads it, preserves all existing data, and adds descriptions
- **Without JSON**: Creates a new JSON file with just paths, names, and descriptions

---

## Output Format

The script adds a `description` field to each file entry in the JSON:

**Before:**
```json
{
  "path": "lib/MyModule.pm",
  "name": "MyModule.pm",
  "loc": 145,
  "importFiles": ["lib/Helper.pm"],
  "externalImports": ["DBI", "JSON"]
}
```

**After:**
```json
{
  "path": "lib/MyModule.pm",
  "name": "MyModule.pm",
  "loc": 145,
  "importFiles": ["lib/Helper.pm"],
  "externalImports": ["DBI", "JSON"],
  "description": "This module provides database access utilities for the application. It handles connection pooling, query execution, and result set processing using DBI, with JSON serialization support for API responses."
}
```

---

## Error Handling

The script handles errors gracefully:

- **File not found**: Marked with error message in description
- **File too large**: Skipped with note
- **API errors**: Marked with error message, processing continues
- **Network issues**: Retryable errors are logged, processing continues

Failed files are included in the output with error descriptions so you can identify and fix issues.

---

## Performance Tips

1. **Use smaller models for faster processing:**
   - OpenAI: `gpt-4o-mini` instead of `gpt-4o`
   - Claude: `claude-3-5-haiku-20241022` instead of `claude-3-5-sonnet-20241022`
   - Gemini: `gemini-1.5-flash` instead of `gemini-1.5-pro`

2. **Adjust concurrency based on your API tier:**
   - Free tier: `--max-concurrent 2`
   - Paid tier: `--max-concurrent 10`

3. **Skip generated or vendor files** by filtering your tree JSON first

4. **Process in batches** for very large repositories (split the input JSON)

---

## Cost Estimation

Approximate costs per 1000 files (average 200 lines each):

| Provider | Model | Estimated Cost |
|----------|-------|----------------|
| OpenAI | gpt-4o-mini | $0.50 - $2.00 |
| OpenAI | gpt-4o | $5.00 - $20.00 |
| Claude | haiku | $0.50 - $2.00 |
| Claude | sonnet | $2.00 - $8.00 |
| Gemini | flash | $0.10 - $0.50 |
| Bedrock | Claude haiku | $0.50 - $2.00 |
| Bedrock | Claude sonnet | $2.00 - $8.00 |
| Custom | local | $0.00 (free) |

*Estimates vary based on file size and complexity*

---

## Troubleshooting

### API Rate Limits

If you hit rate limits, reduce concurrency:
```bash
--max-concurrent 2
```

### Authentication Errors

- Verify your API key is correct
- Check if the key has the necessary permissions
- For custom endpoints, verify the authorization header format

### Timeout Issues

For slow models or large files:
- Reduce `--max-file-size` to skip large files
- Use a faster model
- Check your network connection

### Custom Endpoint Not Working

Ensure your endpoint:
1. Accepts OpenAI-compatible requests
2. Returns responses in the expected format
3. Is accessible from your machine
4. Supports the model name you specified

---

## Integration with Neo4j

The descriptions will be automatically included when you import to Neo4j:

```bash
node tree-to-graph.js ./output/tree.json
```

You can then query descriptions in Neo4j:

```cypher
MATCH (f:File)
WHERE f.description CONTAINS "database"
RETURN f.path, f.description
```

---

## Resume Capability

If the script is interrupted, simply run it again with the same arguments. It will:
- Load the existing JSON file
- Skip files that already have descriptions
- Continue processing remaining files
- Save progress incrementally after each batch

This makes it safe to interrupt and resume large processing jobs.

---

## Environment Variables (Optional)

Instead of passing API keys on the command line, you can use environment variables:

```bash
export OPENAI_API_KEY=sk-proj-xxx
export ANTHROPIC_API_KEY=sk-ant-xxx
export GEMINI_API_KEY=AIzaSy-xxx
export AWS_ACCESS_KEY_ID=AKIA-xxx
export AWS_SECRET_ACCESS_KEY=xxx
export AWS_REGION=us-east-1

# Then modify the script to read from these vars
```

---

## Privacy & Security

- API keys are never logged or stored
- File contents are sent to the LLM provider (cloud or local)
- For sensitive codebases, use a self-hosted/private LLM with `--provider custom`
- Review your provider's data retention policies

---

## Support & Feedback

For issues, questions, or feature requests, please check the main project README or repository issues.
