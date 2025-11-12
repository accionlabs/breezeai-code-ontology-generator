#!/usr/bin/env node
/**
 * File Description Generator
 * Generates AI-powered descriptions for each file in a repository
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

  async generateDescription(filePath, fileContent) {
    throw new Error("generateDescription must be implemented by subclass");
  }

  createPrompt(filePath, fileContent) {
    return `You are a code analyst. Analyze the following Perl file and provide ONLY a brief summary description (2-3 sentences maximum).
DO NOT return any code. DO NOT quote the code. ONLY provide a plain text description.
Describe what this file does, its main purpose, and key functionality.

File: ${filePath}

Code:
\`\`\`
${fileContent}
\`\`\`

Provide ONLY the description, no other text or formatting. The response must be strictly between 150–200 words.`;
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
  async generateDescription(filePath, fileContent) {
    const url = "https://api.openai.com/v1/chat/completions";
    const headers = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    const body = {
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: this.createPrompt(filePath, fileContent),
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    };

    const response = await this.makeRequest(url, headers, body);
    return response.choices[0].message.content.trim();
  }
}

class ClaudeProvider extends LLMProvider {
  async generateDescription(filePath, fileContent) {
    const url = "https://api.anthropic.com/v1/messages";
    const headers = {
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const body = {
      model: this.config.model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: this.createPrompt(filePath, fileContent),
        },
      ],
      temperature: 0.3,
    };

    const response = await this.makeRequest(url, headers, body);
    return response.content[0].text.trim();
  }
}

class GeminiProvider extends LLMProvider {
  async generateDescription(filePath, fileContent) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;
    const headers = {};
    const body = {
      contents: [
        {
          parts: [
            {
              text: this.createPrompt(filePath, fileContent),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 300,
      },
    };
    const response = await this.makeRequest(url, headers, body);
    return response.candidates[0]?.content?.parts?.[0]?.text?.trim();
  }
}

class CustomProvider extends LLMProvider {
  async generateDescription(filePath, fileContent) {
    const url = this.config.apiUrl;
    const headers = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    const body = {
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: this.createPrompt(filePath, fileContent),
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    };

    const response = await this.makeRequest(url, headers, body);
    // Try to handle both OpenAI-style and custom response formats
    if (response.choices && response.choices[0]) {
      return response.choices[0].message.content.trim();
    } else if (response.content) {
      return response.content.trim();
    } else if (response.text) {
      return response.text.trim();
    } else {
      throw new Error("Unexpected response format from custom API");
    }
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
  console.log(`📂 Scanning repository: ${config.repoPath}`);

  // Scan for Perl files (same pattern as file-tree-mapper.js)
  const perlFiles = glob.sync(`${config.repoPath}/**/*.{pm,pl}`, {
    ignore: ["**/build/**", "**/blib/**", "**/node_modules/**"],
  });

  console.log(`Found ${perlFiles.length} Perl files`);

  // Load existing tree JSON if it exists
  let fileTree = [];
  if (fs.existsSync(config.treeJsonFile)) {
    console.log(`📄 Loading existing tree: ${config.treeJsonFile}`);
    fileTree = JSON.parse(fs.readFileSync(config.treeJsonFile, "utf8"));
  }

  // Create a map of existing entries by path for easy lookup
  const existingEntriesMap = new Map();
  fileTree.forEach((entry) => {
    existingEntriesMap.set(entry.path, entry);
  });

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
      batch.map(async (fullPath) => {
        const relativePath = path.relative(config.repoPath, fullPath);
        const fileName = path.basename(fullPath);

        // Get existing entry or create new one
        let fileInfo = existingEntriesMap.get(relativePath) || {
          path: relativePath,
          name: fileName,
          loc: 0,
          importFiles: [],
          externalImports: [],
        };

        // Skip if description already exists
        if (fileInfo.description && !fileInfo.description.startsWith("[Error:") && !fileInfo.description.startsWith("[Skipped:")) {
          console.log(`⏭️  Already has description: ${relativePath}`);
          skipped++;
          return fileInfo;
        }

        try {
          // Check file size
          const stats = fs.statSync(fullPath);
          if (stats.size > maxFileSizeBytes) {
            console.log(`⏭️  Skipping large file: ${relativePath} (${Math.round(stats.size / 1024)}KB)`);
            skipped++;
            return {
              ...fileInfo,
              // description: `[Skipped: File too large (${Math.round(stats.size / 1024)}KB)]`,
            };
          }

          // Read file content
          const content = fs.readFileSync(fullPath, "utf8");

          // Generate description
          console.log(`🔍 Processing: ${relativePath}`);
          const description = await provider.generateDescription(relativePath, content);

          processed++;
          updated++;
          console.log(`✅ [${processed}/${batch.length}] ${relativePath}`);

          return {
            ...fileInfo,
            description: description,
          };
        } catch (error) {
          failed++;
          console.error(`❌ Error processing ${relativePath}: ${error.message}`);
          return {
            ...fileInfo,
            // description: `[Error: ${error.message}]`,
          };
        }
      })
    );
  };

  const results = [];

  // Process in batches to respect rate limits
  for (let i = 0; i < perlFiles.length; i += config.maxConcurrent) {
    const batch = perlFiles.slice(i, i + config.maxConcurrent);
    const batchResults = await processBatch(batch);
    results.push(...batchResults);

    // Save progress after each batch (incremental updates)
    fs.writeFileSync(config.treeJsonFile, JSON.stringify(results, null, 2));
    console.log(`💾 Progress saved (${results.length}/${perlFiles.length} files)`);

    // Small delay between batches to avoid rate limiting
    if (i + config.maxConcurrent < perlFiles.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n✨ Processing complete!`);
  console.log(`   Total files: ${perlFiles.length}`);
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
