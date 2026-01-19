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
  --provider <name>       LLM provider: openai, claude, gemini, custom (default: openai)
  --api-key <key>         API key for the LLM provider
  --model <name>          Model name (default varies by provider)
  --api-url <url>         Custom API URL (for custom provider)
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
    }
  }

  // Set default models based on provider
  if (!config.model) {
    const defaultModels = {
      openai: "gpt-4o-mini",
      claude: "claude-3-5-sonnet-20241022",
      gemini: "gemini-2.5-flash",
      custom: "custom-model",
    };
    config.model = defaultModels[config.provider] || "gpt-4o-mini";
  }

  // Validate required fields
  if (!config.apiKey) {
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse response: ${e.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
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

// Factory function to create the appropriate provider
function createProvider(config) {
  switch (config.provider.toLowerCase()) {
    case "openai":
      return new OpenAIProvider(config);
    case "claude":
      return new ClaudeProvider(config);
    case "gemini":
      return new GeminiProvider(config);
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

  // Process files with concurrency control
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let updated = 0;

  const processBatch = async (batch) => {
    return Promise.all(
      batch.map(async (fileEntry) => {
        const relativePath = fileEntry.path;
        const fullPath = path.join(config.repoPath, relativePath);

        // Skip if already has descriptions
        const hasFileDesc = fileEntry.description && !fileEntry.description.startsWith("[Error:");
        const allClassesHaveDesc = (fileEntry.classes || []).every(c => c.description);
        const allFunctionsHaveDesc = (fileEntry.functions || []).every(f => f.description);

        if (hasFileDesc && allClassesHaveDesc && allFunctionsHaveDesc) {
          console.log(`⏭️  Already complete: ${relativePath}`);
          skipped++;
          return fileEntry;
        }

        try {
          // Check if file exists
          if (!fs.existsSync(fullPath)) {
            console.log(`⚠️  File not found: ${relativePath}`);
            skipped++;
            return fileEntry;
          }

          // Check file size
          const stats = fs.statSync(fullPath);
          if (stats.size > maxFileSizeBytes) {
            console.log(`⏭️  Skipping large file: ${relativePath} (${Math.round(stats.size / 1024)}KB)`);
            skipped++;
            return fileEntry;
          }

          // Read file content
          const content = fs.readFileSync(fullPath, "utf8");

          // Generate descriptions
          console.log(`🔍 Processing: ${relativePath}`);
          const descriptions = await provider.generateDescriptions(relativePath, content, fileEntry);

          processed++;
          updated++;

          // Apply descriptions
          const updatedEntry = { ...fileEntry };

          // File description
          if (descriptions.file) {
            updatedEntry.description = descriptions.file;
          }

          // Class descriptions
          if (updatedEntry.classes && descriptions.classes) {
            updatedEntry.classes = updatedEntry.classes.map(cls => ({
              ...cls,
              description: descriptions.classes[cls.name] || cls.description
            }));
          }

          // Function descriptions
          if (updatedEntry.functions && descriptions.functions) {
            updatedEntry.functions = updatedEntry.functions.map(fn => ({
              ...fn,
              description: descriptions.functions[fn.name] || fn.description
            }));
          }

          console.log(`✅ [${processed}] ${relativePath}`);
          return updatedEntry;

        } catch (error) {
          failed++;
          console.error(`❌ Error processing ${relativePath}: ${error.message}`);
          return fileEntry;
        }
      })
    );
  };

  const results = [];

  // Process in batches to respect rate limits
  for (let i = 0; i < fileTree.length; i += config.maxConcurrent) {
    const batch = fileTree.slice(i, i + config.maxConcurrent);
    const batchResults = await processBatch(batch);
    results.push(...batchResults);

    // Save progress after each batch (incremental updates)
    const outputData = hasProjectMetaData
      ? { ...fullData, files: results }
      : results;
    fs.writeFileSync(config.treeJsonFile, JSON.stringify(outputData, null, 2));
    console.log(`💾 Progress saved (${results.length}/${fileTree.length} files)`);

    // Small delay between batches to avoid rate limiting
    if (i + config.maxConcurrent < fileTree.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n✨ Processing complete!`);
  console.log(`   Total files: ${fileTree.length}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Failed: ${failed}`);
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
