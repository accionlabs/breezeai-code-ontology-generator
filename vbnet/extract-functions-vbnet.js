const fs = require("fs");
const path = require("path");
const { truncateSourceCode } = require("../utils");

/**
 * VB.NET Function/Sub Extractor
 * Uses regex-based parsing for VB.NET constructs
 */

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const functions = [];

  let currentFunction = null;
  let functionStartLine = 0;
  let functionLines = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmedLine = line.trim();

    // Skip comments
    if (trimmedLine.startsWith("'")) {
      continue;
    }

    // Match Sub declarations (including Sub New for constructors)
    const subMatch = trimmedLine.match(
      /^((?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|Overloads|Shadows|Partial)\s+)*Sub\s+(\w+)\s*\(([^)]*)\)/i
    );

    if (subMatch && !currentFunction) {
      const modifiers = (subMatch[1] || "").toLowerCase();
      const name = subMatch[2];
      const params = parseParameters(subMatch[3]);

      currentFunction = {
        name,
        type: name.toLowerCase() === "new" ? "constructor" : "sub",
        visibility: extractVisibility(modifiers),
        kind: modifiers.includes("shared") ? "static" : "instance",
        params,
        startLine: lineNum,
        endLine: null,
        calls: []
      };
      functionStartLine = i;
      functionLines = [line];
      depth = 1;
      continue;
    }

    // Match Function declarations
    const funcMatch = trimmedLine.match(
      /^((?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|Overloads|Shadows)\s+)*Function\s+(\w+)\s*\(([^)]*)\)/i
    );

    if (funcMatch && !currentFunction) {
      const modifiers = (funcMatch[1] || "").toLowerCase();
      const name = funcMatch[2];
      const params = parseParameters(funcMatch[3]);

      currentFunction = {
        name,
        type: "function",
        visibility: extractVisibility(modifiers),
        kind: modifiers.includes("shared") ? "static" : "instance",
        params,
        startLine: lineNum,
        endLine: null,
        calls: []
      };
      functionStartLine = i;
      functionLines = [line];
      depth = 1;
      continue;
    }

    // Match Property Get/Set
    const propMatch = trimmedLine.match(
      /^((?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|ReadOnly|WriteOnly|Default)\s+)*Property\s+(\w+)/i
    );

    if (propMatch && !currentFunction) {
      const modifiers = (propMatch[1] || "").toLowerCase();
      const name = propMatch[2];

      currentFunction = {
        name,
        type: "property",
        visibility: extractVisibility(modifiers),
        kind: modifiers.includes("shared") ? "static" : "instance",
        params: [],
        startLine: lineNum,
        endLine: null,
        calls: []
      };
      functionStartLine = i;
      functionLines = [line];
      depth = 1;
      continue;
    }

    // If we're inside a function
    if (currentFunction) {
      functionLines.push(line);

      // Track nested blocks
      if (trimmedLine.match(/^(If|For|While|Do|Select|Try|Using|With|SyncLock)\b/i)) {
        depth++;
      }

      // Extract function calls
      extractCallsFromLine(trimmedLine, currentFunction.calls);

      // Match End Sub/Function/Property
      const endMatch = trimmedLine.match(/^End\s+(Sub|Function|Property)/i);
      if (endMatch) {
        depth--;
        if (depth === 0) {
          currentFunction.endLine = lineNum;

          if (captureSourceCode) {
            currentFunction.sourceCode = truncateSourceCode(functionLines.join("\n"));
          }

          // Don't add Sub New as a regular function (it's tracked in class constructorParams)
          if (currentFunction.name.toLowerCase() !== "new") {
            functions.push(currentFunction);
          }

          currentFunction = null;
          functionLines = [];
        }
      }

      // Handle other End statements
      if (trimmedLine.match(/^End\s+(If|For|While|Select|Try|Using|With|SyncLock)/i)) {
        depth--;
      }
    }
  }

  return functions;
}

