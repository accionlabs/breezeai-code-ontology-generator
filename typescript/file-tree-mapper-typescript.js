#!/usr/bin/env node
/**
 * TypeScript/JavaScript Import Analyzer
 * Analyzes both TypeScript (.ts, .tsx) and JavaScript (.js, .jsx) files
 * Usage: node file-tree-mapper-typescript.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractFunctionsAndCalls, extractImports: extractImportsTS } = require("./extract-functions-typescript");
const { extractClasses } = require("./extract-classes-typescript");

// Import JavaScript parsers for .js/.jsx files
const { extractFuncitonAndItsCalls: extractFunctionsJS } = require("../nodejs/extract-functions-nodejs");
const { extractClasses: extractClassesJS } = require("../nodejs/extract-classes-nodejs");
const { extractImports: extractImportsJS } = require("../nodejs/file-tree-mapper-nodejs");
const { loadPathAliases, resolveWithAlias } = require("./resolve-path-aliases");

if (process.argv.length < 4) {
  console.error(
    "Usage: node typescript/file-tree-mapper-typescript.js <repoPath> <importsOutput.json>"
  );
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const importsOutput = path.resolve(process.argv[3]);

// Load path aliases from tsconfig.json
const pathAliases = loadPathAliases(repoPath);

// -------------------------------------------------------------
// Get TypeScript files only
// -------------------------------------------------------------
function getTsFilesOnly() {
  return glob.sync(`${repoPath}/**/*.{ts,tsx}`, {
    ignore: [
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`
    ]
  });
}

