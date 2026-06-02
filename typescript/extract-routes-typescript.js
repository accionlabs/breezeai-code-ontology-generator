/**
 * TypeScript web-route extractor wrapper.
 * Detection logic lives in ../routes-js-core.js (shared with Node.js/JS).
 * Covers NestJS decorators (HTTP / GraphQL / WS / message patterns) plus
 * Express / Fastify / Koa call-based routes written in TypeScript.
 */
const Parser = require("tree-sitter");
const TypeScript = require("tree-sitter-typescript").typescript;
const path = require("path");
const { parseSource } = require("../utils");
const { extractRoutesFromTree } = require("../routes-js-core");

const sharedParser = new Parser();
sharedParser.setLanguage(TypeScript);

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
    console.error("Usage: node typescript/extract-routes-typescript.js <File.ts>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