function extractCallsFromLine(line, calls) {
  // Match method calls: object.Method(args) or Method(args)
  const callRegex = /(\w+)\.(\w+)\s*\(/g;
  let match;

  while ((match = callRegex.exec(line)) !== null) {
    const objectName = match[1];
    const methodName = match[2];

    // Skip common VB.NET keywords that look like method calls
    const keywords = ["if", "for", "while", "select", "case", "dim", "return", "throw", "new", "me", "mybase", "myclass"];
    if (!keywords.includes(objectName.toLowerCase())) {
      calls.push({
        name: methodName,
        objectName,
        path: null
      });
    }
  }

  // Match standalone function calls: FunctionName(args)
  const standaloneRegex = /(?<![.\w])(\w+)\s*\(/g;
  while ((match = standaloneRegex.exec(line)) !== null) {
    const funcName = match[1];

    // Skip VB.NET keywords and already captured calls
    const keywords = ["if", "for", "while", "select", "case", "dim", "return", "throw", "new", "sub", "function", "property", "class", "module", "structure", "interface", "enum", "inherits", "implements", "imports", "namespace", "end", "try", "catch", "finally", "using", "with", "synclock", "redim", "erase", "cbool", "cbyte", "cchar", "cdate", "cdbl", "cdec", "cint", "clng", "cobj", "csbyte", "cshort", "csng", "cstr", "cuint", "culng", "cushort", "ctype", "directcast", "trycast", "typeof", "gettype", "nameof", "addressof"];

    if (!keywords.includes(funcName.toLowerCase())) {
      // Check if this isn't already captured as a method call
      const alreadyCaptured = calls.some(c => c.name === funcName);
      if (!alreadyCaptured) {
        calls.push({
          name: funcName,
          objectName: null,
          path: null
        });
      }
    }
  }
}

function extractVisibility(modifiers) {
  const lower = modifiers.toLowerCase();
  if (lower.includes("public")) return "public";
  if (lower.includes("private")) return "private";
  if (lower.includes("protected friend")) return "protected internal";
  if (lower.includes("protected")) return "protected";
  if (lower.includes("friend")) return "internal";
  return "public";
}

function parseParameters(paramString) {
  if (!paramString || paramString.trim() === "") {
    return [];
  }

  const params = [];
  const parts = paramString.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Match: [Optional] [ByVal|ByRef] [ParamArray] paramName As Type [= default]
    const match = trimmed.match(/(?:Optional\s+)?(?:ByVal|ByRef)?\s*(?:ParamArray\s+)?(\w+)\s*(?:As\s+\w+)?/i);
    if (match) {
      // Check for ParamArray (VB.NET's equivalent of params)
      if (trimmed.toLowerCase().includes("paramarray")) {
        params.push("..." + match[1]);
      } else {
        params.push(match[1]);
      }
    }
  }

  return params;
}

// Extract Imports statements
function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);

  const imports = {
    importFiles: [],
    externalImports: []
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Match Imports statements
    // Imports System.Collections.Generic
    // Imports MyNamespace = SomeOther.Namespace
    const importMatch = trimmedLine.match(/^Imports\s+(?:(\w+)\s*=\s*)?(.+)/i);

    if (importMatch) {
      const namespace = importMatch[2].trim();
      imports.externalImports.push(namespace);
    }
  }

  imports.externalImports = [...new Set(imports.externalImports)];

  return imports;
}

function resolveCallPath(call, index, currentFilePath) {
  const { classIndex, methodIndex } = index;

  if (call.objectName) {
    // Case-insensitive lookup for VB.NET
    const objectNameLower = call.objectName.toLowerCase();
    const classKey = Object.keys(classIndex).find(k => k.toLowerCase() === objectNameLower);

    if (classKey && classIndex[classKey].length > 0) {
      const methodNameLower = call.name.toLowerCase();
      const methodKey = Object.keys(methodIndex).find(k => k.toLowerCase() === methodNameLower);

      if (methodKey && methodIndex[methodKey]) {
        const methodEntry = methodIndex[methodKey].find(m =>
          m.className.toLowerCase() === objectNameLower
        );
        if (methodEntry) {
          return methodEntry.filePath;
        }
      }
      return classIndex[classKey][0];
    }
  }

  if (call.name && methodIndex) {
    const methodNameLower = call.name.toLowerCase();
    const methodKey = Object.keys(methodIndex).find(k => k.toLowerCase() === methodNameLower);

    if (methodKey && methodIndex[methodKey]) {
      const methodEntries = methodIndex[methodKey];

      if (methodEntries.length === 1) {
        return methodEntries[0].filePath;
      }

      const otherFileEntry = methodEntries.find(m => m.filePath !== currentFilePath);
      if (otherFileEntry) {
        return otherFileEntry.filePath;
      }

      return methodEntries[0].filePath;
    }
  }

  return null;
}

function extractFunctionsAndCalls(filePath, repoPath, index = {}, captureSourceCode = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode);
    const currentFilePath = path.relative(repoPath, filePath);

    const { classIndex = {}, methodIndex = {} } = index;

    // Build local function map (case-insensitive)
    const localFunctionMap = new Map();
    functions.forEach(func => {
      localFunctionMap.set(func.name.toLowerCase(), currentFilePath);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        const callNameLower = call.name.toLowerCase();

        if (localFunctionMap.has(callNameLower) && !call.objectName) {
          call.path = currentFilePath;
        } else {
          const resolvedPath = resolveCallPath(call, { classIndex, methodIndex }, currentFilePath);
          if (resolvedPath) {
            call.path = resolvedPath;
          }
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
