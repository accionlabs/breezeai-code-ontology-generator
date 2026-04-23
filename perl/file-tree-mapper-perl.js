#!/usr/bin/env node
/**
 * Perl Import Analyzer
 * Can be used as a CLI tool or imported as a module
 *
 * CLI Usage: node file-tree-mapper-perl.js <repoPath> <importsOutput.json>
 * Module Usage: const { analyzePerlRepo } = require('./file-tree-mapper-perl'); const data = analyzePerlRepo(repoPath);
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { getIgnorePatternsWithPrefix } = require("../ignore-patterns");
const { parseFile } = require("./parser");
const Parser = require("tree-sitter");

let Perl = null;
let parser = null;

async function getParser() {
  if (!Perl) {
    Perl = (await import("tree-sitter-perl")).default;
    parser = new Parser();
    parser.setLanguage(Perl);
  }
  return parser;
}

// -------------------------------------------------------------
// Get Perl files
// -------------------------------------------------------------
function getPerlFiles(repoPath, ignorePatterns = null) {
  const patterns =
    ignorePatterns ||
    getIgnorePatternsWithPrefix(repoPath, { language: "perl" });
  return glob.sync(`${repoPath}/**/*.{pm,pl,t,pgsi}`, {
    ignore: patterns,
  });
}

// -------------------------------------------------------------
// Analyze files with functions and packages
// -------------------------------------------------------------
async function analyzeFiles(repoPath, opts = {}) {
  await getParser();
  const perlFiles = getPerlFiles(repoPath);
  const results = opts.onResult ? null : [];
  const totalFiles = perlFiles.length;

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < perlFiles.length; i++) {  
    const file = perlFiles[i];
    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(
        `\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, " ")}`,
      );
      spinnerIndex++;

      const parseOut = parseFile(file, parser)
      if (opts.onResult) {
        opts.onResult(parseOut);
      } else {
        results.push(parseOut);
      }
    } catch (e) {
      process.stdout.write("\n");
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  };

  process.stdout.write("\r" + " ".repeat(150) + "\r");
  console.log(`✅ Completed processing ${totalFiles} files\n`);

  return results || [];
}

// -------------------------------------------------------------
// Main export function - to be called from main.js
// -------------------------------------------------------------
async function analyzePerlRepo(repoPath, opts = {}) {
  console.log(`📂 Scanning Perl repo: ${repoPath}`);

  const analysis = await analyzeFiles(repoPath, opts);

  if (!opts.onResult) {
    console.log(`\n📊 Summary:`);
    console.log(`   Perl files: ${analysis.length}`);
  }

  return analysis;
}

// Export the main function
module.exports = { analyzePerlRepo };

// -------------------------------------------------------------
// CLI mode - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node perl/file-tree-mapper-perl.js <repoPath> <importsOutput.json>",
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);
  const captureSourceCode = process.argv.includes("--capture-source-code");
  const captureStatements = process.argv.includes("--capture-statements");

  analyzePerlRepo(repoPath, { captureSourceCode, captureStatements })
    .then((results) => {
      fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
      console.log(`✅ Final output written → ${importsOutput}`);
    })
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
