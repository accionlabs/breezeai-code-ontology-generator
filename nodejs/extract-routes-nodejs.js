/**
 * JavaScript (Node.js) web-route extractor wrapper.
 * Detection logic lives in ../routes-js-core.js (shared with TypeScript).
 * Covers Express / Fastify / Koa call-based routes (and NestJS decorators
 * when written in JS with decorator support).
 */
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const path = require("path");
const { parseSource } = require("../utils");
const { extractRoutesFromTree } = require("../routes-js-core");

const sharedParser = new Parser();
sharedParser.setLanguage(JavaScript);

function extractFileRoutes(filePath) {
  try {
    const { source, tree } = parseSource(filePath, sharedParser);
    return extractRoutesFromTree(source, tree);
  } catch (e) {
    return [];
  }
}

module.exports = { extractFileRoutes };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node nodejs/extract-routes-nodejs.js <file.js>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
