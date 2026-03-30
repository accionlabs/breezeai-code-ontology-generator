#!/usr/bin/env node
/**
 * Vue SFC (Single File Component) Analyzer
 *
 * Parses .vue files by extracting the <script> block and analyzing it
 * with tree-sitter-javascript.  Output format is identical to the
 * nodejs/file-tree-mapper-nodejs.js output.
 *
 * CLI Usage:  node vue/file-tree-mapper-vue.js <repoPath> <output.json>
 * Module Usage: const { analyzeVueRepo } = require('./vue/file-tree-mapper-vue');
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { getIgnorePatternsWithPrefix } = require("../ignore-patterns");
const {
  extractFunctionsFromSource,
  extractFileStatementsFromSource,
  extractImportsFromSource,
} = require("./extract-functions-vue");
const { extractClassesFromSource } = require("./extract-classes-vue");

// -----------------------------------------------------------
// SFC block extraction
// -----------------------------------------------------------

/**
 * Extract the <script> block content and its starting line offset.
 * Handles: <script>, <script setup>, <script lang="js">.
 * Skips <script lang="ts"> (TypeScript should use the TS parser).
 *
 * @param {string} fileContent - The full .vue file content
 * @returns {{ content: string, lineOffset: number }[]} - Array of script blocks
 */
function extractScriptBlocks(fileContent) {
  const blocks = [];
  // Match <script ...> ... </script>  (non-greedy, case-insensitive tag)
  const regex = /<script(?:\s+([^>]*))?>([^]*?)<\/script>/gi;
  let match;

  while ((match = regex.exec(fileContent)) !== null) {
    const attrs = match[1] || "";
    const content = match[2];

    // Skip TypeScript blocks — those need the TS parser
    if (/lang\s*=\s*["']ts["']/i.test(attrs) || /lang\s*=\s*["']typescript["']/i.test(attrs)) {
      continue;
    }

    // Calculate line offset: count newlines before the <script> tag
    const beforeScript = fileContent.slice(0, match.index);
    const tagLine = beforeScript.split("\n").length - 1;
    // The content starts after the <script...> opening tag
    const openingTag = match[0].slice(0, match[0].indexOf(">") + 1);
    const tagLines = openingTag.split("\n").length - 1;
    const lineOffset = tagLine + tagLines;

    blocks.push({ content, lineOffset });
  }

  return blocks;
}

// -----------------------------------------------------------
// Import resolution
// -----------------------------------------------------------

function tryResolveWithExtensions(basePath) {
  // Vue extension list includes .vue
  const extensions = [".js", ".jsx", ".mjs", ".cjs", ".json", ".vue"];

  if (path.extname(basePath) && fs.existsSync(basePath)) {
    return basePath;
  }

  for (const ext of extensions) {
    const p = basePath + ext;
    if (fs.existsSync(p)) return p;
  }

  // Try as directory with index file
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of extensions) {
      const indexPath = path.join(basePath, "index" + ext);
      if (fs.existsSync(indexPath)) return indexPath;
    }
  }

  return null;
}

// -----------------------------------------------------------
// Package mapper (for resolving bare module names)
// -----------------------------------------------------------

function buildPackageMapper(repoPath) {
  const vueFiles = getVueFiles(repoPath);
  const mapper = {};
  for (const file of vueFiles) {
    const pkgName = path.basename(file, path.extname(file));
    mapper[pkgName] = path.relative(repoPath, file);
  }
  return mapper;
}

function getVueFiles(repoPath, ignorePatterns) {
  const patterns =
    ignorePatterns || getIgnorePatternsWithPrefix(repoPath, { language: "vue" });
  return glob.sync(`${repoPath}/**/*.vue`, { ignore: patterns });
}

// -----------------------------------------------------------
// Resolve path aliases (@/ → src/)
// -----------------------------------------------------------

function resolvePathAlias(importPath, repoPath) {
  // Common Vue/Vite/Webpack alias: @/ → src/
  if (importPath.startsWith("@/")) {
    return path.join(repoPath, "src", importPath.slice(2));
  }
  // ~/ alias (some configs)
  if (importPath.startsWith("~/")) {
    return path.join(repoPath, "src", importPath.slice(2));
  }
  return null;
}

// -----------------------------------------------------------
// Main analysis
// -----------------------------------------------------------

