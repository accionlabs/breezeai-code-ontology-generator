#!/usr/bin/env node
/**
 * Go File Parser using tree-sitter-go
 * Extracts packages, imports, structs, interfaces, functions, methods
 */

const Parser = require('tree-sitter');
const Go = require('tree-sitter-go');
const fs = require('fs');
const path = require('path');

/**
 * Extract package information
 */
function extractPackage(tree, sourceCode) {
  const rootNode = tree.rootNode;
  const packageClause = rootNode.children.find(child => child.type === 'package_clause');
  
  if (packageClause) {
    const packageIdentifier = packageClause.children.find(c => c.type === 'package_identifier');
    if (packageIdentifier) {
      return packageIdentifier.text;
    }
  }
  return null;
}

/**
 * Extract imports
 */
function extractImports(tree, sourceCode) {
  const imports = [];
  const rootNode = tree.rootNode;
  
  // Find all import declarations
  const importDecls = rootNode.children.filter(child => child.type === 'import_declaration');
  
  for (const importDecl of importDecls) {
    // Handle both single imports and import blocks
    const importSpecs = importDecl.descendantsOfType('import_spec');
    
    for (const spec of importSpecs) {
      const pathNode = spec.childForFieldName('path');
      if (pathNode) {
        const importPath = pathNode.text.replace(/['"]/g, '');
        
        // Get alias if exists
        const nameNode = spec.childForFieldName('name');
        const alias = nameNode ? nameNode.text : null;
        
        // Determine import type
        let type = 'external';
        if (!importPath.includes('/')) {
          type = 'standard';
        } else if (importPath.includes('github.com/hivemindd')) {
          type = 'internal';
        }
        
        imports.push({
          path: importPath,
          alias: alias,
          type: type
        });
      }
    }
  }
  
  return imports;
}

/**
 * Extract struct definitions
 */
function extractStructs(tree, sourceCode) {
  const structs = [];
  const typeDecls = tree.rootNode.descendantsOfType('type_declaration');
  
  for (const typeDecl of typeDecls) {
    const typeSpecs = typeDecl.descendantsOfType('type_spec');
    
    for (const typeSpec of typeSpecs) {
      const nameNode = typeSpec.childForFieldName('name');
      const typeNode = typeSpec.childForFieldName('type');
      
      if (typeNode && typeNode.type === 'struct_type') {
        const structName = nameNode ? nameNode.text : 'Anonymous';
        const visibility = structName[0] === structName[0].toUpperCase() ? 'public' : 'private';
        
        const fields = [];
        const fieldDecls = typeNode.descendantsOfType('field_declaration');
        
        for (const fieldDecl of fieldDecls) {
          const fieldNames = fieldDecl.childrenForFieldName('name');
          const fieldType = fieldDecl.childForFieldName('type');
          const fieldTag = fieldDecl.childForFieldName('tag');
          
          for (const fieldName of fieldNames) {
            fields.push({
              name: fieldName.text,
              type: fieldType ? fieldType.text : 'unknown',
              tag: fieldTag ? fieldTag.text : null,
              visibility: fieldName.text[0] === fieldName.text[0].toUpperCase() ? 'public' : 'private'
            });
          }
        }
        
        structs.push({
          name: structName,
          visibility: visibility,
          fields: fields,
          startLine: typeSpec.startPosition.row + 1,
          endLine: typeSpec.endPosition.row + 1
        });
      }
    }
  }
  
  return structs;
}

/**
 * Extract interface definitions
 */
function extractInterfaces(tree, sourceCode) {
  const interfaces = [];
  const typeDecls = tree.rootNode.descendantsOfType('type_declaration');
  
  for (const typeDecl of typeDecls) {
    const typeSpecs = typeDecl.descendantsOfType('type_spec');
    
    for (const typeSpec of typeSpecs) {
      const nameNode = typeSpec.childForFieldName('name');
      const typeNode = typeSpec.childForFieldName('type');
      
      if (typeNode && typeNode.type === 'interface_type') {
        const interfaceName = nameNode ? nameNode.text : 'Anonymous';
        const visibility = interfaceName[0] === interfaceName[0].toUpperCase() ? 'public' : 'private';
        
        const methods = [];
        const methodSpecs = typeNode.descendantsOfType('method_spec');
        
        for (const methodSpec of methodSpecs) {
          const methodName = methodSpec.childForFieldName('name');
          const parameters = methodSpec.childForFieldName('parameters');
          const result = methodSpec.childForFieldName('result');
          
          if (methodName) {
            methods.push({
              name: methodName.text,
              signature: methodSpec.text
            });
          }
        }
        
        interfaces.push({
          name: interfaceName,
          visibility: visibility,
          methods: methods,
          startLine: typeSpec.startPosition.row + 1,
          endLine: typeSpec.endPosition.row + 1
        });
      }
    }
  }
  
  return interfaces;
}

/**
 * Extract function and method declarations
 */
function extractFunctions(tree, sourceCode) {
  const functions = [];
  const funcDecls = tree.rootNode.descendantsOfType('function_declaration');
  const methodDecls = tree.rootNode.descendantsOfType('method_declaration');
  
  // Process regular functions
  for (const funcDecl of funcDecls) {
    const nameNode = funcDecl.childForFieldName('name');
    const parameters = funcDecl.childForFieldName('parameters');
    const result = funcDecl.childForFieldName('result');
    const body = funcDecl.childForFieldName('body');
    
    if (nameNode) {
      const funcName = nameNode.text;
      const visibility = funcName[0] === funcName[0].toUpperCase() ? 'public' : 'private';
      
      // Extract parameter names
      const params = [];
      if (parameters) {
        const paramDecls = parameters.descendantsOfType('parameter_declaration');
        for (const paramDecl of paramDecls) {
          const paramNames = paramDecl.childrenForFieldName('name');
          const paramType = paramDecl.childForFieldName('type');
          for (const paramName of paramNames) {
            params.push({
              name: paramName.text,
              type: paramType ? paramType.text : 'unknown'
            });
          }
        }
      }
      
      // Extract return types
      const returns = [];
      if (result) {
        if (result.type === 'parameter_list') {
          const returnDecls = result.descendantsOfType('parameter_declaration');
          for (const returnDecl of returnDecls) {
            const returnType = returnDecl.childForFieldName('type');
            if (returnType) {
              returns.push(returnType.text);
            }
          }
        } else {
          returns.push(result.text);
        }
      }
      
      functions.push({
        name: funcName,
        receiver: null,
        params: params,
        returns: returns,
        visibility: visibility,
        startLine: funcDecl.startPosition.row + 1,
        endLine: funcDecl.endPosition.row + 1
      });
    }
  }
  
  // Process methods (functions with receivers)
  for (const methodDecl of methodDecls) {
    const nameNode = methodDecl.childForFieldName('name');
    const receiver = methodDecl.childForFieldName('receiver');
    const parameters = methodDecl.childForFieldName('parameters');
    const result = methodDecl.childForFieldName('result');
    
    if (nameNode) {
      const methodName = nameNode.text;
      const visibility = methodName[0] === methodName[0].toUpperCase() ? 'public' : 'private';
      
      // Extract receiver type
      let receiverType = null;
      if (receiver) {
        const receiverDecl = receiver.descendantsOfType('parameter_declaration')[0];
        if (receiverDecl) {
          const receiverTypeNode = receiverDecl.childForFieldName('type');
          if (receiverTypeNode) {
            receiverType = receiverTypeNode.text.replace(/^\*/, ''); // Remove pointer prefix
          }
        }
      }
      
      // Extract parameter names
      const params = [];
      if (parameters) {
        const paramDecls = parameters.descendantsOfType('parameter_declaration');
        for (const paramDecl of paramDecls) {
          const paramNames = paramDecl.childrenForFieldName('name');
          const paramType = paramDecl.childForFieldName('type');
          for (const paramName of paramNames) {
            params.push({
              name: paramName.text,
              type: paramType ? paramType.text : 'unknown'
            });
          }
        }
      }
      
      // Extract return types
      const returns = [];
      if (result) {
        if (result.type === 'parameter_list') {
          const returnDecls = result.descendantsOfType('parameter_declaration');
          for (const returnDecl of returnDecls) {
            const returnType = returnDecl.childForFieldName('type');
            if (returnType) {
              returns.push(returnType.text);
            }
          }
        } else {
          returns.push(result.text);
        }
      }
      
      functions.push({
        name: methodName,
        receiver: receiverType,
        params: params,
        returns: returns,
        visibility: visibility,
        startLine: methodDecl.startPosition.row + 1,
        endLine: methodDecl.endPosition.row + 1
      });
    }
  }
  
  return functions;
}

/**
 * Main extraction function
 */
function extractGoFile(filePath, repoPath) {
  const sourceCode = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(repoPath, filePath);
  
  // Create parser
  const parser = new Parser();
  parser.setLanguage(Go);
  
  // Parse the file
  const tree = parser.parse(sourceCode);
  
  // Extract all components
  const result = {
    path: relativePath,
    package: extractPackage(tree, sourceCode),
    imports: extractImports(tree, sourceCode),
    structs: extractStructs(tree, sourceCode),
    interfaces: extractInterfaces(tree, sourceCode),
    functions: extractFunctions(tree, sourceCode)
  };
  
  return result;
}

module.exports = {
  extractGoFile
};
