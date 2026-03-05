const fs = require("fs");
const path = require("path");

/**
 * VB.NET Class/Module/Structure/Interface Extractor
 * Uses regex-based parsing for VB.NET constructs
 */

function extractClasses(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const classes = [];

  // Track nesting level and current class
  let currentClass = null;
  let classStack = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmedLine = line.trim();

    // Skip comments and empty lines for declaration matching
    if (trimmedLine.startsWith("'") || trimmedLine === "") {
      continue;
    }

    // Match class declarations
    // Public Class ClassName
    // Public MustInherit Class ClassName
    // Public NotInheritable Class ClassName
    // Partial Public Class ClassName
    const classMatch = trimmedLine.match(
      /^((?:Partial\s+)?(?:Public|Private|Protected|Friend|Protected\s+Friend)?\s*(?:MustInherit|NotInheritable)?\s*Class)\s+(\w+)/i
    );

    if (classMatch) {
      const modifiers = classMatch[1].toLowerCase();
      const className = classMatch[2];

      const classInfo = {
        name: className,
        type: "class",
        visibility: extractVisibility(modifiers),
        isAbstract: modifiers.includes("mustinherit"),
        isSealed: modifiers.includes("notinheritable"),
        isPartial: modifiers.includes("partial"),
        extends: null,
        implements: [],
        constructorParams: [],
        methods: [],
        startLine: lineNum,
        endLine: null
      };

      if (currentClass) {
        classStack.push(currentClass);
      }
      currentClass = classInfo;
      braceDepth++;
      continue;
    }

    // Match Module declarations (VB.NET modules are like static classes)
    const moduleMatch = trimmedLine.match(
      /^((?:Public|Private|Friend)?\s*Module)\s+(\w+)/i
    );

    if (moduleMatch) {
      const modifiers = moduleMatch[1].toLowerCase();
      const moduleName = moduleMatch[2];

      const moduleInfo = {
        name: moduleName,
        type: "module",
        visibility: extractVisibility(modifiers),
        isAbstract: false,
        extends: null,
        implements: [],
        constructorParams: [],
        methods: [],
        startLine: lineNum,
        endLine: null
      };

      if (currentClass) {
        classStack.push(currentClass);
      }
      currentClass = moduleInfo;
      braceDepth++;
      continue;
    }

    // Match Structure declarations (like C# struct)
    const structMatch = trimmedLine.match(
      /^((?:Public|Private|Protected|Friend)?\s*Structure)\s+(\w+)/i
    );

    if (structMatch) {
      const modifiers = structMatch[1].toLowerCase();
      const structName = structMatch[2];

      const structInfo = {
        name: structName,
        type: "structure",
        visibility: extractVisibility(modifiers),
        isAbstract: false,
        extends: null,
        implements: [],
        constructorParams: [],
        methods: [],
        startLine: lineNum,
        endLine: null
      };

      if (currentClass) {
        classStack.push(currentClass);
      }
      currentClass = structInfo;
      braceDepth++;
      continue;
    }

    // Match Interface declarations
    const interfaceMatch = trimmedLine.match(
      /^((?:Public|Private|Protected|Friend)?\s*Interface)\s+(\w+)/i
    );

    if (interfaceMatch) {
      const modifiers = interfaceMatch[1].toLowerCase();
      const interfaceName = interfaceMatch[2];

      const interfaceInfo = {
        name: interfaceName,
        type: "interface",
        visibility: extractVisibility(modifiers),
        isAbstract: true,
        extends: null,
        implements: [],
        constructorParams: [],
        methods: [],
        startLine: lineNum,
        endLine: null
      };

      if (currentClass) {
        classStack.push(currentClass);
      }
      currentClass = interfaceInfo;
      braceDepth++;
      continue;
    }

    // Match Enum declarations
    const enumMatch = trimmedLine.match(
      /^((?:Public|Private|Protected|Friend)?\s*Enum)\s+(\w+)/i
    );

    if (enumMatch) {
      const modifiers = enumMatch[1].toLowerCase();
      const enumName = enumMatch[2];

      const enumInfo = {
        name: enumName,
        type: "enum",
        visibility: extractVisibility(modifiers),
        isAbstract: false,
        extends: null,
        implements: [],
        constructorParams: [],
        methods: [],
        startLine: lineNum,
        endLine: null
      };

      if (currentClass) {
        classStack.push(currentClass);
      }
      currentClass = enumInfo;
      braceDepth++;
      continue;
    }

    // If we're inside a class/module/structure
    if (currentClass) {
      // Match Inherits statement
      const inheritsMatch = trimmedLine.match(/^Inherits\s+(.+)/i);
      if (inheritsMatch) {
        currentClass.extends = inheritsMatch[1].trim();
        continue;
      }

      // Match Implements statement
      const implementsMatch = trimmedLine.match(/^Implements\s+(.+)/i);
      if (implementsMatch) {
        const interfaces = implementsMatch[1].split(",").map(s => s.trim());
        currentClass.implements.push(...interfaces);
        continue;
      }

      // Match Sub New (constructor)
      const constructorMatch = trimmedLine.match(
        /^(?:Public|Private|Protected|Friend)?\s*Sub\s+New\s*\(([^)]*)\)/i
      );
      if (constructorMatch) {
        const params = parseParameters(constructorMatch[1]);
        currentClass.constructorParams = params;
        continue;
      }

      // Match Sub declarations
      const subMatch = trimmedLine.match(
        /^(?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared)?\s*Sub\s+(\w+)\s*\(/i
      );
      if (subMatch && subMatch[1].toLowerCase() !== "new") {
        currentClass.methods.push(subMatch[1]);
        continue;
      }

      // Match Function declarations
      const funcMatch = trimmedLine.match(
        /^(?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared)?\s*Function\s+(\w+)\s*\(/i
      );
      if (funcMatch) {
        currentClass.methods.push(funcMatch[1]);
        continue;
      }

      // Match Property declarations
      const propMatch = trimmedLine.match(
        /^(?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|ReadOnly|WriteOnly)?\s*Property\s+(\w+)/i
      );
      if (propMatch) {
        currentClass.methods.push(propMatch[1]);
        continue;
      }

      // Match End Class/Module/Structure/Interface/Enum
      const endMatch = trimmedLine.match(/^End\s+(Class|Module|Structure|Interface|Enum)/i);
      if (endMatch) {
        currentClass.endLine = lineNum;
        classes.push(currentClass);
        braceDepth--;

        if (classStack.length > 0) {
          currentClass = classStack.pop();
        } else {
          currentClass = null;
        }
        continue;
      }
    }
  }

  return classes;
}

function extractVisibility(modifiers) {
  const lower = modifiers.toLowerCase();
  if (lower.includes("public")) return "public";
  if (lower.includes("private")) return "private";
  if (lower.includes("protected friend")) return "protected internal";
  if (lower.includes("protected")) return "protected";
  if (lower.includes("friend")) return "internal";
  return "public"; // VB.NET default
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

    // Match: [ByVal|ByRef] paramName As Type [= default]
    const match = trimmed.match(/(?:ByVal|ByRef)?\s*(\w+)\s*(?:As\s+\w+)?/i);
    if (match) {
      params.push(match[1]);
    }
  }

  return params;
}

module.exports = { extractClasses };
