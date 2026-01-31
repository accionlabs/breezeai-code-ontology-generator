#!/usr/bin/env node
/**
 * Add metadata to output.json using LLM analysis
 *
 * Usage:
 *   node add-metadata.js <output.json> <repoPath> --provider <openai|claude|gemini|bedrock|custom> --api-key <key> [options]
 *
 * Options:
 *   --mode <low|high>           Accuracy mode: low (JSON only) or high (with code) [default: low]
 *   --model <model-name>        Model to use
 *   --api-url <url>             Custom API endpoint URL
 *   --aws-region <region>       AWS region for Bedrock (default: us-west-2)
 *   --aws-access-key <key>      AWS access key ID for Bedrock
 *   --aws-secret-key <key>      AWS secret access key for Bedrock
 *   --max-concurrent <n>        Max concurrent requests [default: 3]
 *   --node-types <types>        Comma-separated: file,class,function [default: all]
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 4) {
  console.error("Usage: node add-metadata.js <output.json> <repoPath> --provider <provider> --api-key <key> [options]");
  process.exit(1);
}

const outputPath = path.resolve(args[0]);
const repoPath = path.resolve(args[1]);

// Parse arguments
const config = {
  provider: getArg("--provider", "openai"),
  apiKey: getArg("--api-key"),
  model: getArg("--model"),
  apiUrl: getArg("--api-url"),
  awsRegion: getArg("--aws-region", "us-west-2"),
  awsAccessKey: getArg("--aws-access-key"),
  awsSecretKey: getArg("--aws-secret-key"),
  mode: getArg("--mode", "low"), // low or high accuracy
  maxConcurrent: parseInt(getArg("--max-concurrent", "3")),
  nodeTypes: getArg("--node-types", "file,class,function").split(",")
};

// Set default models
if (!config.model) {
  const defaultModels = {
    openai: "gpt-4o-mini",
    claude: "claude-3-5-haiku-20241022",
    gemini: "gemini-2.5-flash",
    bedrock: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    custom: "llama3.2"
  };
  config.model = defaultModels[config.provider] || "gpt-4o-mini";
}

if (config.provider === "bedrock") {
  if (!config.awsAccessKey || !config.awsSecretKey) {
    console.error("Error: --aws-access-key and --aws-secret-key are required for bedrock provider");
    process.exit(1);
  }
} else if (!config.apiKey && config.provider !== "custom") {
  console.error("Error: --api-key is required");
  process.exit(1);
}

function getArg(flag, defaultValue = null) {
  const index = args.indexOf(flag);
  if (index === -1) return defaultValue;
  return args[index + 1] || defaultValue;
}

// Load output JSON
console.log(`📂 Loading ${outputPath}...`);
const fullData = JSON.parse(fs.readFileSync(outputPath, "utf8"));

// Support both old format (array) and new format (object with files array)
const data = Array.isArray(fullData) ? fullData : (fullData.files || []);
const hasProjectMetaData = !Array.isArray(fullData) && fullData.projectMetaData;

// Metadata schema definitions
const METADATA_SCHEMA = {
  backend: {
    Service: ["domain", "responsibility", "usedBy", "stateless"],
    Controller: ["framework", "basePath", "routes", "authRequired", "version"],
    Repository: ["entity", "dbType", "operations", "transactional"],
    DTO: ["fields", "usedIn", "validationRules"],
    Entity: ["tableName", "fields", "primaryKey", "relations"],
    API: ["httpMethod", "path", "requestDTO", "responseDTO", "statusCodes"]
  },
  frontend: {
    Component: ["props", "stateUsed", "children", "hooksUsed"],
    Page: ["route", "layout", "seo", "protected"],
    Hook: ["returns", "sideEffects", "dependencies"],
    Store: ["storeType", "stateShape", "actions", "persistence"],
    EventEmitter: ["eventType", "target", "sideEffects"]
  },
  crossCutting: {
    Utility: ["pure", "category", "reusedBy"],
    Constants: ["values", "scope"],
    Types: ["typeKind", "usedBy"],
    Error: ["errorCode", "httpStatus", "recoverable"],
    Test: ["testType", "covers", "mockedDependencies"]
  }
};

// LLM API callers
async function callLLM(prompt) {
  switch (config.provider) {
    case "openai":
      return await callOpenAI(prompt);
    case "claude":
      return await callClaude(prompt);
    case "gemini":
      return await callGemini(prompt);
    case "bedrock":
      return await callBedrock(prompt);
    case "custom":
      return await callCustom(prompt);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

async function callOpenAI(prompt) {
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    response_format: { type: "json_object" }
  });

  return await makeRequest({
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    }
  }, body);
}

async function callClaude(prompt) {
  const body = JSON.stringify({
    model: config.model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }]
  });

  return await makeRequest({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    }
  }, body);
}

async function callGemini(prompt) {
  const body = JSON.stringify({
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  });

  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`);
  url.searchParams.append("key", config.apiKey);

  return await makeRequest({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  }, body);
}

async function callCustom(prompt) {
  const url = new URL(config.apiUrl || "http://localhost:11434/v1/chat/completions");

  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    format: "json"
  });

  return await makeRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {})
    }
  }, body);
}

async function callBedrock(prompt) {
  const region = config.awsRegion;
  const modelId = config.model;
  const accessKey = config.awsAccessKey;
  const secretKey = config.awsSecretKey;

  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/invoke`;

  // Build request body based on model type
  let body;
  if (modelId.startsWith("anthropic.")) {
    body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });
  } else if (modelId.startsWith("amazon.titan")) {
    body = JSON.stringify({
      inputText: prompt,
      textGenerationConfig: {
        maxTokenCount: 4096,
        temperature: 0.1,
      },
    });
  } else if (modelId.startsWith("meta.llama")) {
    body = JSON.stringify({
      prompt: prompt,
      max_gen_len: 4096,
      temperature: 0.1,
    });
  } else if (modelId.startsWith("mistral.")) {
    body = JSON.stringify({
      prompt: `<s>[INST] ${prompt} [/INST]`,
      max_tokens: 4096,
      temperature: 0.1,
    });
  } else {
    // Default to Anthropic format
    body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });
  }

  // AWS Signature Version 4 signing
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = datetime.substring(0, 8);
  const service = "bedrock";
  const method = "POST";

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
  return await makeBedrockRequest(host, path, headers, body, modelId);
}

async function makeBedrockRequest(host, path, headers, body, modelId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: path,
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

          // Parse response based on model type
          let content;
          if (modelId.startsWith("anthropic.")) {
            content = parsed.content[0].text;
          } else if (modelId.startsWith("amazon.titan")) {
            content = parsed.results[0].outputText;
          } else if (modelId.startsWith("meta.llama")) {
            content = parsed.generation;
          } else if (modelId.startsWith("mistral.")) {
            content = parsed.outputs[0].text;
          } else {
            // Default to Anthropic format
            content = parsed.content[0].text;
          }

          resolve(content);
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

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === "http:" ? http : https;

    const req = protocol.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const statusCode = res.statusCode;
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

          // Extract content based on provider
          let content;
          if (parsed.choices && parsed.choices[0]) {
            // OpenAI/Custom format
            content = parsed.choices[0].message.content;
          } else if (parsed.content && parsed.content[0]) {
            // Claude format
            content = parsed.content[0].text;
          } else if (parsed.candidates && parsed.candidates[0]) {
            // Gemini format
            content = parsed.candidates[0].content.parts[0].text;
          } else {
            reject(new Error("Unexpected response format"));
            return;
          }

          resolve(content);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
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

// Generate metadata prompt
function generatePrompt(node, nodeType, codeContent = null) {
  const allRoles = [
    ...Object.keys(METADATA_SCHEMA.backend),
    ...Object.keys(METADATA_SCHEMA.frontend),
    ...Object.keys(METADATA_SCHEMA.crossCutting)
  ];

  let prompt = `Analyze this ${nodeType} and provide metadata in JSON format.

${nodeType.toUpperCase()} DATA:
${JSON.stringify(node, null, 2)}
`;

  if (codeContent && config.mode === "high") {
    prompt += `\nSOURCE CODE:
\`\`\`
${codeContent}
\`\`\`
`;
  }

  prompt += `\n
TASK: Identify the roles and metadata for this ${nodeType}.

AVAILABLE ROLES: ${allRoles.join(", ")}

METADATA SCHEMA:
${JSON.stringify(METADATA_SCHEMA, null, 2)}

INSTRUCTIONS:
1. A ${nodeType} can have MULTIPLE roles (e.g., both "Service" and "API")
2. For each identified role, provide the relevant metadata fields
3. Only include metadata that you can confidently determine
4. Use null for unknown values
5. For arrays, provide empty array [] if none found

REQUIRED OUTPUT FORMAT (strict JSON):
{
  "roles": ["Role1", "Role2"],
  "metadata": {
    "Role1": {
      "field1": "value1",
      "field2": ["value2a", "value2b"]
    },
    "Role2": {
      "field1": "value1"
    }
  }
}

Respond with ONLY the JSON object, no explanation.`;

  return prompt;
}

// Read code from file
function readCode(filePath, startLine, endLine) {
  try {
    const fullPath = path.join(repoPath, filePath);
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  } catch (err) {
    console.error(`Warning: Could not read code from ${filePath}`);
    return null;
  }
}

// Check if node already has metadata
function hasExistingMetadata(node) {
  return node.roles && Array.isArray(node.roles) && node.roles.length > 0 &&
         node.metadata && Object.keys(node.metadata).length > 0;
}

// Process a single node
async function processNode(node, nodeType, filePath) {
  // Skip if already has metadata
  if (hasExistingMetadata(node)) {
    console.log(`    ⏭️  Already has metadata: ${node.name || node.path || nodeType}`);
    return { success: true, skipped: true, error: null };
  }

  let codeContent = null;

  if (config.mode === "high" && node.startLine && node.endLine) {
    codeContent = readCode(filePath, node.startLine, node.endLine);
  }

  const prompt = generatePrompt(node, nodeType, codeContent);
  const response = await callLLM(prompt);

  const metadata = JSON.parse(response);

  // Add metadata to node
  node.roles = metadata.roles || [];
  node.metadata = metadata.metadata || {};

  return { success: true, skipped: false, error: null };
}

// Main processing function
async function processData() {
  let totalProcessed = 0;
  let totalSkipped = 0;

  // Helper function to save progress
  const saveProgress = () => {
    const outputData = hasProjectMetaData
      ? { ...fullData, files: data }
      : data;
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  };

  // Helper function to exit with error
  const exitWithError = (error, context) => {
    saveProgress();
    console.error(`\n❌ Error processing ${context}:`, error.message || error);
    console.log(`\n⚠️  Stopping due to error. Progress has been saved.`);
    console.log(`   Total nodes processed: ${totalProcessed}`);
    console.log(`   Total skipped: ${totalSkipped}`);
    console.log(`\n📝 Updated file: ${outputPath}`);
    process.exit(1);
  };

  for (let i = 0; i < data.length; i++) {
    const fileEntry = data[i];
    const filePath = fileEntry.path;

    console.log(`\n[${i + 1}/${data.length}] Processing: ${filePath}`);

    // Process file-level metadata
    if (config.nodeTypes.includes("file")) {
      console.log("  📄 Analyzing file...");
      try {
        const result = await processNode(fileEntry, "file", filePath);
        if (result.skipped) {
          totalSkipped++;
        } else {
          totalProcessed++;
          // Save after each successful node
          saveProgress();
          console.log(`  💾 Progress saved`);
        }
      } catch (error) {
        exitWithError(error, `file ${filePath}`);
      }
    }

    // Process classes
    if (config.nodeTypes.includes("class") && fileEntry.classes) {
      console.log(`  📦 Analyzing ${fileEntry.classes.length} classes...`);

      for (const classNode of fileEntry.classes) {
        try {
          const result = await processNode(classNode, "class", filePath);
          if (result.skipped) {
            totalSkipped++;
          } else {
            totalProcessed++;
            // Save after each successful node
            saveProgress();
            console.log(`    💾 Progress saved`);
          }
        } catch (error) {
          exitWithError(error, `class ${classNode.name} in ${filePath}`);
        }
      }
    }

    // Process functions
    if (config.nodeTypes.includes("function") && fileEntry.functions) {
      console.log(`  ⚡ Analyzing ${fileEntry.functions.length} functions...`);

      for (const funcNode of fileEntry.functions) {
        try {
          const result = await processNode(funcNode, "function", filePath);
          if (result.skipped) {
            totalSkipped++;
          } else {
            totalProcessed++;
            // Save after each successful node
            saveProgress();
            console.log(`    💾 Progress saved`);
          }
        } catch (error) {
          exitWithError(error, `function ${funcNode.name} in ${filePath}`);
        }
      }
    }
  }

  // Final save
  saveProgress();

  console.log(`\n✅ Complete!`);
  console.log(`   Total nodes processed: ${totalProcessed}`);
  console.log(`   Total skipped: ${totalSkipped}`);
  console.log(`\n📝 Updated file: ${outputPath}`);
}

// Run
(async () => {
  console.log("\n🚀 Starting metadata generation...");
  console.log(`   Provider: ${config.provider}`);
  console.log(`   Model: ${config.model}`);
  console.log(`   Mode: ${config.mode} accuracy`);
  console.log(`   Node types: ${config.nodeTypes.join(", ")}`);
  console.log(`   Max concurrent: ${config.maxConcurrent}`);

  await processData();
})();
