#!/usr/bin/env node
/**
 * Code Description Generator
 * Generates AI-powered descriptions for files, classes, and functions
 * Usage: node generate-file-descriptions.js <repoPath> <treeJsonFile> --provider <provider> --api-key <key> --model <model>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");

// Command-line argument parsing
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(`
Usage: node generate-file-descriptions.js <repoPath> <treeJsonFile> [options]

Required arguments:
  <repoPath>         Path to the repository to scan
  <treeJsonFile>     JSON file with file tree (will be updated in-place)

Options:
  --provider <name>       LLM provider: openai, claude, gemini, bedrock, custom (default: openai)
  --api-key <key>         API key for the LLM provider
  --model <name>          Model name (default varies by provider)
  --api-url <url>         Custom API URL (for custom provider)
  --aws-region <region>   AWS region for Bedrock (default: us-west-2)
  --aws-access-key <key>  AWS access key ID for Bedrock
  --aws-secret-key <key>  AWS secret access key for Bedrock
  --max-concurrent <num>  Maximum concurrent API requests (default: 5)
  --max-file-size <kb>    Maximum file size in KB to process (default: 500)
  --help                  Show this help message

Examples:
  # Using OpenAI
  node generate-file-descriptions.js ./perl-app ./output/tree.json \\
    --provider openai --api-key sk-xxx --model gpt-4o-mini

  # Using Claude
  node generate-file-descriptions.js ./perl-app ./output/tree.json \\
    --provider claude --api-key sk-ant-xxx --model claude-3-5-sonnet-20241022

  # Using Gemini
  node generate-file-descriptions.js ./perl-app ./output/tree.json \\
    --provider gemini --api-key xxx --model gemini-2.5-flash

  # Using Amazon Bedrock
  node generate-file-descriptions.js ./perl-app ./output/tree.json \\
    --provider bedrock --aws-region us-west-2 --aws-access-key AKIA... --aws-secret-key xxx

  # Using custom/private LLM
  node generate-file-descriptions.js ./perl-app ./output/tree.json \\
    --provider custom --api-key xxx --api-url http://localhost:8080/v1/chat/completions --model llama3.2
`);
    process.exit(1);
  }

  if (args.includes("--help")) {
    console.error("(Help message shown above)");
    process.exit(0);
  }

  const config = {
    repoPath: path.resolve(args[0]),
    treeJsonFile: path.resolve(args[1]),
    provider: "openai",
    apiKey: null,
    model: null,
    apiUrl: null,
    awsRegion: "us-west-2",
    awsAccessKey: null,
    awsSecretKey: null,
    maxConcurrent: 5,
    maxFileSizeKB: 500,
  };

  // Parse optional flags
  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
        config.provider = args[++i];
        break;
      case "--api-key":
        config.apiKey = args[++i];
        break;
      case "--model":
        config.model = args[++i];
        break;
      case "--api-url":
        config.apiUrl = args[++i];
        break;
      case "--max-concurrent":
        config.maxConcurrent = parseInt(args[++i], 10);
        break;
      case "--max-file-size":
        config.maxFileSizeKB = parseInt(args[++i], 10);
        break;
      case "--aws-region":
        config.awsRegion = args[++i];
        break;
      case "--aws-access-key":
        config.awsAccessKey = args[++i];
        break;
      case "--aws-secret-key":
        config.awsSecretKey = args[++i];
        break;
    }
  }

  // Set default models based on provider
  if (!config.model) {
    const defaultModels = {
      openai: "gpt-4o-mini",
      claude: "claude-3-5-sonnet-20241022",
      gemini: "gemini-2.5-flash",
      bedrock: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      custom: "custom-model",
    };
    config.model = defaultModels[config.provider] || "gpt-4o-mini";
  }

  // Validate required fields
  if (config.provider === "bedrock") {
    if (!config.awsAccessKey || !config.awsSecretKey) {
      console.error("❌ Error: --aws-access-key and --aws-secret-key are required for bedrock provider");
      process.exit(1);
    }
  } else if (!config.apiKey) {
    console.error("❌ Error: --api-key is required");
    process.exit(1);
  }

  if (config.provider === "custom" && !config.apiUrl) {
    console.error("❌ Error: --api-url is required for custom provider");
    process.exit(1);
  }

  return config;
}

// -------------------------------------------------------------
// LLM Provider Implementations
// -------------------------------------------------------------

// Custom error class for API errors
class APIError extends Error {
  constructor(message, statusCode, isRetryable = false, isQuotaError = false) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
    this.isQuotaError = isQuotaError;
  }
}

// Check if error is quota/rate limit related
function isQuotaOrRateLimitError(statusCode, responseBody) {
  // Rate limit errors
  if (statusCode === 429) return { isQuota: false, isRateLimit: true };

  // Quota exceeded errors
  if (statusCode === 402 || statusCode === 403) {
    const errorMsg = JSON.stringify(responseBody).toLowerCase();
    if (errorMsg.includes('quota') || errorMsg.includes('exceeded') ||
        errorMsg.includes('limit') || errorMsg.includes('billing') ||
        errorMsg.includes('insufficient')) {
      return { isQuota: true, isRateLimit: false };
    }
  }

  // Check response body for quota-related messages
  if (responseBody && responseBody.error) {
    const errorMsg = (responseBody.error.message || responseBody.error.type || '').toLowerCase();
    if (errorMsg.includes('quota') || errorMsg.includes('rate_limit') ||
        errorMsg.includes('exceeded') || errorMsg.includes('insufficient_quota')) {
      return { isQuota: true, isRateLimit: statusCode === 429 };
    }
  }

  return { isQuota: false, isRateLimit: false };
}

class LLMProvider {
  constructor(config) {
    this.config = config;
  }

  async generateDescriptions(filePath, fileContent, fileData) {
    throw new Error("generateDescriptions must be implemented by subclass");
  }

  createPrompt(filePath, fileContent, fileData) {
    const classes = fileData.classes || [];
    const functions = fileData.functions || [];

    let prompt = `You are a code analyst. Analyze this code file and generate descriptions for the file, all classes, and all functions.

File: ${filePath}

Code:
\`\`\`
${fileContent}
\`\`\`

STRUCTURE:
- Classes: ${classes.map(c => c.name).join(', ') || 'None'}
- Functions: ${functions.map(f => f.name).join(', ') || 'None'}

Generate a JSON response with the following format:
{
  "file": "Brief description of the file (2-3 sentences, 50-100 words)",
  "classes": {
    "ClassName1": "Brief description of what this class does (1-2 sentences)",
    "ClassName2": "..."
  },
  "functions": {
    "functionName1": "Brief description of what this function does (1-2 sentences)",
    "functionName2": "..."
  }
}

RULES:
1. Keep descriptions concise and focused
2. Describe purpose and functionality, not implementation details
3. Use present tense
4. NO code snippets, NO formatting, just plain text descriptions
5. If a class or function name is not in the code, skip it
6. Return ONLY valid JSON, no markdown, no explanations

Respond with ONLY the JSON object.`;

    return prompt;
  }

  async makeRequest(url, headers, body) {
    const https = require("https");
    const http = require("http");
    const urlModule = require("url");

    const parsedUrl = urlModule.parse(url);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      };

      const req = protocol.request(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const statusCode = res.statusCode;

          try {
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (e) {
              parsed = { error: { message: data } };
            }

            // Check for HTTP errors
            if (statusCode < 200 || statusCode >= 300) {
              const { isQuota } = isQuotaOrRateLimitError(statusCode, parsed);

              if (isQuota) {
                reject(new APIError(
                  `API quota exceeded: ${parsed.error?.message || 'Please check your billing/quota settings'}`,
                  statusCode,
                  false,
                  true
                ));
                return;
              }

              reject(new APIError(
                `API request failed: ${parsed.error?.message || `HTTP ${statusCode}`}`,
                statusCode,
                false,
                false
              ));
              return;
            }

            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to process response: ${e.message}`));
          }
        });
      });

      req.on("error", (err) => {
        reject(new APIError(`Network error: ${err.message}`, 0, false, false));
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }
}

class OpenAIProvider extends LLMProvider {
  async generateDescriptions(filePath, fileContent, fileData) {
    const url = "https://api.openai.com/v1/chat/completions";
    const headers = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    const body = {
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: this.createPrompt(filePath, fileContent, fileData),
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: "json_object" }
    };

    const response = await this.makeRequest(url, headers, body);
    const content = response.choices[0].message.content.trim();
    return JSON.parse(content);
  }
}

class ClaudeProvider extends LLMProvider {
  async generateDescriptions(filePath, fileContent, fileData) {
    const url = "https://api.anthropic.com/v1/messages";
    const headers = {
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const body = {
      model: this.config.model,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: this.createPrompt(filePath, fileContent, fileData),
        },
      ],
      temperature: 0.3,
    };

    const response = await this.makeRequest(url, headers, body);
    const content = response.content[0].text.trim();
    // Remove markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    return JSON.parse(jsonContent);
  }
}

class GeminiProvider extends LLMProvider {
  async generateDescriptions(filePath, fileContent, fileData) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;
    const headers = {};
    const body = {
      contents: [
        {
          parts: [
            {
              text: this.createPrompt(filePath, fileContent, fileData),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000,
        responseMimeType: "application/json"
      },
    };
    const response = await this.makeRequest(url, headers, body);
    const content = response.candidates[0]?.content?.parts?.[0]?.text?.trim();
    return JSON.parse(content);
  }
}

class CustomProvider extends LLMProvider {
  async generateDescriptions(filePath, fileContent, fileData) {
    const url = this.config.apiUrl;
    const headers = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    const body = {
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: this.createPrompt(filePath, fileContent, fileData),
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      format: "json"
    };

    const response = await this.makeRequest(url, headers, body);
    let content;
    // Try to handle both OpenAI-style and custom response formats
    if (response.choices && response.choices[0]) {
      content = response.choices[0].message.content.trim();
    } else if (response.content) {
      content = response.content.trim();
    } else if (response.text) {
      content = response.text.trim();
    } else {
      throw new Error("Unexpected response format from custom API");
    }

    // Remove markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    return JSON.parse(jsonContent);
  }
}

class BedrockProvider extends LLMProvider {
  async generateDescriptions(filePath, fileContent, fileData) {
    const crypto = require("crypto");
    const https = require("https");

    const region = this.config.awsRegion;
    const modelId = this.config.model;
    const accessKey = this.config.awsAccessKey;
    const secretKey = this.config.awsSecretKey;

    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const endpoint = `https://${host}/model/${encodeURIComponent(modelId)}/invoke`;

    // Build request body based on model type
    let body;
    if (modelId.startsWith("anthropic.")) {
      // Anthropic Claude models on Bedrock
      body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: this.createPrompt(filePath, fileContent, fileData),
          },
        ],
      });
    } else if (modelId.startsWith("amazon.titan")) {
      // Amazon Titan models
      body = JSON.stringify({
        inputText: this.createPrompt(filePath, fileContent, fileData),
        textGenerationConfig: {
          maxTokenCount: 2000,
          temperature: 0.3,
        },
      });
    } else if (modelId.startsWith("meta.llama")) {
      // Meta Llama models on Bedrock
      body = JSON.stringify({
        prompt: this.createPrompt(filePath, fileContent, fileData),
        max_gen_len: 2000,
        temperature: 0.3,
      });
    } else if (modelId.startsWith("mistral.")) {
      // Mistral models on Bedrock
      body = JSON.stringify({
        prompt: `<s>[INST] ${this.createPrompt(filePath, fileContent, fileData)} [/INST]`,
        max_tokens: 2000,
        temperature: 0.3,
      });
    } else {
      // Default to Anthropic format
      body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: this.createPrompt(filePath, fileContent, fileData),
          },
        ],
      });
    }

    // AWS Signature Version 4 signing
    const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = datetime.substring(0, 8);
    const service = "bedrock";
    const method = "POST";
    const path = `/model/${encodeURIComponent(modelId)}/invoke`;

    const headers = {
      "Content-Type": "application/json",
      "Host": host,
      "X-Amz-Date": datetime,
    };

    // Create canonical request
    const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
      .sort()
      .join("\n") + "\n";

    const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

    const canonicalRequest = [
      method,
      path,
      "", // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    // Create string to sign
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${date}/${region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      datetime,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    // Calculate signature
    const getSignatureKey = (key, dateStamp, regionName, serviceName) => {
      const kDate = crypto.createHmac("sha256", `AWS4${key}`).update(dateStamp).digest();
      const kRegion = crypto.createHmac("sha256", kDate).update(regionName).digest();
      const kService = crypto.createHmac("sha256", kRegion).update(serviceName).digest();
      const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();
      return kSigning;
    };

    const signingKey = getSignatureKey(secretKey, date, region, service);
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    // Create authorization header
    const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    headers["Authorization"] = authorizationHeader;

    // Make request
    const response = await this.makeBedrockRequest(endpoint, headers, body);

    // Parse response based on model type
    let content;
    if (modelId.startsWith("anthropic.")) {
      content = response.content[0].text.trim();
    } else if (modelId.startsWith("amazon.titan")) {
      content = response.results[0].outputText.trim();
    } else if (modelId.startsWith("meta.llama")) {
      content = response.generation.trim();
    } else if (modelId.startsWith("mistral.")) {
      content = response.outputs[0].text.trim();
    } else {
      // Default to Anthropic format
      content = response.content[0].text.trim();
    }

    // Remove markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    return JSON.parse(jsonContent);
  }

  async makeBedrockRequest(url, headers, body) {
    const https = require("https");
    const urlModule = require("url");

    const parsedUrl = urlModule.parse(url);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        method: "POST",
        headers: headers,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const statusCode = res.statusCode;

          try {
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (e) {
              parsed = { error: { message: data } };
            }

            if (statusCode < 200 || statusCode >= 300) {
              const errorMessage = parsed.message || parsed.error?.message || `HTTP ${statusCode}`;
              reject(new APIError(`Bedrock API error: ${errorMessage}`, statusCode, false, false));
              return;
            }

            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to process Bedrock response: ${e.message}`));
          }
        });
      });

      req.on("error", (err) => {
        reject(new APIError(`Network error: ${err.message}`, 0, false, false));
      });

      req.write(body);
      req.end();
    });
  }
}

// Factory function to create the appropriate provider
function createProvider(config) {
  switch (config.provider.toLowerCase()) {
    case "openai":
      return new OpenAIProvider(config);
    case "claude":
      return new ClaudeProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    case "bedrock":
      return new BedrockProvider(config);
    case "custom":
      return new CustomProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// -------------------------------------------------------------
// Main Processing Logic
// -------------------------------------------------------------

async function processFiles(config) {
  console.log(`📂 Loading JSON file: ${config.treeJsonFile}`);

  // Load existing tree JSON
  if (!fs.existsSync(config.treeJsonFile)) {
    console.error(`❌ Error: JSON file not found: ${config.treeJsonFile}`);
    process.exit(1);
  }

  const fullData = JSON.parse(fs.readFileSync(config.treeJsonFile, "utf8"));

  // Support both old format (array) and new format (object with files array)
  const fileTree = Array.isArray(fullData) ? fullData : (fullData.files || []);
  const hasProjectMetaData = !Array.isArray(fullData) && fullData.projectMetaData;

  console.log(`Found ${fileTree.length} files in JSON`);

  const provider = createProvider(config);
  console.log(`🤖 Using provider: ${config.provider} with model: ${config.model}`);

  const maxFileSizeBytes = config.maxFileSizeKB * 1024;

  // Process files one at a time
  let processed = 0;
  let skipped = 0;
  let updated = 0;

  // Helper function to save progress
  const saveProgress = () => {
    const outputData = hasProjectMetaData
      ? { ...fullData, files: fileTree }
      : fileTree;
    fs.writeFileSync(config.treeJsonFile, JSON.stringify(outputData, null, 2));
  };

  for (let i = 0; i < fileTree.length; i++) {
    const fileEntry = fileTree[i];
    const relativePath = fileEntry.path;
    const fullPath = path.join(config.repoPath, relativePath);

    // Skip if already has descriptions
    const hasFileDesc = fileEntry.description && !fileEntry.description.startsWith("[Error:");
    const allClassesHaveDesc = (fileEntry.classes || []).every(c => c.description);
    const allFunctionsHaveDesc = (fileEntry.functions || []).every(f => f.description);

    if (hasFileDesc && allClassesHaveDesc && allFunctionsHaveDesc) {
      console.log(`⏭️  Already complete: ${relativePath}`);
      skipped++;
      continue;
    }

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      console.log(`⚠️  File not found: ${relativePath}`);
      skipped++;
      continue;
    }

    // Check file size
    const stats = fs.statSync(fullPath);
    if (stats.size > maxFileSizeBytes) {
      console.log(`⏭️  Skipping large file: ${relativePath} (${Math.round(stats.size / 1024)}KB)`);
      skipped++;
      continue;
    }

    try {
      // Read file content
      const content = fs.readFileSync(fullPath, "utf8");

      // Generate descriptions
      console.log(`🔍 Processing: ${relativePath}`);
      const descriptions = await provider.generateDescriptions(relativePath, content, fileEntry);

      processed++;
      updated++;

      // Apply descriptions directly to fileTree entry (preserve existing)
      if (descriptions.file && !fileEntry.description) {
        fileEntry.description = descriptions.file;
      }

      // Class descriptions (preserve existing)
      if (fileEntry.classes && descriptions.classes) {
        fileEntry.classes = fileEntry.classes.map(cls => ({
          ...cls,
          description: cls.description || descriptions.classes[cls.name]
        }));
      }

      // Function descriptions (preserve existing)
      if (fileEntry.functions && descriptions.functions) {
        fileEntry.functions = fileEntry.functions.map(fn => ({
          ...fn,
          description: fn.description || descriptions.functions[fn.name]
        }));
      }

      console.log(`✅ [${processed}] ${relativePath}`);

      // Save progress after each file
      saveProgress();
      console.log(`💾 Progress saved (${i + 1}/${fileTree.length} files)`);

    } catch (error) {
      // Save progress before exiting on error
      saveProgress();
      console.error(`\n❌ Error processing ${relativePath}:`, error.message || error);
      console.log(`\n⚠️  Stopping due to error. Progress has been saved.`);
      console.log(`   Total files: ${fileTree.length}`);
      console.log(`   Updated: ${updated}`);
      console.log(`   Skipped: ${skipped}`);
      console.log(`   JSON file updated: ${config.treeJsonFile}`);
      process.exit(1);
    }
  }

  console.log(`\n✨ Processing complete!`);
  console.log(`   Total files: ${fileTree.length}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   JSON file updated: ${config.treeJsonFile}`);
}

// -------------------------------------------------------------
// MAIN EXECUTION
// -------------------------------------------------------------
(async () => {
  try {
    const config = parseArgs();
    await processFiles(config);
  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
})();