function analyzeVueRepo(repoPath, opts = {}) {
  console.log(`📂 Scanning Vue repo: ${repoPath}`);

  const mapper = buildPackageMapper(repoPath);
  const vueFiles = getVueFiles(repoPath);

  const results = opts.onResult ? null : [];
  const totalFiles = vueFiles.length;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIndex = 0;

  console.log(`\n📊 Total Vue files to process: ${totalFiles}\n`);

  for (let i = 0; i < vueFiles.length; i++) {
    const file = vueFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);
      process.stdout.write(
        `\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, " ")}`
      );
      spinnerIndex++;

      const fileContent = fs.readFileSync(file, "utf8").replace(/\0/g, "");
      const scriptBlocks = extractScriptBlocks(fileContent);

      if (scriptBlocks.length === 0) {
        // No parseable script block — still register the file with empty data
        const emptyResult = {
          path: path.relative(repoPath, file),
          importFiles: [],
          externalImports: [],
          functions: [],
          classes: [],
          statements: [],
        };
        if (opts.onResult) {
          opts.onResult(emptyResult);
        } else {
          results.push(emptyResult);
        }
        continue;
      }

      // Merge data from all script blocks (handles <script> + <script setup>)
      let allFunctions = [];
      let allClasses = [];
      let allStatements = [];
      let allImportSources = [];

      for (const block of scriptBlocks) {
        const { content, lineOffset } = block;

        // Extract functions
        const { functions } = extractFunctionsFromSource(
          content,
          lineOffset,
          opts.captureSourceCode,
          opts.captureStatements
        );
        allFunctions.push(...functions);

        // Extract classes
        const classes = extractClassesFromSource(content, lineOffset);
        allClasses.push(...classes);

        // Extract file-level statements
        if (opts.captureStatements) {
          const stmts = extractFileStatementsFromSource(content, lineOffset);
          allStatements.push(...stmts);
        }

        // Extract imports
        const imports = extractImportsFromSource(content);
        allImportSources.push(...imports);
      }

      // Resolve import paths
      const importFiles = [];
      const externalImports = [];

      for (const impObj of allImportSources) {
        const imp = impObj.source;
        let resolvedPath = null;
        let isResolved = false;

        // Path aliases: @/components/Foo → src/components/Foo
        const aliasResolved = resolvePathAlias(imp, repoPath);
        if (aliasResolved) {
          resolvedPath = aliasResolved;
        }
        // Relative imports
        else if (imp.startsWith(".")) {
          resolvedPath = path.resolve(path.dirname(file), imp);
        }
        // Absolute imports
        else if (imp.startsWith("/")) {
          resolvedPath = path.join(repoPath, imp);
        }
        // Bare module or local module
        else if (!imp.startsWith("@")) {
          if (imp.includes("/")) {
            resolvedPath = path.join(repoPath, imp);
          } else if (mapper[imp]) {
            const mappedPath = path.join(repoPath, mapper[imp]);
            if (fs.existsSync(mappedPath)) {
              importFiles.push(mapper[imp]);
              isResolved = true;
            }
          }
        }

        if (resolvedPath && !isResolved) {
          const finalPath = tryResolveWithExtensions(resolvedPath);
          if (finalPath && fs.existsSync(finalPath)) {
            const relativePath = path.relative(repoPath, finalPath);
            if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
              importFiles.push(relativePath);
              isResolved = true;
            }
          }
        }

        if (!isResolved) {
          externalImports.push(imp);
        }
      }

      const fileResult = {
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions: allFunctions,
        classes: allClasses,
        statements: allStatements,
      };

      if (opts.onResult) {
        opts.onResult(fileResult);
      } else {
        results.push(fileResult);
      }
    } catch (e) {
      process.stdout.write("\n");
      console.log(`❌ Error analyzing Vue file: ${file} - ${e.message}`);
    }
  }

  process.stdout.write("\r" + " ".repeat(150) + "\r");
  console.log(`✅ Completed processing ${totalFiles} Vue files\n`);

  return results || [];
}

// -----------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      "Usage: node vue/file-tree-mapper-vue.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(args[0]);
  const outputFile = path.resolve(args[1]);

  const captureStatements = args.includes("--capture-statements");
  const captureSourceCode = args.includes("--capture-source-code");

  const results = analyzeVueRepo(repoPath, {
    captureStatements,
    captureSourceCode,
  });
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`📄 Output written to ${outputFile}`);
}

module.exports = { analyzeVueRepo };
