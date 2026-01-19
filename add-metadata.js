#!/usr/bin/env node
/**
 * Add metadata to output.json using LLM analysis
 *
 * Usage:
 *   node add-metadata.js <output.json> <repoPath> --provider <openai|claude|gemini|custom> --api-key <key> [options]
 *
 * Options:
 *   --mode <low|high>           Accuracy mode: low (JSON only) or high (with code) [default: low]
 *   --model <model-name>        Model to use
 *   --api-url <url>             Custom API endpoint URL
 *   --max-concurrent <n>        Max concurrent requests [default: 3]
 *   --node-types <types>        Comma-separated: file,class,function [default: all]
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

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
  mode: getArg("--mode", "low"), // low or high accuracy
  maxConcurrent: parseInt(getArg("--max-concurrent", "3")),
  nodeTypes: getArg("--node-types", "file,class,function").split(",")
};

// Set default models
if (!config.model) {
  const defaultModels = {
    openai: "gpt-4o-mini",
    claude: "claude-3-5-haiku-20241022",
    gemini: "gemini-2.0-flash-exp",
    custom: "llama3.2"
  };
  config.model = defaultModels[config.provider] || "gpt-4o-mini";
}

if (!config.apiKey && config.provider !== "custom") {
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

    req.on("error", reject);
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

// Process a single node
async function processNode(node, nodeType, filePath) {
  try {
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

    return true;
  } catch (err) {
    console.error(`Error processing ${nodeType}:`, err.message);
    node.roles = [];
    node.metadata = {};
    return false;
  }
}

// Concurrent processing with rate limiting
async function processConcurrently(items, processor) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = processor(item).then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= config.maxConcurrent) {
      await Promise.race(executing);
    }
  }

  return await Promise.all(results);
}

// Main processing function
async function processData() {
  let totalProcessed = 0;
  let totalSuccess = 0;

  for (let i = 0; i < data.length; i++) {
    const fileEntry = data[i];
    const filePath = fileEntry.path;

    console.log(`\n[${i + 1}/${data.length}] Processing: ${filePath}`);

    // Process file-level metadata
    if (config.nodeTypes.includes("file")) {
      console.log("  📄 Analyzing file...");
      const success = await processNode(fileEntry, "file", filePath);
      totalProcessed++;
      if (success) totalSuccess++;
    }

    // Process classes
    if (config.nodeTypes.includes("class") && fileEntry.classes) {
      console.log(`  📦 Analyzing ${fileEntry.classes.length} classes...`);

      await processConcurrently(fileEntry.classes, async (classNode) => {
        const success = await processNode(classNode, "class", filePath);
        totalProcessed++;
        if (success) totalSuccess++;
      });
    }

    // Process functions
    if (config.nodeTypes.includes("function") && fileEntry.functions) {
      console.log(`  ⚡ Analyzing ${fileEntry.functions.length} functions...`);

      await processConcurrently(fileEntry.functions, async (funcNode) => {
        const success = await processNode(funcNode, "function", filePath);
        totalProcessed++;
        if (success) totalSuccess++;
      });
    }

    // Save progress incrementally
    if ((i + 1) % 10 === 0) {
      const outputData = hasProjectMetaData
        ? { ...fullData, files: data }
        : data;
      fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
      console.log(`\n💾 Progress saved (${i + 1}/${data.length} files)`);
    }
  }

  // Final save
  const finalOutput = hasProjectMetaData
    ? { ...fullData, files: data }
    : data;
  fs.writeFileSync(outputPath, JSON.stringify(finalOutput, null, 2));

  console.log(`\n✅ Complete!`);
  console.log(`   Total nodes processed: ${totalProcessed}`);
  console.log(`   Successful: ${totalSuccess}`);
  console.log(`   Failed: ${totalProcessed - totalSuccess}`);
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
