const Parser = require("tree-sitter");
const Java = require("tree-sitter-java");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode, parseSource, readSource, containsDbQuery, getDbFromMethod, getStatementTextLimit } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Java);

const STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "enum_declaration", "return_statement"];

function extractFunctionsWithCalls(filePath, repoPath = null, classIndex = {}, captureSourceCode = false, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "method_declaration" ||
      node.type === "constructor_declaration"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode, captureStatements);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source, captureSourceCode = false, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind } = getFunctionModifiers(node, source);
  const decorators = readDecorators(node, source);

  const statements = captureStatements ? extractStatements(node, source) : [];

  const result = {
    name,
    type: node.type === "constructor_declaration" ? "constructor" : "method",
    visibility,
    kind,
    decorators,  // [{ name, args }] — method-level annotations (with args)
    params,  // Now returns string array
    startLine,
    endLine,
    calls,
    statements
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(source.slice(node.startIndex, node.endIndex));
  }

  return result;
}

function getFunctionModifiers(node, source) {
  let visibility = "package"; // Java default
  let kind = "instance";

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === "modifiers") {
      // Iterate through modifier tokens
      for (let j = 0; j < child.childCount; j++) {
        const modifier = child.child(j);
        const modText = source.slice(modifier.startIndex, modifier.endIndex);

        if (modText === "public") {
          visibility = "public";
        } else if (modText === "private") {
          visibility = "private";
        } else if (modText === "protected") {
          visibility = "protected";
        } else if (modText === "static") {
          kind = "static";
        }
      }
    }
  }

  return { visibility, kind };
}

// -------------------------------------------------------------------
// Decorator (annotation) reading — structured { name, args }.
// Annotations live inside a `modifiers` child of the declaration and come in
// two grammar forms: `marker_annotation` (@Foo) and `annotation` (@Foo(...)).
// `name` is the simple (last) segment of a possibly-qualified name; `args` is
// one entry per top-level argument (string literals unwrapped, everything else
// kept as faithful source text).
// -------------------------------------------------------------------
function readDecorators(node, source) {
  const decorators = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== "modifiers") continue;
    for (let j = 0; j < child.childCount; j++) {
      const ann = child.child(j);
      if (ann.type !== "annotation" && ann.type !== "marker_annotation") continue;
      const name = annotationName(ann, source);
      if (name) decorators.push({ name, args: annotationArgs(ann, source) });
    }
  }
  return decorators;
}

function annotationName(ann, source) {
  const nameNode = ann.childForFieldName("name");
  if (!nameNode) return null;
  const txt = source.slice(nameNode.startIndex, nameNode.endIndex);
  return txt.slice(txt.lastIndexOf(".") + 1);
}

function annotationArgs(ann, source) {
  const argsNode = ann.childForFieldName("arguments"); // annotation_argument_list
  if (!argsNode) return [];
  const args = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    if (a.type === "string_literal") {
      args.push(stringLiteralValue(a, source));
    } else {
      args.push(source.slice(a.startIndex, a.endIndex));
    }
  }
  return args;
}

// Decode a Java escape_sequence node's text (e.g. "\\d" -> "\d", "\\u002F" -> "/").
function decodeJavaEscape(seq) {
  if (!seq || seq.length < 2) return seq || "";
  const c = seq[1];
  switch (c) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "b": return "\b";
    case "f": return "\f";
    case "0": return "\0";
    case "\\": return "\\";
    case "'": return "'";
    case '"': return '"';
    case "u": {
      const code = parseInt(seq.slice(2), 16);
      return Number.isNaN(code) ? seq : String.fromCharCode(code);
    }
    default: return seq.slice(1);
  }
}

// Literal value of a string_literal node: string_fragment parts plus decoded
// escape sequences (so escaped chars in decorator args survive).
function stringLiteralValue(node, source) {
  let out = "";
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type === "string_fragment") {
      out += source.slice(c.startIndex, c.endIndex);
    } else if (c.type === "escape_sequence") {
      out += decodeJavaEscape(source.slice(c.startIndex, c.endIndex));
    }
  }
  return out;
}

