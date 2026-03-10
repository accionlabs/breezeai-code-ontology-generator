/**
 * Centralized Ignore Patterns Module
 * Handles parsing .repoignore files and converting to glob format
 * Used across all language processors for consistent file filtering
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");

// Cache for parsed patterns to avoid re-reading files
const patternCache = new Map();

// Path to the tool's built-in .repoignore file
const TOOL_REPOIGNORE_PATH = path.join(__dirname, ".repoignore");

// Language-specific folders containing .repoignore files
const LANGUAGE_FOLDERS = [
  "csharp",
  "golang",
  "java",
  "nodejs",
  "php",
  "python",
  "salesforce",
  "typescript",
  "vbnet"
];

/**
 * Convert a single .repoignore pattern to glob format
 * @param {string} pattern - Raw pattern from .repoignore
 * @returns {string|null} - Glob-compatible pattern or null if invalid
 */
function convertToGlobPattern(pattern) {
  if (!pattern || typeof pattern !== "string") {
    return null;
  }

  pattern = pattern.trim();

  // Skip empty lines and comments
  if (!pattern || pattern.startsWith("#")) {
    return null;
  }

  // Handle negation patterns (not supported, skip them)
  if (pattern.startsWith("!")) {
    return null;
  }

  // Already a glob pattern with **
  if (pattern.startsWith("**/")) {
    return pattern;
  }

  // Directory pattern ending with /
  if (pattern.endsWith("/")) {
    // node_modules/ -> **/node_modules/**
    const dirName = pattern.slice(0, -1);
    return `**/${dirName}/**`;
  }

  // Pattern starting with / (root-relative)
  if (pattern.startsWith("/")) {
    // /bin/ -> bin/**
    const stripped = pattern.slice(1);
    if (stripped.endsWith("/")) {
      return stripped + "**";
    }
    return stripped;
  }

  // Pattern with directory path (e.g., force-app/**/staticresources/)
  if (pattern.includes("/")) {
    // Keep as is but ensure ** coverage
    if (pattern.endsWith("/")) {
      return "**/" + pattern + "**";
    }
    return "**/" + pattern;
  }

  // File pattern with wildcard (e.g., *.min.js)
  if (pattern.includes("*")) {
    return "**/" + pattern;
  }

  // Plain file name (e.g., .env, .DS_Store)
  return "**/" + pattern;
}

/**
 * Parse a .repoignore file and convert to glob patterns
 * @param {string} filePath - Absolute path to .repoignore file
 * @returns {string[]} - Array of glob-compatible patterns
 */
