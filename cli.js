#!/usr/bin/env node

const { Command } = require("commander");

const program = new Command();

program
  .name("breeze-code-ontology-generator")
  .description("Breeze Code Ontology Generator - Analyze codebases and upload documents")
  .version("1.0.0");

// repo-to-json-tree command
program
  .command("repo-to-json-tree")
  .description("Analyze codebases and generate JSON ontology with AI-powered descriptions and metadata")
  .requiredOption("-r, --repo <path>", "Path to the repository to analyze")
  .requiredOption("-o, --out <path>", "Output directory for generated files")
  .option("-l, --language <name>", "Language to analyze: perl, javascript, python, java, typescript")
  .option("--generate-descriptions", "Generate AI descriptions for files, classes, and functions", false)
  .option("--add-metadata", "Add metadata using LLM analysis", false)
  .option("--provider <name>", "LLM provider: openai, claude, gemini, bedrock, custom (default: openai)")
  .option("--model <name>", "Model name")
  .option("--api-url <url>", "Custom API URL (for custom provider)")
  .option("--aws-region <region>", "AWS region for Bedrock (default: us-west-2)")
  .option("--aws-access-key <key>", "AWS access key ID for Bedrock")
  .option("--aws-secret-key <key>", "AWS secret access key for Bedrock")
  .option("--mode <low|high>", "Accuracy mode for metadata (default: low)")
  .option("--max-concurrent <num>", "Max concurrent API requests (default: 5 for descriptions, 3 for metadata)")
  .option("--verbose", "Show detailed processing information", false)
  .option("--user-api-key <key>", "API key for authentication")
  .option("--upload", "Upload generated files to the API after processing")
  .option("--baseurl <url>", "Base URL of the API (required with --upload)")
  .option("--uuid <uuid>", "UUID identifier (required with --upload)")
  .option("--llmPlatform <name>", "LLM platform for code ontology generation: OPENAI, AWSBEDROCK, GEMINI (default: AWSBEDROCK)")
  .action(async (opts) => {
    if (opts.llmPlatform) {
      const allowedPlatforms = ["OPENAI", "AWSBEDROCK", "GEMINI"];
      if (!allowedPlatforms.includes(opts.llmPlatform)) {
        console.error(`error: invalid --llmPlatform value '${opts.llmPlatform}'. Allowed: ${allowedPlatforms.join(", ")}`);
        process.exit(1);
      }
    }
    if (opts.upload) {
      const missing = [];
      if (!opts.baseurl) missing.push("--baseurl");
      if (!opts.uuid) missing.push("--uuid");
      if (!opts.userApiKey) missing.push("--user-api-key");
      if (missing.length > 0) {
        console.error(`error: missing required options when --upload is used: ${missing.join(", ")}`);
        process.exit(1);
      }
    }
    const { run } = require("./index");
    await run(opts);
  });

// upload-docs command
program
  .command("upload-docs")
  .description("Upload documents to the API. Accepts a single file or a directory.")
  .requiredOption("-k, --user-api-key <key>", "API key for authentication")
  .requiredOption("-u, --uuid <uuid>", "UUID identifier")
  .requiredOption("-b, --baseurl <url>", "Base URL of the API")
  .requiredOption("-p, --path <file-or-dir>", "File or directory to upload")
  .action(async (opts) => {
    const { run } = require("./upload-docs");
    await run(opts);
  });

program.parse();
