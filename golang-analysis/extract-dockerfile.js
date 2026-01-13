/**
 * Dockerfile Parser
 * Extracts base images, stages, commands, environment variables
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract Dockerfile information
 */
function extractDockerfile(filePath, repoPath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(repoPath, filePath);
  
  const result = {
    path: relativePath,
    type: 'dockerfile',
    baseImages: extractBaseImages(content),
    stages: extractStages(content),
    exposedPorts: extractExposedPorts(content),
    volumes: extractVolumes(content),
    entrypoint: extractEntrypoint(content),
    cmd: extractCmd(content),
    env: extractEnv(content),
    workdir: extractWorkdir(content)
  };
  
  return result;
}

function extractBaseImages(content) {
  const images = [];
  const fromRegex = /^FROM\s+([^\s]+)(?:\s+as\s+(\w+))?/gim;
  let match;
  
  while ((match = fromRegex.exec(content)) !== null) {
    images.push({
      image: match[1],
      alias: match[2] || null
    });
  }
  
  return images;
}

function extractStages(content) {
  const stages = [];
  const stageRegex = /^FROM\s+[^\s]+\s+as\s+(\w+)/gim;
  let match;
  
  while ((match = stageRegex.exec(content)) !== null) {
    stages.push(match[1]);
  }
  
  return stages;
}

function extractExposedPorts(content) {
  const ports = [];
  const exposeRegex = /^EXPOSE\s+(\d+)/gim;
  let match;
  
  while ((match = exposeRegex.exec(content)) !== null) {
    ports.push(parseInt(match[1]));
  }
  
  return ports;
}

function extractVolumes(content) {
  const volumes = [];
  const volumeRegex = /^VOLUME\s+\[?"?([^\]"]+)"?\]?/gim;
  let match;
  
  while ((match = volumeRegex.exec(content)) !== null) {
    volumes.push(match[1].trim());
  }
  
  return volumes;
}

function extractEntrypoint(content) {
  const match = content.match(/^ENTRYPOINT\s+\[?"?([^\]"]+)"?\]?/im);
  return match ? match[1].trim() : null;
}

function extractCmd(content) {
  const match = content.match(/^CMD\s+\[?"?([^\]"]+)"?\]?/im);
  return match ? match[1].trim() : null;
}

function extractEnv(content) {
  const env = {};
  const envRegex = /^ENV\s+(\w+)(?:=|\s+)([^\n]+)/gim;
  let match;
  
  while ((match = envRegex.exec(content)) !== null) {
    env[match[1]] = match[2].trim().replace(/["']/g, '');
  }
  
  return env;
}

function extractWorkdir(content) {
  const match = content.match(/^WORKDIR\s+([^\n]+)/im);
  return match ? match[1].trim() : null;
}

module.exports = {
  extractDockerfile
};
