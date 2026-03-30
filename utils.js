/**
 * Shared utilities for Breeze Code Ontology Generator
 */

const MAX_LINES = 200;
const MAX_CHARS = 10000;
const TRUNCATION_MARKER = "// ... [truncated]";

/**
 * Truncate source code to stay within limits.
 * Hard limit: 200 lines or 10,000 characters, whichever hits first.
 * @param {string} rawSource - The raw source code string
 * @returns {string} - Truncated source with marker if exceeded
 */
function truncateSourceCode(rawSource) {
  if (!rawSource) return rawSource;

  let result = rawSource;
  let truncated = false;

  // Check line limit
  const lines = result.split("\n");
  if (lines.length > MAX_LINES) {
    result = lines.slice(0, MAX_LINES).join("\n");
    truncated = true;
  }

  // Check character limit
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS);
    truncated = true;
  }

  if (truncated) {
    result += "\n" + TRUNCATION_MARKER;
  }

  return result;
}

// -----------------------------------------------------------
// Source cache: avoids reading + parsing the same file multiple
// times when extractImports, extractFunctions, and extractClasses
// are called sequentially for the same file.
// -----------------------------------------------------------
const fs = require("fs");

let _cachedPath = null;
let _cachedSource = null;
let _cachedTree = null;

/**
 * Read file contents with single-entry cache.
 * Consecutive calls for the same filePath return the cached string.
 */
function readSource(filePath) {
  if (_cachedPath === filePath && _cachedSource !== null) return _cachedSource;
  _cachedPath = filePath;
  _cachedSource = fs.readFileSync(filePath, "utf8");
  _cachedTree = null; // invalidate tree when file changes
  return _cachedSource;
}

/**
 * Parse file with tree-sitter, caching both source and tree.
 * If the same filePath was already parsed (by any parser using the
 * same grammar), the cached tree is returned directly.
 */
function parseSource(filePath, parser) {
  const source = readSource(filePath);
  if (_cachedTree) return { source, tree: _cachedTree };
  _cachedTree = parser.parse(source);
  return { source, tree: _cachedTree };
}

// -----------------------------------------------------------
// Query statement detection patterns
// -----------------------------------------------------------

/**
 * Database method signatures organized by database/ORM.
 * Each key is a database identifier, value is an array of method names unique to that DB.
 * Used to both detect query statements AND identify which database is integrated.
 */
const DB_METHOD_MAP = {
  sql: [
    'query', 'rawQuery', 'raw', 'execute', 'exec', 'executeSql',
    'prepare', 'prepareStatement', 'executeQuery', 'executeUpdate',
  ],
  sequelize: [
    'findAll', 'findOne', 'findByPk', 'findOrCreate', 'findAndCountAll',
    'upsert', 'bulkCreate',
  ],
  prisma: [
    'findMany', 'findFirst', 'findUnique',
  ],
  typeorm: [
    'createQueryBuilder', 'getRepository',
  ],
  mongodb: [
    'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
    'insertOne', 'insertMany', 'updateOne', 'updateMany',
    'deleteOne', 'deleteMany', 'replaceOne',
    'countDocuments', 'estimatedDocumentCount',
    'aggregate', 'bulkWrite',
  ],
  neo4j: [
    'readTransaction', 'writeTransaction', 'executeRead', 'executeWrite',
  ],
  couchdb: [
    'allDocs', 'bulkDocs',
    'createIndex', 'getIndexes', 'deleteIndex',
  ],
  redis: [
    'hget', 'hset', 'hgetall', 'hdel', 'hmset', 'hmget',
    'lpush', 'rpush', 'lpop', 'rpop', 'lrange',
    'sadd', 'srem', 'smembers', 'sismember',
    'zadd', 'zrem', 'zrange', 'zrangebyscore',
    'mset', 'mget',
  ],
  dynamodb: [
    'getItem', 'putItem', 'deleteItem', 'updateItem',
    'batchGetItem', 'batchWriteItem', 'transactGetItems', 'transactWriteItems',
  ],
  elasticsearch: [
    'msearch',
  ],
  firebase: [
    'getDocs', 'getDoc', 'setDoc', 'updateDoc', 'deleteDoc',
    'addDoc', 'onSnapshot',
  ],
  entity_framework: [
    'ToListAsync', 'ToList', 'ToArrayAsync', 'ToArray',
    'FirstOrDefaultAsync', 'FirstOrDefault', 'FirstAsync',
    'SingleOrDefaultAsync', 'SingleOrDefault', 'SingleAsync',
    'LastOrDefaultAsync', 'LastOrDefault',
    'CountAsync', 'LongCountAsync', 'AnyAsync', 'AllAsync',
    'MinAsync', 'MaxAsync', 'SumAsync', 'AverageAsync',
    'FindAsync', 'AddAsync', 'AddRangeAsync',
    'SaveChangesAsync', 'SaveChanges',
    'Include', 'ThenInclude', 'AsNoTracking', 'AsTracking',
    'FromSqlRaw', 'FromSqlInterpolated', 'ExecuteSqlRaw', 'ExecuteSqlInterpolated',
  ],
  django: [
    'select_related', 'prefetch_related',
    'get_or_create', 'update_or_create', 'bulk_update',
    'values_list',
  ],
  sqlalchemy: [
    'session_query', 'add_all',
  ],
  hibernate: [
    'findById', 'findAll',
  ],
};

