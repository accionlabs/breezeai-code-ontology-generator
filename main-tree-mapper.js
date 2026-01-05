#!/usr/bin/env node

console.log("testing script *********************");

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
});

const allowedLanguages = ["perl", "javascript", "python"];

const language = (args.language || "").toLowerCase();
const repoPath = args.repo ? path.resolve(args.repo) : null;
const outputDir = args.out ? path.resolve(args.out) : null;

// ----------------------------
// Validate args
// ----------------------------
if (!language || !repoPath || !outputDir) {
  console.error(
    `Usage:\n` +
      `repo-to-json-tree --language perl --repo ./path/to/repo --out ./output\n`
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
};

try {
  const scriptPath = path.resolve(__dirname, scriptMap[language]);

  const command = `node "${scriptPath}" "${repoPath}" "${importsOutput}"`;

  console.log("🚀 Running command:");
  console.log(command);

  execSync(command, { stdio: "inherit" });

  console.log("✅ Finished!");
  console.log("📄 Imports:", importsOutput);
} catch (err) {
  console.error("❌ Failed:", err.message);
  process.exit(1);
}
