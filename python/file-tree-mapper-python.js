#!/usr/bin/env node
/**
 * Python Import Analyzer
 * Can be used as a CLI tool or imported as a module
 *
 * CLI Usage: node file-tree-mapper-python.js <repoPath> <importsOutput.json>
 * Module Usage: const { analyzePythonRepo } = require('./file-tree-mapper-python'); const data = analyzePythonRepo(repoPath);
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-python");
const { extractClasses } = require("./extract-classes-python");

// -------------------------------------------------------------
// Get Python files
// -------------------------------------------------------------
function getPythonFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.py`, {
    ignore: [
      `${repoPath}/**/venv/**`,
      `${repoPath}/**/.venv/**`,
      `${repoPath}/**/env/**`,
      `${repoPath}/**/__pycache__/**`,
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`,
      `${repoPath}/**/.eggs/**`,
      `${repoPath}/**/*.egg-info/**`
    ]
  });
}

// -------------------------------------------------------------
// Resolve Python import paths
// -------------------------------------------------------------
function resolveImportPath(importSource, currentFilePath, repoPath) {
  // External package (not relative)
  if (!importSource.startsWith(".")) {
    return null;
  }

  // Relative import
  const currentDir = path.dirname(currentFilePath);
  
  // Convert dots to path segments
  let relativePathParts = importSource.split(".");
  let levelsUp = 0;
  
  // Count leading dots for relative imports
  while (relativePathParts[0] === "") {
    levelsUp++;
    relativePathParts.shift();
  }
  
  // Start from current directory or go up directories
  let targetDir = currentDir;
  for (let i = 0; i < levelsUp - 1; i++) {
    targetDir = path.dirname(targetDir);
  }
  
  // Build the potential file path
  const modulePath = relativePathParts.join("/");
  let resolvedPath = path.resolve(targetDir, modulePath);
  
  // Try as a .py file
  if (fs.existsSync(resolvedPath + ".py")) {
    return path.relative(repoPath, resolvedPath + ".py");
  }
  
  // Try as a directory with __init__.py
  if (fs.existsSync(path.join(resolvedPath, "__init__.py"))) {
    return path.relative(repoPath, path.join(resolvedPath, "__init__.py"));
  }
  
  return null;
}

// -------------------------------------------------------------
// Analyze files with functions and classes
// -------------------------------------------------------------
function analyzeFiles(repoPath) {
  const pyFiles = getPythonFiles(repoPath);
  const results = [];
  const totalFiles = pyFiles.length;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < pyFiles.length; i++) {
    const file = pyFiles[i];

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
          // Relative import
          const resolvedPath = resolveImportPath(importSource, file, repoPath);
          if (resolvedPath) {
            importFiles.push(resolvedPath);
          }
        } else if (importSource) {
          // External/absolute import
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
// Main export function - to be called from main.js
// -------------------------------------------------------------
function analyzePythonRepo(repoPath) {
  console.log(`📂 Scanning Python repo: ${repoPath}`);

  const analysis = analyzeFiles(repoPath);

  console.log(`\n📊 Summary:`);
  console.log(`   Python files: ${analysis.length}`);

  return analysis;
}

// Export the main function
module.exports = { analyzePythonRepo };

// -------------------------------------------------------------
// CLI mode - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node python/file-tree-mapper-python.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);

  const results = analyzePythonRepo(repoPath);

  // Write results to file
  fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
  console.log(`✅ Final output written → ${importsOutput}`);
}

