const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode, parseSource, containsDbQuery, getDbFromMethod } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(JavaScript);

const STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition"];

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "arrow_function" ||
      node.type === "method_definition"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode, captureStatements);
      // Filter out functions with null names
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source = null, captureSourceCode = false, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node);
  const params = extractFunctionParams(node);
  const calls = extractDirectCalls(node);

  const { visibility, kind } = getFunctionModifiers(node);

  // const relativePath = repoPath ? path.relative(repoPath, filePath) : filePath;

  const statements = captureStatements ? extractStatements(node, source) : [];

  const result = {
    name,
    type: node.type,
    visibility,
    kind,
    params,
    startLine,
    endLine,
    // path: relativePath,
    calls,
    statements
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(source.slice(node.startIndex, node.endIndex));
  }

  return result;
}

function getFunctionModifiers(node) {
  const parent = node.parent;

  // Free-standing functions
  if (!parent || parent.type !== "method_definition") {
    return {
      visibility: "public",
      kind: "function"
    };
  }

  const nameNode = parent.childForFieldName("name");

  const visibility =
    nameNode?.type === "private_property_identifier"
      ? "private"
      : "public";

  const isStatic = parent.childForFieldName("static") !== null;

  return {
    visibility,
    kind: isStatic ? "static" : "instance"
  };
}



/* =========================================================
   Parameter extraction (callback-safe)
   ========================================================= */

function extractFunctionParams(node) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    // Ignore inline callback / function parameters
    if (containsFunction(child)) continue;

    params.push(extractParamName(child));
  }

  return params;
}

/* =========================================================
   Callback detection (AST driven)
   ========================================================= */

function containsFunction(node) {
  if (
    node.type === "function_expression" ||
    node.type === "arrow_function" ||
    node.type === "function_declaration"
  ) {
    return true;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.isNamed && containsFunction(child)) {
      return true;
    }
  }

  return false;
}

/* =========================================================
   Parameter name normalization
   ========================================================= */

function extractParamName(node) {
  switch (node.type) {
    case "identifier":
      return node.text;

    case "assignment_pattern":
      // a = 1
      return extractParamName(node.child(0));

    case "rest_pattern":
      // ...args
      return "..." + extractParamName(node.child(1));

    case "object_pattern":
      return "{...}";

    case "array_pattern":
      return "[...]";

    default:
      return node.text;
  }
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

    const fn = node.childForFieldName("function");
    if (!fn) return;

    // identifier call: foo()
    if (fn.type === "identifier") {
      calls.push({
        name: fn.text,
        objectName: null,
        type: "identifier",
        path: null
      });
      return;
    }

    // member call: obj.method()
    if (fn.type === "member_expression") {
      let objectNode = fn.childForFieldName("object");
      const propNode   = fn.childForFieldName("property");

      // FIX: unwrap call_expression objects
      while (objectNode && objectNode.type === "call_expression") {
        objectNode = objectNode.childForFieldName("function");
      }

      // FIX: unwrap member_expression chains to root
      while (objectNode && objectNode.type === "member_expression") {
        const innerObj = objectNode.childForFieldName("object");
        if (!innerObj) break;
        objectNode = innerObj;
      }

      const finalObjectName = objectNode ? objectNode.text : null;

      calls.push({
        name: propNode ? propNode.text : null,
        objectName: finalObjectName,
        type: "member_expression",
        path: null
      });

      return;
    }
  });

  return calls;
}




// ---------------------------------------------------------
function unwrapExport(node) {
  if (node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl) return decl;
  }
  return node;
}

function extractStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    let child = body.namedChild(i);
    child = unwrapExport(child);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: (source ? source.slice(child.startIndex, child.endIndex) : child.text).slice(0, 200),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  // Detect query statements via deep traversal
  collectQueryStatements(node, source, statements);

  return statements;
}

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
  const { source, tree } = parseSource(filePath, sharedParser);

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
    return path.relative(repoPath, resolvedPath) 
  }

  return null;
}


function extractFuncitonAndItsCalls(filePath, repoPath, imports = null, captureSourceCode = false, captureStatements = false) {
 try {
      const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode, captureStatements);
      if (!imports) imports = extractImports(filePath);


      const functionMap = new Map();
      functions.forEach(func => {
        functionMap.set(func.name, func.path)
      })
      imports.forEach(imp => {
        imp.imported?.forEach(imported => {
          const resolvedPath = resolveImportPath(imp.source, filePath, repoPath)
          functionMap.set(imported, resolvedPath || imp.source)
        })
      })
      functions.forEach(func => {
        func.calls.forEach(call => {
          const path = functionMap.get(call.name) || functionMap.get(call.objectName);
          if(path) call.path = path;
          delete call.objectName;
          delete call.type;
        })
      })
      return functions;
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error);
    }
}

function extractFileStatements(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);
  const statements = [];
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    let child = tree.rootNode.namedChild(i);
    child = unwrapExport(child);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: (source ? source.slice(child.startIndex, child.endIndex) : child.text).slice(0, 200),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  // Detect query statements via deep traversal
  collectQueryStatements(tree.rootNode, source, statements);

  return statements;
}

// ---------------------------------------------------------
// Query statement detection — pushes into statements array with type "query_statement"
// Detects by: call targets (db.query, pool.execute, etc.) and raw query strings (SQL, Cypher, etc.)
// ---------------------------------------------------------
function collectQueryStatements(node, source, statements) {
  const seen = new Set(statements.map(s => `${s.startLine}:${s.endLine}`));

  traverse(node, (n) => {
    // Call expressions with DB method names
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (!fn) return;

      let methodName = null;
      if (fn.type === "identifier") {
        methodName = fn.text;
      } else if (fn.type === "member_expression") {
        const prop = fn.childForFieldName("property");
        methodName = prop ? prop.text : null;
      }

      const db = getDbFromMethod(methodName);
      if (db) {
        const key = `${n.startPosition.row + 1}:${n.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "query_statement", db,
            text: source.slice(n.startIndex, n.endIndex).slice(0, 500),
            startLine: n.startPosition.row + 1,
            endLine: n.endPosition.row + 1,
          });
        }
        return;
      }
    }

    // String literals or template strings containing DB queries
    if (n.type === "string" || n.type === "template_string") {
      const text = source.slice(n.startIndex, n.endIndex);
      if (containsDbQuery(text)) {
        let parent = n.parent;
        while (parent && parent !== node && parent.type !== "lexical_declaration" && parent.type !== "variable_declaration" && parent.type !== "expression_statement" && parent.type !== "assignment_expression") {
          parent = parent.parent;
        }
        const contextNode = (parent && parent !== node) ? parent : n;
        const key = `${contextNode.startPosition.row + 1}:${contextNode.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "query_statement",
            text: source.slice(contextNode.startIndex, contextNode.endIndex).slice(0, 500),
            startLine: contextNode.startPosition.row + 1,
            endLine: contextNode.endPosition.row + 1,
          });
        }
      }
    }
  });
}

module.exports = { extractFuncitonAndItsCalls, extractImports, extractFileStatements, collectQueryStatements };