function parseRepoIgnoreFile(filePath) {
  // Check cache first
  if (patternCache.has(filePath)) {
    return patternCache.get(filePath);
  }

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const patterns = [];

    for (const line of lines) {
      const globPattern = convertToGlobPattern(line);
      if (globPattern) {
        patterns.push(globPattern);
      }
    }

    // Cache the result
    patternCache.set(filePath, patterns);
    return patterns;
  } catch (err) {
    console.warn(`Warning: Could not read .repoignore file at ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Parse .repoignore file for a specific language folder
 * @param {string} basePath - Base path where language folders are located
 * @param {string} language - Language folder name (e.g., 'php', 'csharp')
 * @returns {string[]} - Array of glob-compatible patterns for that language
 */
function parseLanguageFolderIgnores(basePath, language) {
  if (!language || !LANGUAGE_FOLDERS.includes(language)) {
    return [];
  }

  const repoIgnorePath = path.join(basePath, language, ".repoignore");
  if (fs.existsSync(repoIgnorePath)) {
    return parseRepoIgnoreFile(repoIgnorePath);
  }

  return [];
}

/**
 * Get count of language-specific patterns (for logging)
 * @param {string} basePath - Base path where language folders are located
 * @param {string} language - Language folder name (e.g., 'php', 'csharp')
 * @returns {number} - Count of patterns for that language
 */
function countLanguagePatterns(basePath, language) {
  return parseLanguageFolderIgnores(basePath, language).length;
}

/**
 * Get ignore patterns for a repository (without repoPath prefix)
 * These patterns can be used with glob's cwd option
 * @param {string} repoPath - Target repository path
 * @param {Object} options - Configuration options
 * @param {boolean} options.includeBuiltin - Include tool's built-in patterns (default: true)
 * @param {boolean} options.includeRepoIgnore - Check for repo's .repoignore (default: true)
 * @param {string} options.language - Language folder name (e.g., 'php', 'csharp') for language-specific patterns
 * @returns {string[]} - Array of glob patterns
 */
function getIgnorePatterns(repoPath, options = {}) {
  const { includeBuiltin = true, includeRepoIgnore = true, language = null } = options;

  const allPatterns = new Set();

  // 1. Load tool's built-in common patterns
  if (includeBuiltin) {
    const builtinPatterns = parseRepoIgnoreFile(TOOL_REPOIGNORE_PATH);
    for (const p of builtinPatterns) {
      allPatterns.add(p);
    }

    // 1b. Load language-specific patterns (only for the specified language)
    if (language) {
      const languagePatterns = parseLanguageFolderIgnores(__dirname, language);
      for (const p of languagePatterns) {
        allPatterns.add(p);
      }
    }
  }

  // 2. Load target repo's .repoignore (if exists)
  if (includeRepoIgnore && repoPath) {
    const repoIgnorePath = path.join(repoPath, ".repoignore");
    const repoPatterns = parseRepoIgnoreFile(repoIgnorePath);
    for (const p of repoPatterns) {
      allPatterns.add(p);
    }
  }

  return Array.from(allPatterns);
}

/**
 * Get ignore patterns prefixed with repoPath (for absolute path glob patterns)
 * Use this when glob is called with absolute paths like: repoPath + "/**\/*.js"
 * @param {string} repoPath - Target repository path
 * @param {Object} options - Configuration options
 * @returns {string[]} - Array of glob patterns prefixed with repoPath
 */
function getIgnorePatternsWithPrefix(repoPath, options = {}) {
  const patterns = getIgnorePatterns(repoPath, options);

  return patterns.map((pattern) => {
    // If pattern already starts with **, prefix with repoPath
    if (pattern.startsWith("**/")) {
      return `${repoPath}/${pattern}`;
    }
    // Otherwise, just join with repoPath
    return path.join(repoPath, pattern);
  });
}

/**
 * Clear the pattern cache (useful for testing or when .repoignore changes)
 */
function clearCache() {
  patternCache.clear();
}

/**
 * Get the path to the tool's built-in .repoignore file
 * @returns {string} - Absolute path to tool's .repoignore
 */
function getToolRepoIgnorePath() {
  return TOOL_REPOIGNORE_PATH;
}

/**
 * Find files that would be skipped by ignore patterns
 * @param {string} repoPath - Target repository path
 * @param {string} filePattern - Glob pattern for files (e.g., "**\/*.js")
 * @param {Object} options - Configuration options
 * @returns {Object} - { allFiles, filteredFiles, skippedFiles, skippedCount }
 */
function findSkippedFiles(repoPath, filePattern, options = {}) {
  const ignorePatterns = getIgnorePatternsWithPrefix(repoPath, options);

  // Get all files without ignore patterns
  const allFiles = glob.sync(`${repoPath}/${filePattern}`, { nodir: true });

  // Get filtered files with ignore patterns
  const filteredFiles = glob.sync(`${repoPath}/${filePattern}`, {
    ignore: ignorePatterns,
    nodir: true,
  });

  // Calculate skipped files
  const filteredSet = new Set(filteredFiles);
  const skippedFiles = allFiles.filter((f) => !filteredSet.has(f));

  return {
    allFiles,
    filteredFiles,
    skippedFiles,
    skippedCount: skippedFiles.length,
  };
}

/**
 * Log information about ignore patterns and skipped files
 * @param {string} repoPath - Target repository path
 * @param {boolean} verbose - Whether to show detailed output
 * @param {string} language - Language folder name (e.g., 'php', 'csharp')
 */
function logIgnoreInfo(repoPath, verbose = false, language = null) {
  const patterns = getIgnorePatterns(repoPath, { language });
  const repoIgnorePath = path.join(repoPath, ".repoignore");
  const hasRepoIgnore = fs.existsSync(repoIgnorePath);

  console.log("\n📋 Ignore Patterns Configuration:");
  console.log(`   Built-in common patterns: ${parseRepoIgnoreFile(TOOL_REPOIGNORE_PATH).length}`);
  if (language) {
    console.log(`   Language patterns (${language}): ${countLanguagePatterns(__dirname, language)}`);
  }

  if (hasRepoIgnore) {
    const repoPatterns = parseRepoIgnoreFile(repoIgnorePath);
    console.log(`   Repository .repoignore: ${repoPatterns.length} patterns`);
  } else {
    console.log("   Repository .repoignore: Not found (using built-in only)");
  }

  console.log(`   Total active patterns: ${patterns.length}`);

  // Always show sample patterns
  console.log("\n   Sample patterns being applied:");
  const sampleCount = verbose ? 20 : 10;
  const samplePatterns = patterns.slice(0, sampleCount);
  samplePatterns.forEach((p) => console.log(`     - ${p}`));
  if (patterns.length > sampleCount) {
    console.log(`     ... and ${patterns.length - sampleCount} more`);
  }
}

/**
 * Log skipped files for a specific file type
 * @param {string} repoPath - Target repository path
 * @param {string} filePattern - Glob pattern (e.g., "**\/*.js")
 * @param {string} language - Language name for display
 * @param {boolean} verbose - Whether to show all skipped files
 */
function logSkippedFiles(repoPath, filePattern, language, verbose = false) {
  const { allFiles, filteredFiles, skippedFiles, skippedCount } = findSkippedFiles(
    repoPath,
    filePattern
  );

  if (skippedCount > 0) {
    console.log(`\n⏭️  Skipped ${skippedCount} ${language} files (matched ignore patterns):`);

    if (verbose) {
      // Show all skipped files in verbose mode
      skippedFiles.forEach((f) => {
        const relPath = path.relative(repoPath, f);
        console.log(`     - ${relPath}`);
      });
    } else {
      // Show summary with first few files
      const maxShow = 5;
      const filesToShow = skippedFiles.slice(0, maxShow);
      filesToShow.forEach((f) => {
        const relPath = path.relative(repoPath, f);
        console.log(`     - ${relPath}`);
      });
      if (skippedCount > maxShow) {
        console.log(`     ... and ${skippedCount - maxShow} more`);
      }
    }
  }

  return { total: allFiles.length, processed: filteredFiles.length, skipped: skippedCount };
}

module.exports = {
  getIgnorePatterns,
  getIgnorePatternsWithPrefix,
  parseRepoIgnoreFile,
  parseLanguageFolderIgnores,
  convertToGlobPattern,
  clearCache,
  getToolRepoIgnorePath,
  findSkippedFiles,
  logIgnoreInfo,
  logSkippedFiles,
};