// Returns [{ name, type, decorators? }] (guide §7). `type` is the declared type
// text (varargs marked with a trailing `...`); `decorators` is present-only —
// captures param annotations like @PathVariable / @RequestParam / @RequestBody
// (Spring) and @PathParam / @QueryParam (JAX-RS).
function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child.isNamed) continue;
    if (child.type !== "formal_parameter" && child.type !== "spread_parameter") continue;

    const name = paramName(child, source);
    if (!name) continue;

    let type = paramType(child, source);
    // varargs: mark with Java's `...` notation instead of prefixing the name.
    if (child.type === "spread_parameter" && type) type += "...";

    const param = { name, type };
    const decorators = readDecorators(child, source);
    if (decorators.length) param.decorators = decorators; // present-only
    params.push(param);
  }

  return params;
}

// Parameter name. For `spread_parameter` (varargs) the name lives inside a
// `variable_declarator`, not on a direct `name` field.
function paramName(child, source) {
  let nameNode = child.childForFieldName("name");
  if (!nameNode) {
    for (let i = 0; i < child.childCount; i++) {
      if (child.child(i).type === "variable_declarator") {
        nameNode = child.child(i).childForFieldName("name");
        break;
      }
    }
  }
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

// Parameter type text. `formal_parameter` exposes a `type` field; `spread_parameter`
// (varargs) does not — its type is the positional child before the declarator.
function paramType(child, source) {
  let typeNode = child.childForFieldName("type");
  if (!typeNode && child.type === "spread_parameter") {
    for (let i = 0; i < child.childCount; i++) {
      const c = child.child(i);
      if (!c.isNamed) continue;
      if (c.type === "variable_declarator" || c.type === "modifiers" ||
          c.type === "annotation" || c.type === "marker_annotation") continue;
      typeNode = c;
      break;
    }
  }
  return typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : null;
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type === "method_invocation") {
      const callInfo = extractCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
  });

  return calls;
}

function extractCallInfo(node, source) {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

  // Try to get the object if it's a method call
  const objectNode = node.childForFieldName("object");
  let objectName = null;

  if (objectNode) {
    // Handle chained calls - get the root object
    let current = objectNode;
    while (current && current.type === "method_invocation") {
      const obj = current.childForFieldName("object");
      if (obj) {
        current = obj;
      } else {
        break;
      }
    }

    if (current && current.type === "identifier") {
      objectName = source.slice(current.startIndex, current.endIndex);
    } else if (current) {
      objectName = source.slice(current.startIndex, current.endIndex);
    }
  }

  return {
    name: methodName,
    objectName: objectName,
    path: null // Will be resolved later
  };
}

function extractStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (STATEMENT_TYPES.includes(child.type)) {
      statements.push({
        type: child.type,
        text: source.slice(child.startIndex, child.endIndex).slice(0, getStatementTextLimit(child)),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    }
  }

  // Collect return statements from nested blocks (if/else, loops, try/catch, etc.)
  collectReturnStatements(body, source, statements, body);

  collectQueryStatements(node, source, statements);

  return statements;
}

function collectReturnStatements(node, source, statements, functionBody) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "return_statement") {
      // Skip if already captured as direct child of function body
      if (child.parent === functionBody) continue;
      statements.push({
        type: child.type,
        text: source.slice(child.startIndex, child.endIndex).slice(0, getStatementTextLimit(child)),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    } else {
      collectReturnStatements(child, source, statements, functionBody);
    }
  }
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// Extract imports from a file
function extractImports(filePath, classIndex) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const imports = {
    importFiles: [],
    externalImports: []
  };

  // Repo-relative file paths, used for layout-agnostic suffix matching when the
  // path-derived FQCN index misses (see classifyImport).
  const fileList = [...new Set(Object.values(classIndex))];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_declaration") {
      // Strip the leading `import`/`static` keywords and trailing `;` without
      // touching package segments that merely contain those substrings
      // (e.g. `com.importantthing.Foo`).
      const importText = source.slice(node.startIndex, node.endIndex)
        .replace(/^\s*import\s+(?:static\s+)?/, "")
        .replace(/\s*;.*$/, "")
        .trim();

      const resolved = classifyImport(importText, classIndex, fileList);
      if (resolved.type === "local") {
        imports.importFiles.push(...resolved.values);
      } else {
        imports.externalImports.push(...resolved.values);
      }
    }
  });

  imports.importFiles = [...new Set(imports.importFiles)];
  imports.externalImports = [...new Set(imports.externalImports)];

  return imports;
}

/**
 * Match an import path against the repo file list by path suffix, so imports
 * resolve regardless of the source-root layout (Maven `src/main/java/`, Bazel
 * `java/`, plain `src/`, a package root at the repo root, etc.). `com.example.Foo`
 * matches any file whose path == or ends with `/com/example/Foo.java`.
 */
