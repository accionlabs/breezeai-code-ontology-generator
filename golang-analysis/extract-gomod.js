/**
 * go.mod File Parser
 * Extracts module name, Go version, dependencies
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract go.mod file information
 */
function extractGoModFile(filePath, repoPath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(repoPath, filePath);
  
  const result = {
    path: relativePath,
    type: 'go_module',
    module: extractModule(content),
    goVersion: extractGoVersion(content),
    dependencies: extractDependencies(content),
    replaces: extractReplaces(content)
  };
  
  return result;
}

function extractModule(content) {
  const match = content.match(/^module\s+(\S+)/m);
  return match ? match[1] : null;
}

function extractGoVersion(content) {
  const match = content.match(/^go\s+([\d.]+)/m);
  return match ? match[1] : null;
}

function extractDependencies(content) {
  const dependencies = {
    direct: [],
    indirect: []
  };
  
  // Match require block
  const requireBlockMatch = content.match(/require\s+\(([\s\S]*?)\)/);
  if (requireBlockMatch) {
    const requireBlock = requireBlockMatch[1];
    const lines = requireBlock.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      
      const match = trimmed.match(/^([^\s]+)\s+([^\s]+)(?:\s+\/\/\s*indirect)?/);
      if (match) {
        const dep = {
          name: match[1],
          version: match[2]
        };
        
        if (trimmed.includes('// indirect')) {
          dependencies.indirect.push(dep);
        } else {
          dependencies.direct.push(dep);
        }
      }
    }
  }
  
  // Match single-line requires
  const singleRequireRegex = /^require\s+([^\s]+)\s+([^\s]+)(?:\s+\/\/\s*indirect)?/gm;
  let match;
  
  while ((match = singleRequireRegex.exec(content)) !== null) {
    const dep = {
      name: match[1],
      version: match[2]
    };
    
    if (match[0].includes('// indirect')) {
      dependencies.indirect.push(dep);
    } else {
      dependencies.direct.push(dep);
    }
  }
  
  return dependencies;
}

function extractReplaces(content) {
  const replaces = [];
  const replaceRegex = /^replace\s+([^\s]+)(?:\s+([^\s]+))?\s+=>\s+([^\s]+)(?:\s+([^\s]+))?/gm;
  let match;
  
  while ((match = replaceRegex.exec(content)) !== null) {
    replaces.push({
      old: {
        name: match[1],
        version: match[2] || null
      },
      new: {
        name: match[3],
        version: match[4] || null
      }
    });
  }
  
  return replaces;
}

module.exports = {
  extractGoModFile
};
