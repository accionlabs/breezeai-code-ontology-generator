#!/usr/bin/env node
/**
 * PHP Import Analyzer
 * Analyzes PHP files (.php) and extracts imports, classes, and functions
 * Usage: node file-tree-mapper-php.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const PHP = require("tree-sitter-php");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-php");
const { extractClasses } = require("./extract-classes-php");

// -------------------------------------------------------------
// Get PHP files
// -------------------------------------------------------------
function getPHPFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.php`, {
    ignore: [
      `${repoPath}/**/vendor/**`,           // Composer dependencies
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/storage/**`,           // Laravel storage
      `${repoPath}/**/bootstrap/cache/**`,   // Laravel cache
      `${repoPath}/**/cache/**`,
      `${repoPath}/**/.phpunit.cache/**`,
      `${repoPath}/**/var/**`                // Symfony var directory
    ]
  });
}

// -------------------------------------------------------------
// Build comprehensive class index
// Maps: className -> file, namespace\className -> file, methodName -> [files]
// -------------------------------------------------------------
function buildClassIndex(files, repoPath) {
  const classIndex = {};      // className -> [file paths]
  const fqcnIndex = {};       // Namespace\ClassName -> [file paths]
  const methodIndex = {};     // methodName -> [{ className, filePath }]

  const parser = new Parser();
  parser.setLanguage(PHP.php);

  files.forEach(file => {
    try {
      const source = fs.readFileSync(file, "utf8");
      const tree = parser.parse(source);
      const relativePath = path.relative(repoPath, file);

      let currentNamespace = "";

      traverse(tree.rootNode, (node) => {
        // Track namespace
        if (node.type === "namespace_definition") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            currentNamespace = source.slice(nameNode.startIndex, nameNode.endIndex);
          }
        }

        // Extract class/interface/trait names and their methods
        if (
          node.type === "class_declaration" ||
          node.type === "interface_declaration" ||
          node.type === "trait_declaration" ||
          node.type === "enum_declaration"
        ) {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const className = source.slice(nameNode.startIndex, nameNode.endIndex);
            const fqcn = currentNamespace ? `${currentNamespace}\\${className}` : className;

            // Map class name to file
            if (!classIndex[className]) {
              classIndex[className] = [];
            }
            classIndex[className].push(relativePath);

            // Map FQCN to file
            if (!fqcnIndex[fqcn]) {
              fqcnIndex[fqcn] = [];
            }
            fqcnIndex[fqcn].push(relativePath);

            // Extract methods from this class
            const body = node.childForFieldName("body");
            if (body) {
              extractMethodsFromBody(body, source, className, relativePath, methodIndex);
            }
          }
        }
      });
    } catch (e) {
      // Skip files that can't be parsed
    }
  });

  return { classIndex, fqcnIndex, methodIndex };
}

function extractMethodsFromBody(body, source, className, filePath, methodIndex) {
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    if (member.type === "method_declaration") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

        if (!methodIndex[methodName]) {
          methodIndex[methodName] = [];
        }
        methodIndex[methodName].push({
          className,
          filePath
        });
      }
    }
  }
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// -------------------------------------------------------------
// Resolve use directive to local file or external package
// -------------------------------------------------------------
function resolveUseDirective(useNamespace, fqcnIndex, classIndex) {
  // Check if it's a direct FQCN match
  if (fqcnIndex[useNamespace]) {
    return {
      type: "local",
      files: fqcnIndex[useNamespace]
    };
  }

  // Check if it's a partial match
  const matchingFiles = [];
  Object.entries(fqcnIndex).forEach(([fqcn, files]) => {
    if (fqcn.startsWith(useNamespace + "\\") || fqcn === useNamespace) {
      matchingFiles.push(...files);
    }
  });

  if (matchingFiles.length > 0) {
    return {
      type: "local",
      files: [...new Set(matchingFiles)]
    };
  }

  return {
    type: "external",
    namespace: useNamespace
  };
}

// -------------------------------------------------------------
// Check if namespace is a common external/framework package
// -------------------------------------------------------------
function isPHPStdLibOrFramework(namespace) {
  const externalPrefixes = [
    // Composer packages and common frameworks
    "Illuminate",      // Laravel
    "Symfony",
    "Doctrine",
    "PHPUnit",
    "Psr",             // PSR standards
    "GuzzleHttp",
    "Monolog",
    "Carbon",
    "League",
    "Twig",
    "Laminas",         // Formerly Zend
    "Predis",
    "PhpAmqpLib",
    "Google",
    "AWS",
    "Firebase"
  ];

  return externalPrefixes.some(prefix =>
    namespace.startsWith(prefix + "\\") || namespace === prefix
  );
}

// -------------------------------------------------------------
// Analyze PHP files
// -------------------------------------------------------------
function analyzePHPRepo(repoPath, opts = {}) {
  const phpFiles = getPHPFiles(repoPath);
  const totalFiles = phpFiles.length;

  console.log(`\n📂 Building class and method index...`);
  const { classIndex, fqcnIndex, methodIndex } = buildClassIndex(phpFiles, repoPath);
  console.log(`✅ Found ${Object.keys(classIndex).length} types and ${Object.keys(methodIndex).length} methods across ${totalFiles} files\n`);

  const results = [];
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`📊 PHP files to process: ${totalFiles}\n`);

  const parser = new Parser();
  parser.setLanguage(PHP.php);

  for (let i = 0; i < phpFiles.length; i++) {
    const file = phpFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const source = fs.readFileSync(file, "utf8");
      const tree = parser.parse(source);

      const importFiles = [];
      const externalImports = [];

      // Extract use directives
      traverse(tree.rootNode, (node) => {
        if (node.type === "namespace_use_declaration") {
          traverse(node, (n) => {
            if (n.type === "namespace_use_clause") {
              // Find the qualified_name or name child (not a named field)
              let nameNode = null;
              for (let k = 0; k < n.childCount; k++) {
                const child = n.child(k);
                if (child.type === "qualified_name" || child.type === "name") {
                  nameNode = child;
                  break;
                }
              }
              if (nameNode) {
                const useNamespace = source.slice(nameNode.startIndex, nameNode.endIndex);

                if (isPHPStdLibOrFramework(useNamespace)) {
                  externalImports.push(useNamespace);
                } else {
                  const resolved = resolveUseDirective(useNamespace, fqcnIndex, classIndex);
                  if (resolved.type === "local") {
                    const currentFile = path.relative(repoPath, file);
                    resolved.files.forEach(f => {
                      if (f !== currentFile) {
                        importFiles.push(f);
                      }
                    });
                  } else {
                    externalImports.push(useNamespace);
                  }
                }
              }
            }
          });
        }

        // Handle require/include
        if (node.type === "include_expression" ||
            node.type === "include_once_expression" ||
            node.type === "require_expression" ||
            node.type === "require_once_expression") {
          for (let j = 0; j < node.childCount; j++) {
            const child = node.child(j);
            if (child.type === "string" || child.type === "encapsed_string") {
              let pathValue = source.slice(child.startIndex, child.endIndex);
              pathValue = pathValue.replace(/^['"]|['"]$/g, "");

              // Try to resolve relative path
              if (pathValue.startsWith("./") || pathValue.startsWith("../")) {
                const resolvedPath = path.resolve(path.dirname(file), pathValue);
                if (fs.existsSync(resolvedPath)) {
                  importFiles.push(path.relative(repoPath, resolvedPath));
                } else {
                  importFiles.push(pathValue);
                }
              } else {
                importFiles.push(pathValue);
              }
              break;
            }
          }
        }
      });

      // Extract functions and classes
      const functions = extractFunctionsAndCalls(file, repoPath, {
        classIndex,
        methodIndex
      }, opts.captureSourceCode);
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
  console.log(`✅ Completed processing ${totalFiles} PHP files\n`);

  return results;
}

// -------------------------------------------------------------
// EXPORT FOR MODULE USE
// -------------------------------------------------------------
module.exports = { analyzePHPRepo };

// -------------------------------------------------------------
// CLI MODE - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node php/file-tree-mapper-php.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);
  const captureSourceCode = process.argv.includes("--capture-source-code");

  console.log(`📂 Scanning PHP repo: ${repoPath}`);

  const results = analyzePHPRepo(repoPath, { captureSourceCode });

  console.log(`\n📊 Summary:`);
  console.log(`   Total PHP files: ${results.length}\n`);

  // Write results
  fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
  console.log(`✅ Output written → ${importsOutput}`);
}