// -------------------------------------------------------------
// Get JavaScript files only
// -------------------------------------------------------------
function getJsFilesOnly() {
  return glob.sync(`${repoPath}/**/*.{js,jsx}`, {
    ignore: [
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`
    ]
  });
}

// -------------------------------------------------------------
// Analyze TypeScript files (.ts, .tsx)
// -------------------------------------------------------------
function analyzeTypeScriptFiles() {
  const tsFiles = getTsFilesOnly();
  const results = [];
  const totalFiles = tsFiles.length;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 TypeScript files to process: ${totalFiles}\n`);

  for (let i = 0; i < tsFiles.length; i++) {
    const file = tsFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing TS: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const imports = extractImportsTS(file);
      const importFiles = [];
      const externalImports = [];

      // Resolve imports
      imports.forEach(imp => {
        const importSource = imp.source;
        let resolvedPath = null;
        let isResolved = false;

         // 1. Try path aliases first (e.g., @services/api.service)
        if (Object.keys(pathAliases).length > 0) {
          resolvedPath = resolveWithAlias(importSource, pathAliases, repoPath);
          if (resolvedPath) {
            importFiles.push(resolvedPath);
            isResolved = true;
            return;
          }
        }

        // Handle relative imports (./file or ../file)
        if (importSource.startsWith(".")) {
          resolvedPath = path.resolve(path.dirname(file), importSource);
        }
        // Handle absolute imports (/src/file or /lib/file)
        else if (importSource.startsWith("/")) {
          resolvedPath = path.join(repoPath, importSource);
        }
        // Try to resolve as a local module (might be a path alias or local module)
        else if (!importSource.startsWith('@')) {
          // Check if it's a local file path (not a package name)
          // Package names typically don't contain "/" or are scoped (@org/package)
          if (importSource.includes('/')) {
            // Try to resolve relative to repo root
            resolvedPath = path.join(repoPath, importSource);
          } else {
            // Could be a local file without path, try common patterns
            const possiblePaths = [
              path.join(repoPath, 'src', importSource),
              path.join(repoPath, 'lib', importSource),
              path.join(repoPath, importSource)
            ];

            for (const possiblePath of possiblePaths) {
              const testPath = tryResolveWithExtensions(possiblePath);
              if (testPath) {
                resolvedPath = testPath;
                break;
              }
            }
          }
        }

        // If we have a potential path, try to resolve it with extensions
        if (resolvedPath && !isResolved) {
          const finalPath = tryResolveWithExtensions(resolvedPath);

          if (finalPath && fs.existsSync(finalPath)) {
            const relativePath = path.relative(repoPath, finalPath);
            // Make sure it's within the repo (not outside)
            if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
              importFiles.push(relativePath);
              isResolved = true;
              return;
            }
          }
        }

        // If we couldn't resolve it as a local file, it's an external import
        if (!isResolved) {
          externalImports.push(importSource);
        }
      });

      // Helper function to try resolving a path with different extensions
      function tryResolveWithExtensions(basePath) {
        // If already has extension and exists, return it
        if (path.extname(basePath) && fs.existsSync(basePath)) {
          return basePath;
        }

        // Try with different extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx'];
        for (const ext of extensions) {
          const pathWithExt = basePath + ext;
          if (fs.existsSync(pathWithExt)) {
            return pathWithExt;
          }
        }

        // Try as directory with index file
        if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
          for (const ext of extensions) {
            const indexPath = path.join(basePath, 'index' + ext);
            if (fs.existsSync(indexPath)) {
              return indexPath;
            }
          }
        }

        // If no extension worked, return null
        return null;
      }

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
  console.log(`✅ Completed processing ${totalFiles} TypeScript files\n`);

  return results;
}

// -------------------------------------------------------------
// Analyze JavaScript files (.js, .jsx)
// -------------------------------------------------------------
function analyzeJavaScriptFiles() {
  const jsFiles = getJsFilesOnly();
  const results = [];
  const totalFiles = jsFiles.length;

  if (totalFiles === 0) {
    console.log(`\n📊 No JavaScript files found\n`);
    return results;
  }

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 JavaScript files to process: ${totalFiles}\n`);

  for (let i = 0; i < jsFiles.length; i++) {
    const file = jsFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing JS: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      // Extract imports using nodejs function (returns { imports: [], libPaths: [] })
      const { imports } = extractImportsJS(file);
      const importFiles = [];
      const externalImports = [];

      // Try resolve with extensions helper
      function tryResolveWithExtensions(basePath) {
        const extensions = ['.js', '.jsx', '.ts', '.tsx'];
        for (const ext of extensions) {
          const testPath = basePath + ext;
          if (fs.existsSync(testPath)) {
            return testPath;
          }
        }
        // Also try index files
        for (const ext of extensions) {
          const indexPath = path.join(basePath, `index${ext}`);
          if (fs.existsSync(indexPath)) {
            return indexPath;
          }
        }
        return null;
      }

      // Resolve imports (imports is an array of strings from nodejs extractImports)
      imports.forEach(importSource => {
        let resolvedPath = null;
        let isResolved = false;

        // Try path aliases first (if available)
        if (Object.keys(pathAliases).length > 0) {
          resolvedPath = resolveWithAlias(importSource, pathAliases, repoPath);
          if (resolvedPath) {
            importFiles.push(resolvedPath);
            isResolved = true;
            return;
          }
        }

        // Handle relative imports (./file or ../file)
        if (importSource.startsWith(".")) {
          resolvedPath = path.resolve(path.dirname(file), importSource);
        }
        // Handle absolute imports (/src/file or /lib/file)
        else if (importSource.startsWith("/")) {
          resolvedPath = path.join(repoPath, importSource);
        }
        // Try to resolve as a local module
        else if (!importSource.startsWith('@')) {
          if (importSource.includes('/')) {
            resolvedPath = path.join(repoPath, importSource);
          } else {
            const possiblePaths = [
              path.join(repoPath, 'src', importSource),
              path.join(repoPath, 'lib', importSource),
              path.join(repoPath, importSource)
            ];

            for (const possiblePath of possiblePaths) {
              const testPath = tryResolveWithExtensions(possiblePath);
              if (testPath) {
                resolvedPath = testPath;
                break;
              }
            }
          }
        }

        // If we have a potential path, try to resolve it with extensions
        if (resolvedPath && !isResolved) {
          const finalPath = tryResolveWithExtensions(resolvedPath);

          if (finalPath && fs.existsSync(finalPath)) {
            const relativePath = path.relative(repoPath, finalPath);
            if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
              importFiles.push(relativePath);
              isResolved = true;
              return;
            }
          }
        }

        // If we couldn't resolve it as a local file, it's an external import
        if (!isResolved) {
          externalImports.push(importSource);
        }
      });

      // Extract functions and classes using JavaScript parsers
      const functionsData = extractFunctionsJS(file, repoPath);
      const classesData = extractClassesJS(file, repoPath);

      const relativePath = path.relative(repoPath, file);
      results.push({
        path: relativePath,
        imports: importFiles.map(imp => ({ source: imp, specifiers: [] })),
        externalImports,
        functions: functionsData || [],
        classes: classesData || []
      });

    } catch (err) {
      console.error(`\n❌ Error processing ${file}: ${err.message}`);
    }
  }

  process.stdout.write('\r' + ' '.repeat(150) + '\r');
  console.log(`✅ Completed processing ${totalFiles} JavaScript files\n`);

  return results;
}

// -------------------------------------------------------------
// MAIN
// -------------------------------------------------------------
(() => {
  console.log(`📂 Scanning TypeScript/JavaScript repo: ${repoPath}`);

  // Analyze TypeScript files
  const tsResults = analyzeTypeScriptFiles();

  // Analyze JavaScript files
  const jsResults = analyzeJavaScriptFiles();

  // Merge results
  const mergedResults = [...tsResults, ...jsResults];

  console.log(`\n📊 Summary:`);
  console.log(`   TypeScript files: ${tsResults.length}`);
  console.log(`   JavaScript files: ${jsResults.length}`);
  console.log(`   Total files: ${mergedResults.length}\n`);

  // Write merged results
  fs.writeFileSync(importsOutput, JSON.stringify(mergedResults, null, 2));
  console.log(`✅ Final output written → ${importsOutput}`);
})();
