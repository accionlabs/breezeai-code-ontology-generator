/**
 * Regex-based VB.NET Parser
 * Fallback parser when tree-sitter native bindings fail
 * Extracts classes, modules, functions, subs, properties, and imports
 */

const fs = require("fs");
const path = require("path");
const { truncateSourceCode } = require("../utils");

// Regex patterns for VB.NET constructs
const PATTERNS = {
  // Class/Module/Structure/Interface/Enum declarations
  classDeclaration: /^\s*((?:Public|Private|Protected|Friend|Protected\s+Friend)?\s*(?:MustInherit|NotInheritable|Partial)?\s*(?:Class|Module|Structure|Interface|Enum))\s+(\w+)/gmi,

  // Inherits clause
  inherits: /^\s*Inherits\s+(.+?)$/gmi,

  // Implements clause
  implements: /^\s*Implements\s+(.+?)$/gmi,

  // Function declaration
  functionDeclaration: /^\s*((?:Public|Private|Protected|Friend|Protected\s+Friend)?\s*(?:Shared|Overridable|MustOverride|Overrides|NotOverridable|Overloads)?\s*(?:Async)?\s*Function)\s+(\w+)\s*\(([^)]*)\)(?:\s+As\s+(\w+))?/gmi,

  // Sub declaration
  subDeclaration: /^\s*((?:Public|Private|Protected|Friend|Protected\s+Friend)?\s*(?:Shared|Overridable|MustOverride|Overrides|NotOverridable|Overloads)?\s*(?:Async)?\s*Sub)\s+(\w+)\s*\(([^)]*)\)/gmi,

  // Property declaration
  propertyDeclaration: /^\s*((?:Public|Private|Protected|Friend|Protected\s+Friend)?\s*(?:Shared|Overridable|MustOverride|Overrides|NotOverridable|ReadOnly|WriteOnly)?\s*Property)\s+(\w+)(?:\s*\(([^)]*)\))?(?:\s+As\s+(\w+))?/gmi,

  // Imports statement
  importsStatement: /^\s*Imports\s+(.+?)$/gmi,

  // End statements for tracking scope
  endClass: /^\s*End\s+Class/gmi,
  endModule: /^\s*End\s+Module/gmi,
  endStructure: /^\s*End\s+Structure/gmi,
  endInterface: /^\s*End\s+Interface/gmi,
  endEnum: /^\s*End\s+Enum/gmi,
  endFunction: /^\s*End\s+Function/gmi,
  endSub: /^\s*End\s+Sub/gmi,
  endProperty: /^\s*End\s+Property/gmi,

  // Event handler pattern (Handles clause)
  handlesClause: /\s+Handles\s+(.+?)$/gmi,

  // Method call pattern
  methodCall: /(?:^|[^\w])(\w+)\s*\(/gm
};

/**
 * Parse visibility from modifier string
 */
function parseVisibility(modifiers) {
  const mod = (modifiers || "").toLowerCase();
  if (mod.includes("private")) return "private";
  if (mod.includes("protected friend")) return "protected internal";
  if (mod.includes("protected")) return "protected";
  if (mod.includes("friend")) return "internal";
  return "public";
}

/**
 * Parse kind from modifier string
 */
function parseKind(modifiers) {
  const mod = (modifiers || "").toLowerCase();
  if (mod.includes("shared")) return "static";
  if (mod.includes("mustoverride")) return "abstract";
  if (mod.includes("overrides")) return "override";
  if (mod.includes("overridable")) return "virtual";
  if (mod.includes("notoverridable")) return "sealed";
  return "method";
}

/**
 * Parse parameters from parameter string
 */
