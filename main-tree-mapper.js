#!/usr/bin/env node

/**
 * Main Tree Mapper Dispatcher
 * Usage:
 *   node main-tree-mapper.js <language> <repoPath> <outputDir>
 *
 * It will create:
 *   <outputDir>/<language>-mapper.json
 *   <outputDir>/<language>-imports.json
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// -------------------------------------
// Allowed languages
// -------------------------------------
const allowedLanguages = ["perl", "javascript"];

// -------------------------------------
// Validate input
// -------------------------------------
if (process.argv.length < 5) {
  console.error(
    "Usage: node main-tree-mapper.js <language> <repoPath> <outputDir>"
  );
  process.exit(1);
}

const language = process.argv[2].toLowerCase();
const repoPath = path.resolve(process.argv[3]);
const outputDir = path.resolve(process.argv[4]);

if (!allowedLanguages.includes(language)) {
  console.error(
    `❌ Invalid language. Allowed: ${allowedLanguages.join(", ")}`
  );
  process.exit(1);
}

if (!fs.existsSync(repoPath)) {
  console.error(`❌ Repo path does not exist: ${repoPath}`);
  process.exit(1);
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Output files follow SAME pattern you already use
const mapperOutput = path.join(outputDir, `${language}-mapper.json`);
const importsOutput = path.join(outputDir, `${language}-imports.json`);

// -------------------------------------
// Script mapping
// -------------------------------------
const scriptMap = {
  perl: "file-tree-mapper.js",
  javascript: "file-tree-mapper-nodejs.js",
};

// -------------------------------------
// Build execution command
// -------------------------------------
try {
  const scriptPath = path.resolve(__dirname, scriptMap[language]);

  let command = "";

  if (language === "perl") {
    // Perl script expects: <repoPath> <importsOutput>
    command = `node "${scriptPath}" "${repoPath}" "${importsOutput}"`;
  }

  if (language === "javascript") {
    // JS script expects: <repoPath> <mapperOutput> <importsOutput>
    command = `node "${scriptPath}" "${repoPath}" "${mapperOutput}" "${importsOutput}"`;
  }

  console.log("🚀 Running command:");
  console.log(command);

  execSync(command, { stdio: "inherit" });

  console.log("✅ Finished!");
  console.log("📄 Mapper:", mapperOutput);
  console.log("📄 Imports:", importsOutput);
} catch (err) {
  console.error("❌ Failed:", err.message);
  process.exit(1);
}
