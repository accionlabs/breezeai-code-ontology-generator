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
const { extractFunctionsAndCalls, extractImports, extractFileStatements } = require("./extract-functions-python");
const { extractClasses } = require("./extract-classes-python");
const { extractFileRoutes } = require("./extract-routes-python");
const { getIgnorePatternsWithPrefix } = require("../ignore-patterns");

// -------------------------------------------------------------
// Get Python files
// -------------------------------------------------------------
function getPythonFiles(repoPath, ignorePatterns = null) {
  const patterns = ignorePatterns || getIgnorePatternsWithPrefix(repoPath, { language: 'python' });
  return glob.sync(`${repoPath}/**/*.py`, {
    ignore: patterns
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

/**
 * Resolve an ABSOLUTE intra-repo import (e.g. `app.core.config`,
 * `app.api.routes`) to the repo-relative file paths it points at.
 *
 * Python absolute imports don't start with "." so resolveImportPath() skips
 * them and they used to be classified as external — leaving Python files with
 * no File→File IMPORTS edges. We map the dotted module to a path and look it up
 * against the actual set of repo files:
 *   - `a.b.c`            → a/b/c.py  or  a/b/c/__init__.py   (module / package)
 *   - `from a.b import c`→ a/b/c.py  or  a/b/c/__init__.py   (c is a submodule)
 * `importedNames` lets us catch the common `from pkg import submodule` form.
 *
 * `fileSet` is the set of repo-relative ("/"-separated) paths of every .py file.
 * Exact lookup covers the root-package layout (this repo: `app/` at root);
 * a boundary-aware suffix match handles repos nested under a source root
 * (e.g. file `src/app/core/config.py` for import `app.core.config`).
 */
function resolveAbsoluteImport(moduleSource, importedNames, fileSet) {
  const base = moduleSource.split(".").filter(Boolean).join("/");
  if (!base) return [];

  const candidates = [`${base}.py`, `${base}/__init__.py`];
  (importedNames || []).forEach(name => {
    candidates.push(`${base}/${name}.py`, `${base}/${name}/__init__.py`);
  });

  const resolved = new Set();
  for (const cand of candidates) {
    if (fileSet.has(cand)) {
      resolved.add(cand);
      continue;
    }
    // Suffix fallback for source-root prefixes (src/, backend/, ...).
    for (const f of fileSet) {
      if (f.endsWith("/" + cand)) {
        resolved.add(f);
        break;
      }
    }
  }
  return [...resolved];
}

// -------------------------------------------------------------
// Analyze files with functions and classes
// -------------------------------------------------------------
function analyzeFiles(repoPath, opts = {}) {
  const pyFiles = getPythonFiles(repoPath);
  const results = opts.onResult ? null : [];
  const totalFiles = pyFiles.length;

  // Index of every repo file (repo-relative, "/"-separated) so absolute
  // intra-repo imports can be resolved to File→File IMPORTS edges.
  const fileSet = new Set(
    pyFiles.map(f => path.relative(repoPath, f).split(path.sep).join("/"))
  );

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
          // Absolute import: resolve against the repo first; only treat as an
          // external package if it doesn't map to a file inside the repo.
          const resolved = resolveAbsoluteImport(importSource, imp.imported, fileSet);
          if (resolved.length) {
            importFiles.push(...resolved);
          } else {
            externalImports.push(importSource);
          }
        }
      });

      // Extract functions and classes
      const functions = extractFunctionsAndCalls(file, repoPath, null, opts.captureSourceCode, opts.captureStatements);
      const classes = extractClasses(file, repoPath, opts.captureStatements);

      const statements = opts.captureStatements ? extractFileStatements(file) : [];

      // Detect web-framework routes (Django / Flask / FastAPI) and surface
      // them as `route` statements flowing through the HAS_STATEMENT pipeline.
      //   - Flask/FastAPI decorator routes (scope "function") attach to their
      //     handler Function node, mirroring the JS `api_call` convention.
      //   - Django urls.py routes, mounts and includes (scope "file") attach
      //     to the File node, since their views are referenced by name.
      const routes = opts.captureStatements ? extractFileRoutes(file) : [];
      if (routes.length) {
        routes.forEach(rt => {
          if (rt.scope === "function") {
            const fn = functions.find(
              f => f.name === rt.handler && f.startLine === rt.handlerLine
            );
            if (fn) {
              (fn.statements || (fn.statements = [])).push(rt);
              return;
            }
          }
          statements.push(rt); // file-level (Django) or unmatched fallback
        });
      }

      const fileResult = {
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions,
        classes,
        statements,
        routes
      };
      if (opts.onResult) {
        opts.onResult(fileResult);
      } else {
        results.push(fileResult);
      }
    } catch (e) {
      process.stdout.write('\n');
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  }

  process.stdout.write('\r' + ' '.repeat(150) + '\r');
  console.log(`✅ Completed processing ${totalFiles} files\n`);

  return results || [];
}

// -------------------------------------------------------------
// Main export function - to be called from main.js
// -------------------------------------------------------------
function analyzePythonRepo(repoPath, opts = {}) {
  console.log(`📂 Scanning Python repo: ${repoPath}`);

  const analysis = analyzeFiles(repoPath, opts);

  if (!opts.onResult) {
    console.log(`\n📊 Summary:`);
    console.log(`   Python files: ${analysis.length}`);
  }

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
  const captureSourceCode = process.argv.includes("--capture-source-code");
  const captureStatements = process.argv.includes("--capture-statements");

  const results = analyzePythonRepo(repoPath, { captureSourceCode, captureStatements });

  // Write results to file
  fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
  console.log(`✅ Final output written → ${importsOutput}`);
}

