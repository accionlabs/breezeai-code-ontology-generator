const Parser = require("tree-sitter");
const TS = require("tree-sitter-typescript").typescript;
const fs = require("fs");
const path = require("path");

function extractFunctionsWithCalls(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(TS);

  const tree = parser.parse(source);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_declaration" ||
      node.type === "function" ||
      node.type === "arrow_function" ||
      node.type === "method_definition" ||
      node.type === "function_signature"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind } = getFunctionModifiers(node, source);

  return {
    name,
    type: node.type,
    visibility,
    kind,
    params,
    startLine,
    endLine,
    calls
  };
}

function getFunctionModifiers(node, source) {
  let visibility = "public"; // TypeScript/JavaScript default
  let kind = "function";

  // Check if it's a method
  const parent = node.parent;
  if (parent && parent.type === "method_definition") {
    kind = "instance";

    // Check for accessibility modifiers
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      const text = source.slice(child.startIndex, child.endIndex);

      if (text === "private") {
        visibility = "private";
      } else if (text === "protected") {
        visibility = "protected";
      } else if (text === "public") {
        visibility = "public";
      } else if (text === "static") {
        kind = "static";
      }
    }
  } else if (parent && parent.type === "public_field_definition") {
    // Arrow function as class property
    kind = "instance";

    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      const text = source.slice(child.startIndex, child.endIndex);

      if (text === "private") visibility = "private";
      else if (text === "protected") visibility = "protected";
      else if (text === "public") visibility = "public";
      else if (text === "static") kind = "static";
    }
  }

  return { visibility, kind };
}

function extractFunctionParams(node, source) {
  let paramsNode = node.childForFieldName("parameters");

  // For arrow functions, params might be in different location
  if (!paramsNode) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === "formal_parameters") {
        paramsNode = child;
        break;
      }
    }
  }

  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    // Ignore callback functions
    if (containsFunction(child)) continue;

    const paramName = extractParamName(child, source);
    if (paramName) {
      params.push(paramName);
    }
  }

  return params;
}

