#!/usr/bin/env node


const minimist = require("minimist");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = minimist(process.argv.slice(2), {
  alias: {
    l: "language",
    r: "repo",
    o: "out"
  },
  boolean: ["generate-descriptions", "add-metadata"],
  default: {
    "generate-descriptions": false,
    "add-metadata": false
  }
});

const allowedLanguages = ["perl", "javascript", "python", "java", "typescript", "golang"];

const language = (args.language || "").toLowerCase();
const repoPath = args.repo ? path.resolve(args.repo) : null;
const outputDir = args.out ? path.resolve(args.out) : null;

// ----------------------------
// Validate args
// ----------------------------
if (!language || !repoPath || !outputDir) {
  console.error(
    `Usage:\n` +
      `repo-to-json-tree --language <lang> --repo ./path/to/repo --out ./output [options]\n\n` +
      `Supported Languages:\n` +
      `  javascript          - Parse JavaScript files (.js, .jsx)\n` +
      `  typescript          - Parse TypeScript AND JavaScript files (.ts, .tsx, .js, .jsx)\n` +
      `  python              - Parse Python files (.py)\n` +
      `  java                - Parse Java files (.java)\n` +
      `  golang              - Parse Go files (.go) + proto, yaml, html, dockerfiles\n\n` +
      `Options:\n` +
      `  --generate-descriptions     Generate AI descriptions for files, classes, and functions\n` +
      `  --add-metadata             Add metadata using LLM analysis\n` +
      `  --provider <name>          LLM provider: openai, claude, gemini, custom (default: openai)\n` +
      `  --api-key <key>            API key for LLM provider\n` +
      `  --model <name>             Model name (optional)\n` +
      `  --api-url <url>            Custom API URL (for custom provider)\n` +
      `  --mode <low|high>          Accuracy mode for metadata (default: low)\n` +
      `  --max-concurrent <num>     Max concurrent API requests (default: 5 for descriptions, 3 for metadata)\n`
  );
  process.exit(1);
}

if (!allowedLanguages.includes(language)) {
  console.error(`❌ Invalid language. Allowed: ${allowedLanguages.join(", ")}`);
  process.exit(1);
}

if (!fs.existsSync(repoPath)) {
  console.error(`❌ Repo path does not exist: ${repoPath}`);
  process.exit(1);
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const importsOutput = path.join(outputDir, `${language}-imports.json`);

const scriptMap = {
  perl: "file-tree-mapper.js",
  javascript: "nodejs/file-tree-mapper-nodejs.js",
  python: "python/file-tree-mapper-python.js",
  java: "java/file-tree-main-java.js",
  typescript: "typescript/file-tree-mapper-typescript.js",
  golang: "golang-analysis/file-tree-mapper-complete.js",
};

// Inform user about TypeScript's JavaScript support
if (language === "typescript") {
  console.log("\n📝 Note: TypeScript mode will also parse JavaScript files (.js, .jsx)");
}

// Inform user about Golang's comprehensive coverage
if (language === "golang") {
  console.log("\n📝 Note: Golang mode parses .go, .proto, .yaml, .html, Dockerfile, and go.mod files");
}

try {
  const scriptPath = path.resolve(__dirname, scriptMap[language]);

  const command = `node "${scriptPath}" "${repoPath}" "${importsOutput}"`;

  console.log("\n🚀 Running command:");
  console.log(command);

  execSync(command, { stdio: "inherit" });

  console.log("✅ JSON tree generation finished!");
  console.log("📄 Output:", importsOutput);

  // Step 2: Generate descriptions if requested
  if (args["generate-descriptions"]) {
    console.log("\n🤖 Generating descriptions...");

    if (!args["api-key"]) {
      console.error("❌ Error: --api-key is required for --generate-descriptions");
      process.exit(1);
    }

    const descScriptPath = path.resolve(__dirname, "generate-file-descriptions.js");
    let descCommand = `node "${descScriptPath}" "${repoPath}" "${importsOutput}"`;

    descCommand += ` --provider ${args.provider || "openai"}`;
    descCommand += ` --api-key ${args["api-key"]}`;

    if (args.model) descCommand += ` --model ${args.model}`;
    if (args["api-url"]) descCommand += ` --api-url ${args["api-url"]}`;
    if (args["max-concurrent"]) descCommand += ` --max-concurrent ${args["max-concurrent"]}`;

    console.log("Running:", descCommand);
    execSync(descCommand, { stdio: "inherit" });
    console.log("✅ Descriptions generated!");
  }

  // Step 3: Add metadata if requested
  if (args["add-metadata"]) {
    console.log("\n🏷️  Adding metadata...");

    if (!args["api-key"]) {
      console.error("❌ Error: --api-key is required for --add-metadata");
      process.exit(1);
    }

    const metadataScriptPath = path.resolve(__dirname, "add-metadata.js");
    let metadataCommand = `node "${metadataScriptPath}" "${importsOutput}" "${repoPath}"`;

    metadataCommand += ` --provider ${args.provider || "openai"}`;
    metadataCommand += ` --api-key ${args["api-key"]}`;

    if (args.model) metadataCommand += ` --model ${args.model}`;
    if (args["api-url"]) metadataCommand += ` --api-url ${args["api-url"]}`;
    if (args.mode) metadataCommand += ` --mode ${args.mode}`;
    if (args["max-concurrent"]) metadataCommand += ` --max-concurrent ${args["max-concurrent"]}`;

    console.log("Running:", metadataCommand);
    execSync(metadataCommand, { stdio: "inherit" });
    console.log("✅ Metadata added!");
  }

  console.log("\n🎉 All tasks completed successfully!");
  console.log("📄 Final output:", importsOutput);
} catch (err) {
  console.error("❌ Failed:", err.message);
  process.exit(1);
}