// Build a reverse lookup: method name -> database name
const METHOD_TO_DB = new Map();
for (const [db, methods] of Object.entries(DB_METHOD_MAP)) {
  for (const method of methods) {
    // If a method appears in multiple DBs, first one wins (more specific DBs should be listed first)
    if (!METHOD_TO_DB.has(method)) {
      METHOD_TO_DB.set(method, db);
    }
  }
}

/** Database query language patterns */
const QUERY_PATTERNS = [
  // SQL (MySQL, PostgreSQL, SQLite, MSSQL, Oracle)
  /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|MERGE|TRUNCATE)\b/i,
  // Neo4j Cypher — require graph-specific syntax context
  /\b(MATCH|OPTIONAL\s+MATCH)\s*\(/i,                   // MATCH (...), OPTIONAL MATCH (...)
  /\b(MATCH|CREATE|MERGE)\s*\([a-zA-Z0-9_]*:/i,         // MATCH (n:Label), CREATE (n:Label)
  /\bDETACH\s+DELETE\b/i,                                // DETACH DELETE
  /\bLOAD\s+CSV\b/i,                                     // LOAD CSV
  // MongoDB aggregation string patterns (e.g. in raw commands)
  /\$match|\$group|\$project|\$lookup|\$unwind|\$sort|\$limit|\$skip/,
  // GraphQL
  /\b(query|mutation|subscription)\s*[\({]/i,
  // Elasticsearch Query DSL
  /\b(bool|must|should|must_not|filter)\b.*\b(match|term|range|exists)\b/i,
  // Cassandra CQL
  /\b(KEYSPACE|COLUMNFAMILY|MATERIALIZED\s+VIEW|CONSISTENCY)\b/i,
  // Gremlin (graph DB)
  /\bg\.(V|E|addV|addE|traversal)\s*\(/,
  // SPARQL
  /\b(SELECT|CONSTRUCT|ASK|DESCRIBE)\s+.*\bWHERE\s*\{/i,
];

/**
 * Check if a string node's text contains a database query (SQL, Cypher, GraphQL, etc.).
 */
function containsDbQuery(text) {
  return QUERY_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Check if a method name is a known DB call method.
 * @returns {string|null} - Database name (e.g. 'mongodb', 'redis', 'entity_framework') or null if not a DB method.
 */
function getDbFromMethod(methodName) {
  return METHOD_TO_DB.get(methodName) || null;
}

// -----------------------------------------------------------
// API call detection patterns
// -----------------------------------------------------------

/** HTTP methods to detect */
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

/** Known HTTP client object names — scoped matching to avoid false positives on generic .get()/.post() */
const API_CLIENT_NAMES = new Set([
  // JavaScript / TypeScript
  'axios', '$axios', '$http', 'http', 'httpClient', 'HttpClient',
  'api', 'apiClient', 'httpService', 'restClient',
  // Angular
  'this.http', 'this.$http', 'this.httpClient',
  // Python
  'requests', 'httpx', 'session', 'aiohttp',
  // Go
  'http', 'client',
  // Java / Spring
  'restTemplate', 'RestTemplate', 'webClient', 'WebClient',
  // C# / .NET
  'HttpClient', '_httpClient', '_client',
  // PHP
  'Http', 'Guzzle', '$client', '$http',
  // Generic
  'got', 'superagent', 'ky', 'ofetch', '$fetch', 'useFetch',
]);

/** Bare function names that are HTTP calls (not method calls on an object) */
const API_BARE_FUNCTIONS = new Set(['fetch', '$fetch', 'useFetch', 'apiFetch', 'authFetch', 'customFetch']);

/**
 * Check if an object + method combination is an API call.
 * @param {string|null} objectName - The object/caller (e.g. 'axios', 'this.$http')
 * @param {string|null} methodName - The method (e.g. 'get', 'post')
 * @returns {{ client: string, httpMethod: string } | null}
 */
function getApiCallInfo(objectName, methodName) {
  if (!methodName) return null;

  // Bare function calls: fetch(url), $fetch(url)
  if (!objectName && API_BARE_FUNCTIONS.has(methodName)) {
    return { client: methodName, httpMethod: 'GET' };
  }

  // Method calls: axios.get(), this.$http.post()
  if (objectName && HTTP_METHODS.has(methodName.toLowerCase())) {
    // Direct match: axios.get(), http.post()
    if (API_CLIENT_NAMES.has(objectName)) {
      return { client: objectName, httpMethod: methodName.toUpperCase() };
    }
    // Handle chained this.xxx calls: this.$axios.get(), this.http.post()
    // tree-sitter gives us the full member expression text as objectName
    const stripped = objectName.replace(/^this\./, '').replace(/^self\./, '');
    if (API_CLIENT_NAMES.has(stripped)) {
      return { client: stripped, httpMethod: methodName.toUpperCase() };
    }
  }

  return null;
}

/**
 * Extract endpoint URL from the first argument of an API call.
 * Handles string literals and template strings (static parts only).
 * @param {object} argsNode - The tree-sitter arguments node
 * @param {string} source - The full source text
 * @returns {string|null} - The endpoint URL or null if not statically determinable
 */
function extractEndpointFromArgs(argsNode, source) {
  if (!argsNode || argsNode.namedChildCount === 0) return null;

  const firstArg = argsNode.namedChild(0);
  if (!firstArg) return null;

  const text = source.slice(firstArg.startIndex, firstArg.endIndex);

  // String literal: '/api/users' or "/api/users"
  if (firstArg.type === 'string' || firstArg.type === 'string_literal') {
    return text.replace(/^['"`]|['"`]$/g, '');
  }

  // Template string: `/api/users/${id}`
  if (firstArg.type === 'template_string') {
    // Extract static parts, replace expressions with {param}
    return text.replace(/^`|`$/g, '').replace(/\$\{[^}]*\}/g, '{param}');
  }

  return null;
}

// -----------------------------------------------------------
// Statement text limits
// -----------------------------------------------------------

/** Default text limit for statements */
const STATEMENT_TEXT_LIMIT = 1000;

/** Reduced limit for declarations that assign functions (already captured in functions[]) */
const FUNCTION_DECL_TEXT_LIMIT = 200;

/**
 * Language-agnostic function assignment types.
 * Each language maps its own AST node types to this check.
 */
const FUNCTION_NODE_TYPES = new Set([
  // JavaScript / TypeScript
  'arrow_function', 'function_expression', 'function',
  // Python
  'lambda',
  // Go
  'func_literal',
  // PHP
  'anonymous_function_creation_expression',
  // Java / C# / Salesforce
  'lambda_expression',
]);

/**
 * Get the appropriate text truncation limit for a declaration node.
 * Returns a smaller limit if the declaration assigns a function
 * (since functions are already fully captured in the functions[] array).
 * @param {object} node - The tree-sitter declaration node
 * @returns {number} - Text truncation limit in characters
 */
function getStatementTextLimit(node) {
  if (!node || !node.namedChildCount) return STATEMENT_TEXT_LIMIT;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    // JS/TS: variable_declarator with value field
    if (child.type === 'variable_declarator' || child.type === 'init_declarator') {
      const value = child.childForFieldName('value') || child.childForFieldName('initializer');
      if (value && FUNCTION_NODE_TYPES.has(value.type)) {
        return FUNCTION_DECL_TEXT_LIMIT;
      }
    }
    // Direct child is a function type (some languages)
    if (FUNCTION_NODE_TYPES.has(child.type)) {
      return FUNCTION_DECL_TEXT_LIMIT;
    }
  }

  return STATEMENT_TEXT_LIMIT;
}

module.exports = {
  truncateSourceCode, readSource, parseSource,
  containsDbQuery, getDbFromMethod, DB_METHOD_MAP, QUERY_PATTERNS,
  getApiCallInfo, extractEndpointFromArgs, API_CLIENT_NAMES, API_BARE_FUNCTIONS, HTTP_METHODS,
  getStatementTextLimit, STATEMENT_TEXT_LIMIT, FUNCTION_DECL_TEXT_LIMIT
};