function parseParameters(paramString) {
  if (!paramString || paramString.trim() === "") return [];

  const params = [];
  // Split by comma, but be careful of generic types like Dictionary(Of String, Integer)
  let depth = 0;
  let current = "";

  for (const char of paramString) {
    if (char === "(" || char === "<") depth++;
    else if (char === ")" || char === ">") depth--;
    else if (char === "," && depth === 0) {
      if (current.trim()) {
        const paramName = extractParamName(current.trim());
        if (paramName) params.push(paramName);
      }
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    const paramName = extractParamName(current.trim());
    if (paramName) params.push(paramName);
  }

  return params;
}

/**
 * Extract parameter name from parameter declaration
 */
function extractParamName(param) {
  // Pattern: [ByVal|ByRef|Optional|ParamArray] name [As Type] [= default]
  const match = param.match(/(?:ByVal|ByRef|Optional|ParamArray)?\s*(\w+)\s*(?:As|=|$)/i);
  return match ? match[1] : null;
}

/**
 * Extract function calls from code block
 */
function extractCalls(codeBlock) {
  const calls = [];
  const seen = new Set();

  // Reset lastIndex for the regex
  PATTERNS.methodCall.lastIndex = 0;

  let match;
  while ((match = PATTERNS.methodCall.exec(codeBlock)) !== null) {
    const callName = match[1];
    // Skip VB.NET keywords
    const keywords = ["If", "Then", "Else", "ElseIf", "End", "For", "Next", "While", "Do", "Loop",
                      "Select", "Case", "Try", "Catch", "Finally", "Throw", "Return", "Exit",
                      "Dim", "As", "New", "Nothing", "True", "False", "And", "Or", "Not",
                      "Is", "IsNot", "Like", "Mod", "Xor", "AndAlso", "OrElse", "GetType",
                      "TypeOf", "CType", "DirectCast", "TryCast", "CBool", "CByte", "CChar",
                      "CDate", "CDbl", "CDec", "CInt", "CLng", "CObj", "CSByte", "CShort",
                      "CSng", "CStr", "CUInt", "CULng", "CUShort", "Me", "MyBase", "MyClass"];

    if (!keywords.includes(callName) && !seen.has(callName)) {
      seen.add(callName);
      calls.push({ name: callName, path: null });
    }
  }

  return calls;
}

/**
 * Extract imports from source code
 */
function extractImportsFromSource(source) {
  const imports = {
    importsStatements: [],
    references: []
  };

  PATTERNS.importsStatement.lastIndex = 0;
  let match;

  while ((match = PATTERNS.importsStatement.exec(source)) !== null) {
    const importValue = match[1].trim();
    // Handle alias: Imports alias = Namespace
    const aliasMatch = importValue.match(/^(\w+)\s*=\s*(.+)$/);
    if (aliasMatch) {
      imports.importsStatements.push({
        source: aliasMatch[2].trim(),
        alias: aliasMatch[1].trim()
      });
    } else {
      imports.importsStatements.push({
        source: importValue,
        alias: null
      });
    }
  }

  return imports;
}

/**
 * Extract classes and their members from source code
 */
function extractClassesFromSource(source, filePath, repoPath) {
  const classes = [];
  const lines = source.split("\n");

  let currentClass = null;
  let classStartLine = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for class/module/structure/interface/enum declaration
    PATTERNS.classDeclaration.lastIndex = 0;
    const classMatch = PATTERNS.classDeclaration.exec(line);

    if (classMatch && !currentClass) {
      const modifiers = classMatch[1];
      const name = classMatch[2];
      const typeLower = modifiers.toLowerCase();

      let type = "class";
      if (typeLower.includes("module")) type = "module";
      else if (typeLower.includes("structure")) type = "structure";
      else if (typeLower.includes("interface")) type = "interface";
      else if (typeLower.includes("enum")) type = "enum";

      currentClass = {
        name,
        type,
        visibility: parseVisibility(modifiers),
        isAbstract: typeLower.includes("mustinherit"),
        extends: null,
        implements: [],
        constructorParams: [],
        methods: [],
        startLine: lineNum,
        endLine: lineNum
      };
      classStartLine = lineNum;
      braceDepth = 1;
      continue;
    }

    if (currentClass) {
      // Check for Inherits
      PATTERNS.inherits.lastIndex = 0;
      const inheritsMatch = PATTERNS.inherits.exec(line);
      if (inheritsMatch) {
        currentClass.extends = inheritsMatch[1].trim();
      }

      // Check for Implements
      PATTERNS.implements.lastIndex = 0;
      const implementsMatch = PATTERNS.implements.exec(line);
      if (implementsMatch) {
        const impls = implementsMatch[1].split(",").map(s => s.trim());
        currentClass.implements.push(...impls);
      }

      // Check for methods (Function/Sub)
      PATTERNS.functionDeclaration.lastIndex = 0;
      const funcMatch = PATTERNS.functionDeclaration.exec(line);
      if (funcMatch) {
        const methodName = funcMatch[2];
        if (!currentClass.methods.includes(methodName)) {
          currentClass.methods.push(methodName);
        }
      }

      PATTERNS.subDeclaration.lastIndex = 0;
      const subMatch = PATTERNS.subDeclaration.exec(line);
      if (subMatch) {
        const methodName = subMatch[2];
        if (!currentClass.methods.includes(methodName)) {
          currentClass.methods.push(methodName);
        }
        // Check for constructor
        if (methodName.toLowerCase() === "new") {
          currentClass.constructorParams = parseParameters(subMatch[3]);
        }
      }

      // Check for properties
      PATTERNS.propertyDeclaration.lastIndex = 0;
      const propMatch = PATTERNS.propertyDeclaration.exec(line);
      if (propMatch) {
        const propName = propMatch[2];
        if (!currentClass.methods.includes(propName)) {
          currentClass.methods.push(propName);
        }
      }

      // Check for end of class/module/structure/interface/enum
      const endPatterns = [
        { pattern: PATTERNS.endClass, type: "class" },
        { pattern: PATTERNS.endModule, type: "module" },
        { pattern: PATTERNS.endStructure, type: "structure" },
        { pattern: PATTERNS.endInterface, type: "interface" },
        { pattern: PATTERNS.endEnum, type: "enum" }
      ];

      for (const { pattern, type } of endPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line) && currentClass.type === type) {
          currentClass.endLine = lineNum;
          classes.push(currentClass);
          currentClass = null;
          break;
        }
      }
    }
  }

  // Handle unclosed class (shouldn't happen in valid code)
  if (currentClass) {
    currentClass.endLine = lines.length;
    classes.push(currentClass);
  }

  return classes;
}

