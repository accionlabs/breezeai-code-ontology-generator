/**
 * Vue SFC Function Extractor
 *
 * Thin wrapper around the nodejs JS extractor that operates on
 * a script block string (extracted from a .vue file) instead of
 * reading from disk.  All heavy lifting is delegated to the
 * existing tree-sitter-javascript based extractors.
 */

const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const { truncateSourceCode, containsDbQuery, getDbFromMethod, getApiCallInfo, extractEndpointFromArgs, getStatementTextLimit } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(JavaScript);

const STATEMENT_TYPES = [
  "lexical_declaration",
  "variable_declaration",
  "public_field_definition",
  "return_statement",
];

// -----------------------------------------------------------
// Tree traversal
// -----------------------------------------------------------
function traverse(node, callback) {
  callback(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    traverse(node.namedChild(i), callback);
  }
}

// -----------------------------------------------------------
// Function extraction (mirrors nodejs/extract-functions-nodejs)
// -----------------------------------------------------------
function extractFunctionsFromSource(source, lineOffset, captureSourceCode, captureStatements) {
  const tree = sharedParser.parse(source);
  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "arrow_function" ||
      node.type === "method_definition"
    ) {
      const info = extractFunctionInfo(node, source, lineOffset, captureSourceCode, captureStatements);
      if (info.name) {
        functions.push(info);
      }
    }
  });

  return { functions, tree };
}

function extractFunctionInfo(node, source, lineOffset, captureSourceCode, captureStatements) {
  const startLine = node.startPosition.row + 1 + lineOffset;
  const endLine = node.endPosition.row + 1 + lineOffset;

  const name = getFunctionName(node);
  const params = extractFunctionParams(node);
  const calls = extractDirectCalls(node);
  const { visibility, kind } = getFunctionModifiers(node);

  const statements = captureStatements ? extractStatements(node, source, lineOffset) : [];

  const result = {
    name,
    type: node.type,
    visibility,
    kind,
    params: params.map((p) => ({ name: p, type: null })),
    returnType: null,
    startLine,
    endLine,
    calls,
    statements,
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(source.slice(node.startIndex, node.endIndex));
  }

  return result;
}

function getFunctionName(node) {
  // method_definition: the name is in the "name" field
  if (node.type === "method_definition") {
    const nameNode = node.childForFieldName("name");
    return nameNode ? nameNode.text : null;
  }

  // function_declaration: function foo() {}
  const id = node.childForFieldName("name");
  if (id) return id.text;

  // Arrow/expression assigned to variable: const foo = () => {}
  if (node.parent) {
    if (node.parent.type === "variable_declarator") {
      const nameNode = node.parent.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    if (node.parent.type === "pair") {
      const keyNode = node.parent.childForFieldName("key");
      return keyNode ? keyNode.text : null;
    }
    if (node.parent.type === "assignment_expression") {
      const left = node.parent.childForFieldName("left");
      if (left) {
        if (left.type === "member_expression") {
          const prop = left.childForFieldName("property");
          return prop ? prop.text : null;
        }
        return left.text;
      }
    }
  }
  return null;
}

function extractFunctionParams(node) {
  const params = [];
  const paramsNode = node.childForFieldName("parameters") || node.childForFieldName("formal_parameters");
  if (!paramsNode) return params;

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const p = paramsNode.namedChild(i);
    if (p.type === "identifier") {
      params.push(p.text);
    } else if (p.type === "assignment_pattern") {
      const left = p.childForFieldName("left");
      params.push(left ? left.text : p.text);
    } else if (p.type === "rest_pattern" || p.type === "spread_element") {
      params.push(p.text);
    } else if (p.type === "object_pattern" || p.type === "array_pattern") {
      params.push(p.text);
    } else {
      params.push(p.text);
    }
  }
  return params;
}

function extractDirectCalls(node) {
  const calls = [];
  traverse(node, (n) => {
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (!fn) return;

      if (fn.type === "identifier") {
        calls.push({ name: fn.text, path: null });
      } else if (fn.type === "member_expression") {
        const prop = fn.childForFieldName("property");
        const obj = fn.childForFieldName("object");
        if (prop) {
          calls.push({ name: prop.text, path: obj ? obj.text : null });
        }
      }
    }
  });
  return calls;
}

function getFunctionModifiers(node) {
  let visibility = "public";
  let kind = null;

  if (node.type === "method_definition") {
    // Check for get/set keyword
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === "get") kind = "getter";
      if (child.type === "set") kind = "setter";
      if (child.type === "static") visibility = "static";
    }
  }

  return { visibility, kind };
}

// -----------------------------------------------------------
// Statement extraction
// -----------------------------------------------------------

function extractStatements(node, source, lineOffset) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (STATEMENT_TYPES.includes(child.type)) {
      statements.push({
        type: child.type,
        text: source.slice(child.startIndex, child.endIndex).slice(0, getStatementTextLimit(child)),
        startLine: child.startPosition.row + 1 + lineOffset,
        endLine: child.endPosition.row + 1 + lineOffset,
      });
    }
  }

  // Return statements from nested blocks
  collectReturnStatements(body, source, statements, body, lineOffset);

  // DB query statements
  collectQueryStatements(node, source, statements, lineOffset);

  // API call statements
  collectApiStatementsLocal(node, source, statements, lineOffset);

  return statements;
}

