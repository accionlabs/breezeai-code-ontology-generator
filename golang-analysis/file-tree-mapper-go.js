#!/usr/bin/env node
/**
 * Golang Project Analyzer using tree-sitter-go
 * Usage: node file-tree-mapper-go.js <repoPath> <outputJson>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractGoFile } = require("./extract-go-file");

if (process.argv.length < 4) {
  console.error("Usage: node file-tree-mapper-go.js <repoPath> <outputJson>");
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);

console.log(`\n${"=".repeat(80)}`);
console.log(`🐹 Golang Project Analyzer (Tree-Sitter)`);
console.log(`${"=".repeat(80)}\n`);
console.log(`📂 Scanning: ${repoPath}\n`);

// Find all Go files
const goFiles = glob.sync(`${repoPath}/**/*.go`, {
  ignore: [
    `${repoPath}/**/node_modules/**`,
    `${repoPath}/**/vendor/**`,
    `${repoPath}/**/*_test.go`, // Skip test files for now
    `${repoPath}/**/testdata/**`
  ]
});

console.log(`📊 Found ${goFiles.length} Go files\n`);
console.log(`🔍 Starting analysis...\n`);

const results = [];
let processed = 0;
let errors = 0;

for (const file of goFiles) {
  processed++;
  const percentage = ((processed / goFiles.length) * 100).toFixed(1);
  
  process.stdout.write(`\r🔄 Processing: ${processed}/${goFiles.length} (${percentage}%) - ${path.basename(file)}`);
  
  try {
    const fileData = extractGoFile(file, repoPath);
    results.push(fileData);
  } catch (error) {
    errors++;
    console.error(`\n❌ Error parsing ${file}: ${error.message}`);
  }
}

console.log(`\n\n${"=".repeat(80)}`);
console.log(`✅ Analysis Complete`);
console.log(`${"=".repeat(80)}\n`);

// Generate statistics
const stats = {
  totalFiles: results.length,
  totalPackages: new Set(results.map(r => r.package)).size,
  totalStructs: results.reduce((sum, r) => sum + r.structs.length, 0),
  totalInterfaces: results.reduce((sum, r) => sum + r.interfaces.length, 0),
  totalFunctions: results.reduce((sum, r) => sum + r.functions.length, 0),
  errors: errors
};

console.log(`📊 Statistics:`);
console.log(`   Files processed:    ${stats.totalFiles}`);
console.log(`   Unique packages:    ${stats.totalPackages}`);
console.log(`   Structs found:      ${stats.totalStructs}`);
console.log(`   Interfaces found:   ${stats.totalInterfaces}`);
console.log(`   Functions/Methods:  ${stats.totalFunctions}`);
console.log(`   Errors:             ${stats.errors}`);
console.log(`${"─".repeat(80)}\n`);

// Write results to JSON
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`📄 Output written to: ${outputPath}`);

// Write stats file
const statsPath = outputPath.replace('.json', '-stats.json');
fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
console.log(`📊 Statistics written to: ${statsPath}\n`);
