/**
 * HTML Template Parser
 * Extracts template variables, structure
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract HTML template information
 */
function extractHtmlFile(filePath, repoPath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(repoPath, filePath);
  
  // Determine if it's a template or coverage report
  const isTemplate = !relativePath.includes('coverage.html');
  
  if (!isTemplate) {
    return {
      path: relativePath,
      type: 'coverage_report',
      skip: true
    };
  }
  
  const result = {
    path: relativePath,
    type: 'html_template',
    variables: extractTemplateVariables(content),
    title: extractTitle(content),
    formActions: extractFormActions(content),
    links: extractLinks(content)
  };
  
  return result;
}

function extractTemplateVariables(content) {
  const variables = new Set();
  
  // Go template variables: {{.Variable}}
  const goTemplateRegex = /\{\{\s*\.(\w+)\s*\}\}/g;
  let match;
  
  while ((match = goTemplateRegex.exec(content)) !== null) {
    variables.add(match[1]);
  }
  
  // Jinja2/Django style: {{variable}}
  const jinjaRegex = /\{\{\s*(\w+)\s*\}\}/g;
  while ((match = jinjaRegex.exec(content)) !== null) {
    variables.add(match[1]);
  }
  
  return Array.from(variables);
}

function extractTitle(content) {
  const match = content.match(/<title>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

function extractFormActions(content) {
  const actions = [];
  const formRegex = /<form[^>]+action=["']([^"']+)["']/gi;
  let match;
  
  while ((match = formRegex.exec(content)) !== null) {
    actions.push(match[1]);
  }
  
  return actions;
}

function extractLinks(content) {
  const links = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;
  
  while ((match = linkRegex.exec(content)) !== null) {
    // Only include non-fragment links
    if (!match[1].startsWith('#')) {
      links.push(match[1]);
    }
  }
  
  return links.slice(0, 10); // Limit to first 10
}

module.exports = {
  extractHtmlFile
};
