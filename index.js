#!/usr/bin/env node


const minimist = require("minimist");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { autoDetectAndProcess, generateDescriptions, addMetadata } = require("./main");

const args = minimist(process.argv.slice(2), {
  alias: {
    l: "language",
    r: "repo",
    o: "out"
  },
  boolean: ["generate-descriptions", "add-metadata", "verbose"],
  default: {
    "generate-descriptions": false,
    "add-metadata": false,
    "verbose": false
  }
});

const allowedLanguages = ["perl", "javascript", "python", "java", "typescript"];

const language = (args.language || "").toLowerCase();
const repoPath = args.repo ? path.resolve(args.repo) : null;
const outputDir = args.out ? path.resolve(args.out) : null;

// ----------------------------
// Validate args
// ----------------------------
if (!repoPath || !outputDir) {
  console.error(
    `Usage:\n` +
      `repo-to-json-tree --repo ./path/to/repo --out ./output [options]\n\n` +
      `Auto-detect mode (recommended):\n` +
      `  repo-to-json-tree --repo ./path/to/repo --out ./output\n` +
      `  (Automatically detects all languages and generates merged output)\n\n` +
      `Manual language mode:\n` +
      `  repo-to-json-tree --language javascript --repo ./path/to/repo --out ./output\n\n` +
      `Options:\n` +
      `  --language <name>          Language to analyze: perl, javascript, python, java, typescript (optional)\n` +
      `  --generate-descriptions     Generate AI descriptions for files, classes, and functions\n` +
      `  --add-metadata             Add metadata using LLM analysis\n` +
      `  --provider <name>          LLM provider: openai, claude, gemini, custom (default: openai)\n` +
      `  --api-key <key>            API key for LLM provider\n` +
      `  --model <name>             Model name (optional)\n` +
      `  --api-url <url>            Custom API URL (for custom provider)\n` +
      `  --mode <low|high>          Accuracy mode for metadata (default: low)\n` +
      `  --max-concurrent <num>     Max concurrent API requests (default: 5 for descriptions, 3 for metadata)\n` +
      `  --verbose                  Show detailed processing information\n`
  );
  process.exit(1);
}

// If no language specified, use auto-detect mode via main.js
if (!language) {
  console.log("🔍 No language specified - using auto-detect mode...\n");

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Call the auto-detect function from main.js (it's async now)
  autoDetectAndProcess(repoPath, outputDir, args)
    .then(result => {
      if (result.success) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch(err => {
      console.error("❌ Error:", err.message);
      process.exit(1);
    });

  // Return early to avoid executing the rest of the synchronous code
  return;
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
};

// Inform user about TypeScript's JavaScript support
if (language === "typescript") {
  console.log("\n📝 Note: TypeScript mode will also parse JavaScript files (.js, .jsx)");
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
    generateDescriptions(importsOutput, repoPath, args, args.verbose);
  }

  // Step 3: Add metadata if requested
  if (args["add-metadata"]) {
    addMetadata(importsOutput, repoPath, args, args.verbose);
  }

  console.log("\n🎉 All tasks completed successfully!");
  console.log("📄 Final output:", importsOutput);
} catch (err) {
  console.error("❌ Failed:", err.message);
  process.exit(1);
}
