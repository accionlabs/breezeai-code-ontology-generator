#!/usr/bin/env node
/**
 * TypeScript Import Analyzer
 * Usage: node file-tree-mapper-typescript.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-typescript");
const { extractClasses } = require("./extract-classes-typescript");

if (process.argv.length < 4) {
  console.error(
    "Usage: node file-tree-mapper-typescript.js <repoPath> <importsOutput.json>"
  );
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const importsOutput = path.resolve(process.argv[3]);

// -------------------------------------------------------------
// Get TypeScript files
// -------------------------------------------------------------
function getTsFiles() {
  return glob.sync(`${repoPath}/**/*.{ts,tsx}`, {
    ignore: [
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`
    ]
  });
}

// -------------------------------------------------------------
// Analyze files with functions and classes
// -------------------------------------------------------------
function analyzeFiles() {
  const tsFiles = getTsFiles();
  const results = [];
  const totalFiles = tsFiles.length;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < tsFiles.length; i++) {
    const file = tsFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const imports = extractImports(file);
      const importFiles = [];
      const externalImports = [];

      // Resolve imports
      imports.forEach(imp => {
        const importSource = imp.source;

        if (importSource.startsWith(".")) {
          let resolvedPath = path.resolve(path.dirname(file), importSource);

          if (!path.extname(resolvedPath)) {
            if (fs.existsSync(resolvedPath + ".ts")) resolvedPath += ".ts";
            else if (fs.existsSync(resolvedPath + ".tsx")) resolvedPath += ".tsx";
            else if (fs.existsSync(resolvedPath + ".js")) resolvedPath += ".js";
          }

          if (fs.existsSync(resolvedPath)) {
            importFiles.push(path.relative(repoPath, resolvedPath));
          }
        } else {
          externalImports.push(importSource);
        }
      });

      // Extract functions and classes
      const functions = extractFunctionsAndCalls(file, repoPath);
      const classes = extractClasses(file, repoPath);

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions,
        classes
      });
    } catch (e) {
      process.stdout.write('\n');
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  }

  process.stdout.write('\r' + ' '.repeat(150) + '\r');
  console.log(`✅ Completed processing ${totalFiles} files\n`);

  return results;
}

// -------------------------------------------------------------
// MAIN
// -------------------------------------------------------------
(() => {
  console.log(`📂 Scanning TypeScript repo: ${repoPath}`);

  const analysis = analyzeFiles();
  fs.writeFileSync(importsOutput, JSON.stringify(analysis, null, 2));
  console.log(`✅ Final output written → ${importsOutput}`);
})();