function suffixMatchFiles(dottedPath, fileList) {
  const suffix = dottedPath.replace(/\./g, "/") + ".java";
  return fileList.filter(f => f === suffix || f.endsWith("/" + suffix));
}

function classifyImport(importName, classIndex, fileList = []) {
  // Java standard library
  if (isJavaStdLib(importName)) {
    return { type: "external", values: [importName] };
  }

  // Wildcard import
  if (importName.endsWith(".*")) {
    const prefix = importName.replace(".*", "");

    let matched = Object.entries(classIndex)
      .filter(([fqcn]) => fqcn.startsWith(prefix + "."))
      .map(([_, file]) => file);

    // Layout-agnostic fallback: any file under the imported package directory.
    if (matched.length === 0) {
      const dir = prefix.replace(/\./g, "/") + "/";
      matched = fileList.filter(
        f => (f.startsWith(dir) || f.includes("/" + dir)) &&
             f.slice(f.indexOf(dir) + dir.length).indexOf("/") === -1
      );
    }

    if (matched.length > 0) {
      return { type: "local", values: matched };
    }

    return { type: "external", values: [importName] };
  }

  // Exact class import
  if (classIndex[importName]) {
    return {
      type: "local",
      values: [classIndex[importName]]
    };
  }

  // Layout-agnostic fallback: match the import path against the repo file list
  // by suffix (handles non-Maven source roots the FQCN index doesn't strip).
  const suffixMatched = suffixMatchFiles(importName, fileList);
  if (suffixMatched.length > 0) {
    return { type: "local", values: suffixMatched };
  }

  // Unresolved → external dependency
  return { type: "external", values: [importName] };
}

function isJavaStdLib(name) {
  return (
    name.startsWith("java.") ||
    name.startsWith("javax.") ||
    name.startsWith("jakarta.")
  );
}

function extractFunctionsAndCalls(filePath, repoPath, classIndex, captureSourceCode = false, captureStatements = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, classIndex, captureSourceCode, captureStatements);
    const imports = extractImports(filePath, classIndex);

    // Build function and class map for call resolution
    const source = readSource(filePath);
    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map imports
    imports.importFiles.forEach(importedFile => {
      const className = path.basename(importedFile, '.java');
      functionMap.set(className, importedFile);
    });

    imports.externalImports.forEach(extImport => {
      const parts = extImport.split('.');
      const className = parts[parts.length - 1];
      functionMap.set(className, extImport);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        // Try to resolve by method name first, then by object name
        let resolvedPath = functionMap.get(call.name);

        if (!resolvedPath && call.objectName) {
          resolvedPath = functionMap.get(call.objectName);
        }

        if (resolvedPath) {
          call.path = resolvedPath;
        }

        // Clean up temporary fields
        delete call.objectName;
      });
    });

    return functions;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return [];
  }
}

function extractFileStatements(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);
  const statements = [];
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex).slice(0, getStatementTextLimit(child)),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  collectQueryStatements(tree.rootNode, source, statements);

  return statements;
}

function collectQueryStatements(node, source, statements) {
  const seen = new Set(
    statements
      .filter(s => s.type === 'query_statement' || s.type === 'db_method_call')
      .map(s => `${s.startLine}:${s.endLine}`)
  );

  traverse(node, (n) => {
    if (n.type === "method_invocation") {
      const nameNode = n.childForFieldName("name");
      const methodName = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;

      const db = getDbFromMethod(methodName);
      if (db) {
        const key = `${n.startPosition.row + 1}:${n.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "db_method_call", db,
            text: source.slice(n.startIndex, n.endIndex).slice(0, 500),
            startLine: n.startPosition.row + 1,
            endLine: n.endPosition.row + 1,
          });
        }
        return;
      }
    }

    if (n.type === "string_literal" || n.type === "text_block") {
      const text = source.slice(n.startIndex, n.endIndex);
      if (containsDbQuery(text)) {
        const key = `${n.startPosition.row + 1}:${n.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "query_statement",
            text: text.slice(0, 500),
            startLine: n.startPosition.row + 1,
            endLine: n.endPosition.row + 1,
          });
        }
      }
    }
  });
}

module.exports = { extractFunctionsAndCalls, extractImports, extractFileStatements, collectQueryStatements };