function collectReturnStatements(node, source, statements, functionBody, lineOffset) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "return_statement") {
      if (child.parent === functionBody) continue;
      statements.push({
        type: child.type,
        text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
        startLine: child.startPosition.row + 1 + lineOffset,
        endLine: child.endPosition.row + 1 + lineOffset,
      });
    } else {
      collectReturnStatements(child, source, statements, functionBody, lineOffset);
    }
  }
}

function collectQueryStatements(node, source, statements, lineOffset) {
  const seen = new Set(statements.map((s) => `${s.startLine}:${s.endLine}`));
  const matchedRanges = [];

  traverse(node, (n) => {
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
        // Skip if nested inside an already-matched call
        const isNested = matchedRanges.some(
          r => n.startIndex >= r.start && n.endIndex <= r.end
        );
        if (isNested) return;

        const key = `${n.startPosition.row + 1 + lineOffset}:${n.endPosition.row + 1 + lineOffset}`;
        if (!seen.has(key)) {
          seen.add(key);
          matchedRanges.push({ start: n.startIndex, end: n.endIndex });
          statements.push({
            type: "query_statement",
            db,
            text: source.slice(n.startIndex, n.endIndex).slice(0, 500),
            startLine: n.startPosition.row + 1 + lineOffset,
            endLine: n.endPosition.row + 1 + lineOffset,
          });
        }
      }
    }
  });
}

function collectApiStatementsLocal(node, source, statements, lineOffset) {
  const seen = new Set(statements.map((s) => `${s.startLine}:${s.endLine}`));
  const matchedRanges = [];

  traverse(node, (n) => {
    if (n.type !== "call_expression") return;

    const fn = n.childForFieldName("function");
    if (!fn) return;

    let objectName = null;
    let methodName = null;

    if (fn.type === "identifier") {
      methodName = fn.text;
    } else if (fn.type === "member_expression") {
      const obj = fn.childForFieldName("object");
      const prop = fn.childForFieldName("property");
      objectName = obj ? obj.text : null;
      methodName = prop ? prop.text : null;
    }

    const apiInfo = getApiCallInfo(objectName, methodName);
    if (!apiInfo) return;

    // Skip if nested inside an already-matched API call
    const isNested = matchedRanges.some(
      r => n.startIndex >= r.start && n.endIndex <= r.end
    );
    if (isNested) return;

    const key = `${n.startPosition.row + 1 + lineOffset}:${n.endPosition.row + 1 + lineOffset}`;
    if (seen.has(key)) return;
    seen.add(key);
    matchedRanges.push({ start: n.startIndex, end: n.endIndex });

    const args = n.childForFieldName("arguments");
    const endpoint = extractEndpointFromArgs(args, source);

    statements.push({
      type: "api_call",
      method: apiInfo.httpMethod,
      endpoint,
      text: source.slice(n.startIndex, n.endIndex).slice(0, 500),
      startLine: n.startPosition.row + 1 + lineOffset,
      endLine: n.endPosition.row + 1 + lineOffset,
    });
  });
}

// -----------------------------------------------------------
// File-level statement extraction (for script block)
// -----------------------------------------------------------
function extractFileStatementsFromSource(source, lineOffset) {
  const tree = sharedParser.parse(source);
  const statements = [];

  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex).slice(0, getStatementTextLimit(child)),
      startLine: child.startPosition.row + 1 + lineOffset,
      endLine: child.endPosition.row + 1 + lineOffset,
    });
  }

  // NOTE: query_statement and api_call are NOT collected here.
  // They are already captured inside each function's own statements.
  // Collecting them here would cause duplicates.

  return statements;
}

// -----------------------------------------------------------
// Import extraction from source
// -----------------------------------------------------------
function extractImportsFromSource(source) {
  const tree = sharedParser.parse(source);
  const imports = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_statement") {
      const moduleNode = node.namedChildren.find((n) => n.type === "string");
      if (moduleNode) {
        const raw = source.slice(moduleNode.startIndex, moduleNode.endIndex).replace(/['"]/g, "");
        imports.push({ source: raw });
      }
    }

    if (node.type === "call_expression") {
      const funcNode = node.namedChildren[0];
      const argNode = node.namedChildren[1]?.namedChild(0);
      if (
        funcNode &&
        funcNode.type === "identifier" &&
        funcNode.text === "require" &&
        argNode &&
        argNode.type === "string"
      ) {
        const raw = source.slice(argNode.startIndex, argNode.endIndex).replace(/['"]/g, "");
        imports.push({ source: raw });
      }
    }
  });

  return imports;
}

module.exports = {
  sharedParser,
  extractFunctionsFromSource,
  extractFileStatementsFromSource,
  extractImportsFromSource,
};
