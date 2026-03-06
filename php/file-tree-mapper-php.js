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
const PHP = require("tree-sitter-php").php;
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-php");
const { extractClasses } = require("./extract-classes-php");
const { readSource, parseSource } = require("../utils");

// -------------------------------------------------------------
// Get PHP files
// -------------------------------------------------------------
function getPHPFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.php`, {
    ignore: [
      `${repoPath}/**/vendor/**`,           // Composer dependencies
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/storage/**`,          // Laravel storage
      `${repoPath}/**/bootstrap/cache/**`,  // Laravel cache
      `${repoPath}/**/cache/**`,
      `${repoPath}/**/.phpunit.cache/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`,
      `${repoPath}/**/_ide_helper*.php`,    // IDE helper files
      `${repoPath}/**/*.blade.php`          // Blade templates (optional)
    ]
  });
}

// -------------------------------------------------------------
// Build comprehensive class index
// Maps: className -> file, FQCN -> file, methodName -> [files]
// -------------------------------------------------------------
// Reuse a single parser instance
const phpParser = new Parser();
phpParser.setLanguage(PHP);

function buildClassIndex(files, repoPath) {
  const classIndex = {};      // className -> [file paths]
  const fqcnIndex = {};       // Namespace\ClassName -> [file paths]
  const methodIndex = {};     // methodName -> [{ className, filePath }]
  const functionIndex = {};   // functionName -> [file paths]

  files.forEach(file => {
    try {
      const { source, tree } = parseSource(file, phpParser);
      const relativePath = path.relative(repoPath, file);

      let currentNamespace = "";

      traverse(tree.rootNode, (node) => {
        // Track namespace
        if (node.type === "namespace_definition") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            currentNamespace = source.slice(nameNode.startIndex, nameNode.endIndex);
          } else {
            // Try to find namespace_name
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child.type === "namespace_name" || child.type === "qualified_name") {
                currentNamespace = source.slice(child.startIndex, child.endIndex);
                break;
              }
            }
          }
        }

        // Extract class/interface/trait/enum names and their methods
        if (
          node.type === "class_declaration" ||
          node.type === "interface_declaration" ||
          node.type === "trait_declaration" ||
          node.type === "enum_declaration"
        ) {
          let className = null;
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            className = source.slice(nameNode.startIndex, nameNode.endIndex);
          } else {
            // Try to find name child
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child.type === "name") {
                className = source.slice(child.startIndex, child.endIndex);
                break;
              }
            }
          }

          if (className) {
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

            // Extract methods from this class/interface/trait
            extractMethodsFromNode(node, source, className, relativePath, methodIndex);
          }
        }

        // Extract standalone functions
        if (node.type === "function_definition") {
          // Make sure it's not inside a class
          let isMethod = false;
          let parent = node.parent;
          while (parent) {
            if (
              parent.type === "class_declaration" ||
              parent.type === "interface_declaration" ||
              parent.type === "trait_declaration"
            ) {
              isMethod = true;
              break;
            }
            parent = parent.parent;
          }

          if (!isMethod) {
            let funcName = null;
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
              funcName = source.slice(nameNode.startIndex, nameNode.endIndex);
            } else {
              for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child.type === "name") {
                  funcName = source.slice(child.startIndex, child.endIndex);
                  break;
                }
              }
            }

            if (funcName) {
              if (!functionIndex[funcName]) {
                functionIndex[funcName] = [];
              }
              functionIndex[funcName].push(relativePath);

              // Also add to methodIndex for resolution
              if (!methodIndex[funcName]) {
                methodIndex[funcName] = [];
              }
              methodIndex[funcName].push({
                className: null,
                filePath: relativePath
              });
            }
          }
        }
      });
    } catch (e) {
      // Skip files that can't be parsed
    }
  });

  return { classIndex, fqcnIndex, methodIndex, functionIndex };
}

function extractMethodsFromNode(classNode, source, className, filePath, methodIndex) {
  // Find declaration_list (class body)
  let body = classNode.childForFieldName("body");
  if (!body) {
    for (let i = 0; i < classNode.childCount; i++) {
      const child = classNode.child(i);
      if (child.type === "declaration_list") {
        body = child;
        break;
      }
    }
  }

  if (!body) return;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    if (member.type === "method_declaration") {
      let methodName = null;
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methodName = source.slice(nameNode.startIndex, nameNode.endIndex);
      } else {
        for (let j = 0; j < member.childCount; j++) {
          const child = member.child(j);
          if (child.type === "name") {
            methodName = source.slice(child.startIndex, child.endIndex);
            break;
          }
        }
      }

      if (methodName) {
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
// Extract variable types from a file
// -------------------------------------------------------------
function extractVariableTypes(tree, source) {
  const varTypes = {};

  traverse(tree.rootNode, (node) => {
    // Property declarations with type hints
    if (node.type === "property_declaration") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);

        // Find property elements
        traverse(node, (n) => {
          if (n.type === "property_element") {
            const nameNode = n.childForFieldName("name");
            if (nameNode) {
              let varName = source.slice(nameNode.startIndex, nameNode.endIndex);
              if (varName.startsWith("$")) {
                varName = varName.substring(1);
              }
              varTypes[varName] = typeName;
            }
          }
        });
      }
    }

    // Constructor parameter promotion (PHP 8.0+)
    if (node.type === "property_promotion_parameter") {
      const typeNode = node.childForFieldName("type");
      const nameNode = node.childForFieldName("name");
      if (typeNode && nameNode) {
        const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);
        let varName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (varName.startsWith("$")) {
          varName = varName.substring(1);
        }
        varTypes[varName] = typeName;
      }
    }

    // Method/function parameters with type hints
    if (node.type === "simple_parameter") {
      const typeNode = node.childForFieldName("type");
      const nameNode = node.childForFieldName("name");
      if (typeNode && nameNode) {
        const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);
        let varName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (varName.startsWith("$")) {
          varName = varName.substring(1);
        }
        varTypes[varName] = typeName;
      }
    }
  });

  return varTypes;
}

// -------------------------------------------------------------
// Resolve use statement to local file or external package
// -------------------------------------------------------------
function resolveUseStatement(useNamespace, fqcnIndex, classIndex) {
  // Normalize namespace separators
  const normalizedNamespace = useNamespace.replace(/\//g, "\\");

  // Check if it's a direct FQCN match
  if (fqcnIndex[normalizedNamespace]) {
    return {
      type: "local",
      files: fqcnIndex[normalizedNamespace]
    };
  }

  // Check if it's a partial match (importing a namespace that contains our classes)
  const matchingFiles = [];
  Object.entries(fqcnIndex).forEach(([fqcn, files]) => {
    if (fqcn.startsWith(normalizedNamespace + "\\") || fqcn === normalizedNamespace) {
      matchingFiles.push(...files);
    }
  });

  if (matchingFiles.length > 0) {
    return {
      type: "local",
      files: [...new Set(matchingFiles)]
    };
  }

  // Check by class name only (last part of namespace)
  const lastPart = normalizedNamespace.split("\\").pop();
  if (classIndex[lastPart]) {
    return {
      type: "local",
      files: classIndex[lastPart]
    };
  }

  return {
    type: "external",
    namespace: normalizedNamespace
  };
}

// -------------------------------------------------------------
// Check if namespace is PHP standard library or common external
// -------------------------------------------------------------
function isPHPBuiltinOrExternal(namespace) {
  const normalizedNamespace = namespace.replace(/\//g, "\\");
  const topLevel = normalizedNamespace.split("\\")[0].toLowerCase();

  // PHP built-in namespaces
  const phpBuiltins = [
    "php",
    "spl",
    "dom",
    "pdo",
    "mysqli",
    "curl",
    "json",
    "xml",
    "soap",
    "ftp",
    "http",
    "arrayaccess",
    "countable",
    "iterator",
    "serializable",
    "throwable",
    "exception",
    "error",
    "closure",
    "generator",
    "reflectionclass",
    "datetime",
    "dateinterval",
    "datetimezone"
  ];

  // Common external packages (Composer packages)
  const commonExternal = [
    "illuminate",     // Laravel
    "symfony",        // Symfony
    "doctrine",       // Doctrine ORM
    "monolog",        // Logging
    "guzzle",         // HTTP Client
    "guzzlehttp",
    "league",         // PHP League packages
    "psr",            // PHP-FIG standards
    "phpunit",        // Testing
    "mockery",        // Mocking
    "carbon",         // Date/Time
    "ramsey",         // UUIDs
    "nesbot",         // Carbon
    "vlucas",         // dotenv
    "fideloper",
    "facade",
    "laravel",
    "orchestra",
    "predis",
    "aws",
    "stripe",
    "twilio",
    "sentry",
    "bugsnag"
  ];

  return phpBuiltins.includes(topLevel) ||
         commonExternal.includes(topLevel) ||
         normalizedNamespace.startsWith("App\\") === false && !normalizedNamespace.includes("\\");
}

// -------------------------------------------------------------
// Resolve require/include path to file
// -------------------------------------------------------------
function resolveRequirePath(requirePath, currentFilePath, repoPath, phpFiles) {
  // Handle __DIR__ and dirname(__FILE__)
  const currentDir = path.dirname(currentFilePath);

  // Remove common path construction patterns
  let cleanPath = requirePath
    .replace(/__DIR__\s*\.\s*['"]?\/?/gi, "")
    .replace(/dirname\s*\(\s*__FILE__\s*\)\s*\.\s*['"]?\/?/gi, "")
    .replace(/^\.\//g, "")
    .replace(/^\//, "");

  // Try to resolve the path
  const possiblePaths = [
    path.resolve(currentDir, cleanPath),
    path.resolve(repoPath, cleanPath),
    path.resolve(currentDir, "..", cleanPath),
    path.resolve(repoPath, "app", cleanPath),
    path.resolve(repoPath, "src", cleanPath)
  ];

  for (const possiblePath of possiblePaths) {
    // Check with and without .php extension
    const pathsToCheck = [
      possiblePath,
      possiblePath + ".php"
    ];

    for (const checkPath of pathsToCheck) {
      if (fs.existsSync(checkPath)) {
        return path.relative(repoPath, checkPath);
      }
    }
  }

  return null;
}

// -------------------------------------------------------------
// Analyze PHP files
// -------------------------------------------------------------
function analyzePHPRepo(repoPath, opts = {}) {
  const phpFiles = getPHPFiles(repoPath);
  const totalFiles = phpFiles.length;

  console.log(`\n📂 Building class and method index...`);
  const { classIndex, fqcnIndex, methodIndex, functionIndex } = buildClassIndex(phpFiles, repoPath);
  console.log(`✅ Found ${Object.keys(classIndex).length} types and ${Object.keys(methodIndex).length} methods across ${totalFiles} files\n`);

  const results = opts.onResult ? null : [];
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`📊 PHP files to process: ${totalFiles}\n`);

  for (let i = 0; i < phpFiles.length; i++) {
    const file = phpFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const { source, tree } = parseSource(file, phpParser);

      const importFiles = [];
      const externalImports = [];

      // Extract variable types for this file
      const varTypes = extractVariableTypes(tree, source);

      // Extract imports (use statements and require/include)
      const imports = extractImports(file);

      // Process use statements
      imports.useStatements.forEach(useStmt => {
        const resolved = resolveUseStatement(useStmt.source, fqcnIndex, classIndex);
        if (resolved.type === "local") {
          const currentFile = path.relative(repoPath, file);
          resolved.files.forEach(f => {
            if (f !== currentFile) {
              importFiles.push(f);
            }
          });
        } else {
          // Check if it's truly external or just unresolved local
          if (isPHPBuiltinOrExternal(useStmt.source)) {
            externalImports.push(useStmt.source);
          } else {
            // Might be a local namespace that wasn't indexed
            externalImports.push(useStmt.source);
          }
        }
      });

      // Process require/include statements
      imports.requires.forEach(req => {
        const resolvedPath = resolveRequirePath(req.source, file, repoPath, phpFiles);
        if (resolvedPath) {
          importFiles.push(resolvedPath);
        }
      });

      // Extract functions and classes with enhanced call resolution
      const functions = extractFunctionsAndCalls(file, repoPath, {
        classIndex,
        fqcnIndex,
        methodIndex,
        varTypes
      }, opts.captureSourceCode);
      const classes = extractClasses(file, repoPath);

      const fileResult = {
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions,
        classes
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
  console.log(`✅ Completed processing ${totalFiles} PHP files\n`);

  return results || [];
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
