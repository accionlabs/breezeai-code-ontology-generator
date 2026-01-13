/**
 * Protocol Buffer (.proto) File Parser
 * Extracts services, RPCs, messages, enums
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract proto file information
 */
function extractProtoFile(filePath, repoPath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(repoPath, filePath);
  
  const result = {
    path: relativePath,
    type: 'protobuf',
    syntax: extractSyntax(content),
    package: extractPackage(content),
    goPackage: extractGoPackage(content),
    imports: extractImports(content),
    services: extractServices(content),
    messages: extractMessages(content),
    enums: extractEnums(content)
  };
  
  return result;
}

function extractSyntax(content) {
  const match = content.match(/syntax\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

function extractPackage(content) {
  const match = content.match(/package\s+([a-zA-Z0-9_.]+)\s*;/);
  return match ? match[1] : null;
}

function extractGoPackage(content) {
  const match = content.match(/option\s+go_package\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

function extractImports(content) {
  const imports = [];
  const importRegex = /import\s+["']([^"']+)["']\s*;/g;
  let match;
  
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  return imports;
}

function extractServices(content) {
  const services = [];
  const serviceRegex = /service\s+(\w+)\s*\{([^}]+)\}/g;
  let serviceMatch;
  
  while ((serviceMatch = serviceRegex.exec(content)) !== null) {
    const serviceName = serviceMatch[1];
    const serviceBody = serviceMatch[2];
    
    const rpcs = [];
    const rpcRegex = /rpc\s+(\w+)\s*\(([^)]+)\)\s*returns\s*\(([^)]+)\)/g;
    let rpcMatch;
    
    while ((rpcMatch = rpcRegex.exec(serviceBody)) !== null) {
      rpcs.push({
        name: rpcMatch[1],
        request: rpcMatch[2].trim(),
        response: rpcMatch[3].trim()
      });
    }
    
    services.push({
      name: serviceName,
      rpcs: rpcs
    });
  }
  
  return services;
}

function extractMessages(content) {
  const messages = [];
  const messageRegex = /message\s+(\w+)\s*\{([^}]+)\}/g;
  let messageMatch;
  
  while ((messageMatch = messageRegex.exec(content)) !== null) {
    const messageName = messageMatch[1];
    const messageBody = messageMatch[2];
    
    const fields = [];
    const fieldRegex = /(\w+)\s+(\w+)\s*=\s*(\d+)/g;
    let fieldMatch;
    
    while ((fieldMatch = fieldRegex.exec(messageBody)) !== null) {
      fields.push({
        type: fieldMatch[1],
        name: fieldMatch[2],
        number: parseInt(fieldMatch[3])
      });
    }
    
    messages.push({
      name: messageName,
      fields: fields
    });
  }
  
  return messages;
}

function extractEnums(content) {
  const enums = [];
  const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;
  let enumMatch;
  
  while ((enumMatch = enumRegex.exec(content)) !== null) {
    const enumName = enumMatch[1];
    const enumBody = enumMatch[2];
    
    const values = [];
    const valueRegex = /(\w+)\s*=\s*(\d+)/g;
    let valueMatch;
    
    while ((valueMatch = valueRegex.exec(enumBody)) !== null) {
      values.push({
        name: valueMatch[1],
        number: parseInt(valueMatch[2])
      });
    }
    
    enums.push({
      name: enumName,
      values: values
    });
  }
  
  return enums;
}

module.exports = {
  extractProtoFile
};
