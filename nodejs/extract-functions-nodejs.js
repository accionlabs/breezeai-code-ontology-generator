const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const fs = require("fs");
const path = require("path");

function extractFunctionsWithCalls(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(JavaScript);

  const tree = parser.parse(source);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "arrow_function" ||
      node.type === "method_definition"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath);
      // Filter out functions with null names
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

// ---------------------------------------------------------
// Extract a single function info
// ---------------------------------------------------------
function extractFunctionInfo(node, filePath, repoPath = null) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const type = node.type;

  const name = getFunctionName(node);
  const calls = extractDirectCalls(node);

  // Convert to relative path if repoPath is provided
  const relativePath = repoPath ? path.relative(repoPath, filePath) : filePath;

  return {
    name,
    type,
    startLine,
    endLine,
    path: relativePath,
    calls
  };
}

// ---------------------------------------------------------
// Identify function name (decl, expression, arrow, method)
// ---------------------------------------------------------
function getFunctionName(node) {
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    return id ? id.text : null;
  }

  if (node.type === "method_definition") {
    const id = node.childForFieldName("name");
    return id ? id.text : null;
  }

  // arrow + function expressions: find variable assigned
  const parent = node.parent;
  if (parent && parent.type === "variable_declarator") {
    const id = parent.childForFieldName("name");
    return id ? id.text : null;
  }

  // fallback: anonymous
  return null;
}

// ---------------------------------------------------------
// Extract DIRECT calls inside function body
// Ignore callback functions inside argument lists
// ---------------------------------------------------------
function extractDirectCalls(funcNode) {
  const calls = [];

  traverse(funcNode, (node, parent) => {
    if (node.type !== "call_expression") return;

    // Ignore callback: call used as argument of another call
    if (parent && parent.type === "arguments") return;

    const func = node.childForFieldName("function");

    if (!func) return;

    // identifier: foo()
    if (func.type === "identifier") {
      calls.push({ name: func.text, path: null });
      return;
    }

    // member_expression: obj.foo()
    if (func.type === "member_expression") {
      const prop = func.childForFieldName("property");
      if (prop) calls.push({ name: prop.text, path: null });
      return;
    }
  });

  return calls;
}

// ---------------------------------------------------------
function traverse(node, cb, parent = null) {
  cb(node, parent);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb, node);
  }
}
// ---------------------------------------------------------

// ---------------------------------------------------------
// Extract imports/requires from a file
// ---------------------------------------------------------
function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  const tree = parser.parse(source);

  const imports = []; // { source: "./foo", imported: ["bar", "baz"] }

  traverse(tree.rootNode, (node) => {
    // ES6 imports: import { foo, bar } from "./module"
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        const importSource = sourceNode.text.replace(/['"]/g, "");
        const importedNames = [];

        // Get imported identifiers
        const importClause = node.namedChildren.find(n =>
          n.type === "import_clause" || n.type === "named_imports"
        );

        if (importClause) {
          traverse(importClause, (n) => {
            if (n.type === "import_specifier") {
              const name = n.childForFieldName("name");
              const alias = n.childForFieldName("alias");
              importedNames.push(alias ? alias.text : (name ? name.text : null));
            } else if (n.type === "identifier" && n.parent.type === "import_clause") {
              importedNames.push(n.text); // default import
            }
          });
        }

        imports.push({ source: importSource, imported: importedNames });
      }
    }

    // CommonJS require: const { foo, bar } = require("./module")
    if (node.type === "variable_declarator") {
      const init = node.childForFieldName("value");
      if (init && init.type === "call_expression") {
        const func = init.childForFieldName("function");
        if (func && func.text === "require") {
          const args = init.childForFieldName("arguments");
          if (args) {
            const firstArg = args.namedChild(0);
            if (firstArg && firstArg.type === "string") {
              const importSource = firstArg.text.replace(/['"]/g, "");
              const importedNames = [];

              const name = node.childForFieldName("name");
              if (name) {
                if (name.type === "identifier") {
                  importedNames.push(name.text); // const foo = require()
                } else if (name.type === "object_pattern") {
                  // const { foo, bar } = require()
                  traverse(name, (n) => {
                    if (n.type === "shorthand_property_identifier_pattern") {
                      importedNames.push(n.text);
                    } else if (n.type === "pair_pattern") {
                      const value = n.childForFieldName("value");
                      if (value && value.type === "identifier") {
                        importedNames.push(value.text);
                      }
                    }
                  });
                }
              }

              imports.push({ source: importSource, imported: importedNames });
            }
          }
        }
      }
    }
  });

  return imports;
}

// ---------------------------------------------------------
// Resolve import path to absolute file path
// ---------------------------------------------------------
function resolveImportPath(importSource, currentFilePath, repoPath) {
  // External package (not relative path)
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return null; // External npm package
  }

  // Relative path
  let resolvedPath = path.resolve(path.dirname(currentFilePath), importSource);

  // Add .js extension if not present
  if (!path.extname(resolvedPath)) {
    resolvedPath += ".js";
  }

  // Check if file exists
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  return null;
}

// ---------------------------------------------------------
// Process multiple files and resolve call definitions
// ---------------------------------------------------------
function extractFunctionsFromMultipleFiles(filePaths, repoPath = null) {
  // Step 1: Extract all functions from all files
  const allFunctions = [];
  const fileData = new Map(); // filePath -> { functions, imports }

  for (const filePath of filePaths) {
    try {
      const functions = extractFunctionsWithCalls(filePath, repoPath);
      const imports = extractImports(filePath);

      fileData.set(filePath, { functions, imports });
      allFunctions.push(...functions.map(f => ({ ...f, sourceFile: filePath })));
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error.message);
    }
  }

  // Step 2: Build a function registry (filePath -> function names)
  const functionRegistry = new Map();
  for (const [filePath, data] of fileData.entries()) {
    const functionNames = new Set();
    for (const func of data.functions) {
      if (func.name) {
        functionNames.add(func.name);
      }
    }
    functionRegistry.set(filePath, functionNames);
  }

  // Step 3: Build import map for each file (imported name -> resolved file path)
  const importMaps = new Map();
  for (const [filePath, data] of fileData.entries()) {
    const importMap = new Map(); // function name -> source file path

    for (const imp of data.imports) {
      const resolvedPath = resolveImportPath(imp.source, filePath, repoPath);
      if (resolvedPath) {
        // Map each imported name to the resolved file path
        for (const importedName of imp.imported) {
          if (importedName) {
            importMap.set(importedName, resolvedPath);
          }
        }
      }
    }

    importMaps.set(filePath, importMap);
  }

  // Step 4: Resolve call definitions based on imports
  for (const func of allFunctions) {
    const importMap = importMaps.get(func.sourceFile);

    for (const call of func.calls) {
      // First, check if this function is imported from another file
      if (importMap && importMap.has(call.name)) {
        const resolvedPath = importMap.get(call.name);
        // Convert to relative path
        call.path = repoPath ? path.relative(repoPath, resolvedPath) : resolvedPath;
      }
      // Otherwise, check if it's defined in the same file
      else if (functionRegistry.has(func.sourceFile) &&
               functionRegistry.get(func.sourceFile).has(call.name)) {
        // Use the relative path from func.definedIn since it's the same file
        call.path = func.path;
      }
      // If not found anywhere, leave as null
    }
  }

  // Remove the temporary sourceFile property
  return allFunctions.map(({ sourceFile, ...rest }) => rest);
}

module.exports = { extractFunctionsWithCalls, extractFunctionsFromMultipleFiles, extractImports };