/**
 * Extract functions/subs from source code
 */
function extractFunctionsFromSource(source, filePath, repoPath, captureSourceCode = false) {
  const functions = [];
  const lines = source.split("\n");

  let currentFunc = null;
  let funcStartLine = 0;
  let funcStartIndex = 0;
  let funcBody = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for function declaration
    PATTERNS.functionDeclaration.lastIndex = 0;
    const funcMatch = PATTERNS.functionDeclaration.exec(line);

    if (funcMatch && !currentFunc) {
      const modifiers = funcMatch[1];
      const name = funcMatch[2];
      const params = parseParameters(funcMatch[3]);

      currentFunc = {
        name,
        type: "function",
        visibility: parseVisibility(modifiers),
        kind: parseKind(modifiers),
        params,
        startLine: lineNum,
        endLine: lineNum,
        calls: []
      };
      funcStartLine = lineNum;
      funcStartIndex = source.indexOf(line);
      funcBody = line + "\n";
      continue;
    }

    // Check for sub declaration
    PATTERNS.subDeclaration.lastIndex = 0;
    const subMatch = PATTERNS.subDeclaration.exec(line);

    if (subMatch && !currentFunc) {
      const modifiers = subMatch[1];
      const name = subMatch[2];
      const params = parseParameters(subMatch[3]);

      currentFunc = {
        name,
        type: "sub",
        visibility: parseVisibility(modifiers),
        kind: parseKind(modifiers),
        params,
        startLine: lineNum,
        endLine: lineNum,
        calls: []
      };
      funcStartLine = lineNum;
      funcStartIndex = source.indexOf(line);
      funcBody = line + "\n";
      continue;
    }

    // Check for property declaration
    PATTERNS.propertyDeclaration.lastIndex = 0;
    const propMatch = PATTERNS.propertyDeclaration.exec(line);

    if (propMatch && !currentFunc) {
      const modifiers = propMatch[1];
      const name = propMatch[2];
      const params = parseParameters(propMatch[3] || "");

      currentFunc = {
        name,
        type: "property",
        visibility: parseVisibility(modifiers),
        kind: parseKind(modifiers),
        params,
        startLine: lineNum,
        endLine: lineNum,
        calls: []
      };
      funcStartLine = lineNum;
      funcStartIndex = source.indexOf(line);
      funcBody = line + "\n";
      continue;
    }

    if (currentFunc) {
      funcBody += line + "\n";

      // Check for end of function/sub/property
      PATTERNS.endFunction.lastIndex = 0;
      PATTERNS.endSub.lastIndex = 0;
      PATTERNS.endProperty.lastIndex = 0;

      const isEndFunc = PATTERNS.endFunction.test(line) && currentFunc.type === "function";
      const isEndSub = PATTERNS.endSub.test(line) && currentFunc.type === "sub";
      const isEndProp = PATTERNS.endProperty.test(line) && currentFunc.type === "property";

      if (isEndFunc || isEndSub || isEndProp) {
        currentFunc.endLine = lineNum;
        currentFunc.calls = extractCalls(funcBody);

        if (captureSourceCode) {
          currentFunc.sourceCode = truncateSourceCode(funcBody.trim());
        }

        functions.push(currentFunc);
        currentFunc = null;
        funcBody = "";
      }
    }
  }

  // Handle unclosed function (abstract methods, interface methods)
  if (currentFunc) {
    currentFunc.endLine = funcStartLine;
    currentFunc.calls = extractCalls(funcBody);
    if (captureSourceCode) {
      currentFunc.sourceCode = truncateSourceCode(funcBody.trim());
    }
    functions.push(currentFunc);
  }

  return functions;
}

/**
 * Main function to analyze a VB.NET file using regex
 */
function analyzeVBNetFileWithRegex(filePath, repoPath, captureSourceCode = false) {
  try {
    const source = fs.readFileSync(filePath, "utf8");

    const imports = extractImportsFromSource(source);
    const classes = extractClassesFromSource(source, filePath, repoPath);
    const functions = extractFunctionsFromSource(source, filePath, repoPath, captureSourceCode);

    return {
      imports,
      classes,
      functions
    };
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error.message);
    return {
      imports: { importsStatements: [], references: [] },
      classes: [],
      functions: []
    };
  }
}

module.exports = {
  analyzeVBNetFileWithRegex,
  extractImportsFromSource,
  extractClassesFromSource,
  extractFunctionsFromSource
};