function containsFunction(node) {
  if (
    node.type === "arrow_function" ||
    node.type === "function" ||
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

function extractParamName(node, source) {
  switch (node.type) {
    case "required_parameter":
    case "optional_parameter":
      // Get the identifier, ignoring type annotations
      const nameNode = node.childForFieldName("pattern");
      if (nameNode) {
        if (nameNode.type === "identifier") {
          return source.slice(nameNode.startIndex, nameNode.endIndex);
        } else if (nameNode.type === "object_pattern") {
          return "{...}";
        } else if (nameNode.type === "array_pattern") {
          return "[...]";
        }
      }
      return null;

    case "identifier":
      return source.slice(node.startIndex, node.endIndex);

    case "object_pattern":
      return "{...}";

    case "array_pattern":
      return "[...]";

    case "rest_pattern":
      const restName = node.childForFieldName("pattern") || node.child(1);
      if (restName) {
        return "..." + extractParamName(restName, source);
      }
      return "...args";

    default:
      return null;
  }
}

function getFunctionName(node, source) {
  // Method definition
  if (node.type === "method_definition") {
    const nameNode = node.childForFieldName("name");
    return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
  }

  // Function declaration
  if (node.type === "function_declaration") {
    const nameNode = node.childForFieldName("name");
    return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
  }

  // Arrow function or function expression - check parent
  const parent = node.parent;

  if (parent && parent.type === "variable_declarator") {
    const nameNode = parent.childForFieldName("name");
    return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
  }

  if (parent && parent.type === "public_field_definition") {
    const nameNode = parent.childForFieldName("name");
    return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
  }

  if (parent && parent.type === "pair") {
    const keyNode = parent.childForFieldName("key");
    return keyNode ? source.slice(keyNode.startIndex, keyNode.endIndex) : null;
  }

  return null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type !== "call_expression") return;

    const fn = node.childForFieldName("function");
    if (!fn) return;

    // identifier call: foo()
    if (fn.type === "identifier") {
      calls.push({
        name: source.slice(fn.startIndex, fn.endIndex),
        path: null
      });
      return;
    }

    // member call: obj.method()
    if (fn.type === "member_expression") {
      let objectNode = fn.childForFieldName("object");
      const propNode = fn.childForFieldName("property");

      // Unwrap chained calls
      while (objectNode && objectNode.type === "call_expression") {
        objectNode = objectNode.childForFieldName("function");
      }

      while (objectNode && objectNode.type === "member_expression") {
        const innerObj = objectNode.childForFieldName("object");
        if (!innerObj) break;
        objectNode = innerObj;
      }

      const finalObjectName = objectNode ? source.slice(objectNode.startIndex, objectNode.endIndex) : null;

      calls.push({
        name: propNode ? source.slice(propNode.startIndex, propNode.endIndex) : null,
        objectName: finalObjectName,
        path: null
      });
    }
  });

  return calls;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(TS);
  const tree = parser.parse(source);

  const imports = [];

  traverse(tree.rootNode, (node) => {
    // ES6 imports
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        const importSource = source.slice(sourceNode.startIndex, sourceNode.endIndex).replace(/['"]/g, "");
        const importedNames = [];

        const importClause = node.namedChildren.find(n =>
          n.type === "import_clause" || n.type === "named_imports"
        );

        if (importClause) {
          traverse(importClause, (n) => {
            if (n.type === "import_specifier") {
              const name = n.childForFieldName("name");
              const alias = n.childForFieldName("alias");
              importedNames.push(alias ? source.slice(alias.startIndex, alias.endIndex) : (name ? source.slice(name.startIndex, name.endIndex) : null));
            } else if (n.type === "identifier" && n.parent.type === "import_clause") {
              importedNames.push(source.slice(n.startIndex, n.endIndex));
            }
          });
        }

        imports.push({ source: importSource, imported: importedNames });
      }
    }

    // CommonJS require
    if (node.type === "variable_declarator") {
      const init = node.childForFieldName("value");
      if (init && init.type === "call_expression") {
        const func = init.childForFieldName("function");
        if (func && source.slice(func.startIndex, func.endIndex) === "require") {
          const args = init.childForFieldName("arguments");
          if (args) {
            const firstArg = args.namedChild(0);
            if (firstArg && firstArg.type === "string") {
              const importSource = source.slice(firstArg.startIndex, firstArg.endIndex).replace(/['"]/g, "");
              const importedNames = [];

              const name = node.childForFieldName("name");
              if (name) {
                if (name.type === "identifier") {
                  importedNames.push(source.slice(name.startIndex, name.endIndex));
                } else if (name.type === "object_pattern") {
                  traverse(name, (n) => {
                    if (n.type === "shorthand_property_identifier_pattern") {
                      importedNames.push(source.slice(n.startIndex, n.endIndex));
                    } else if (n.type === "pair_pattern") {
                      const value = n.childForFieldName("value");
                      if (value && value.type === "identifier") {
                        importedNames.push(source.slice(value.startIndex, value.endIndex));
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

function resolveImportPath(importSource, currentFilePath, repoPath) {
  // External package
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return null;
  }

  // Relative path
  let resolvedPath = path.resolve(path.dirname(currentFilePath), importSource);

  // Try .ts, .tsx extensions
  if (!path.extname(resolvedPath)) {
    if (fs.existsSync(resolvedPath + ".ts")) {
      resolvedPath += ".ts";
    } else if (fs.existsSync(resolvedPath + ".tsx")) {
      resolvedPath += ".tsx";
    } else if (fs.existsSync(resolvedPath + ".js")) {
      resolvedPath += ".js";
    }
  }

  if (fs.existsSync(resolvedPath)) {
    return path.relative(repoPath, resolvedPath);
  }

  return null;
}

function extractFunctionsAndCalls(filePath, repoPath) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath);
    const imports = extractImports(filePath);

    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map imports
    imports.forEach(imp => {
      imp.imported?.forEach(imported => {
        const resolvedPath = resolveImportPath(imp.source, filePath, repoPath);
        functionMap.set(imported, resolvedPath || imp.source);
      });
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        let resolvedPath = functionMap.get(call.name);

        if (!resolvedPath && call.objectName) {
          resolvedPath = functionMap.get(call.objectName);
        }

        if (resolvedPath) {
          call.path = resolvedPath;
        }

        delete call.objectName;
      });
    });

    return functions;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return [];
  }
}

module.exports = { extractFunctionsAndCalls, extractImports };
