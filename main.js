/**
 * Breeze Code Ontology Generator - Auto-Detect Module
 * Automatically detects languages in a repository and processes them
 *
 * This module exports functions to be used by index.js
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const glob = require("glob");
const { readSource } = require("./utils");

// Import language analyzers
const {
  analyzeTypeScriptRepo,
} = require("./typescript/file-tree-mapper-typescript");
const { analyzeJavaScriptRepo } = require("./nodejs/file-tree-mapper-nodejs");
const { analyzePythonRepo } = require("./python/file-tree-mapper-python");
const { analyzeJavaRepo } = require("./java/file-tree-main-java");
const { analyzeCSharpRepo } = require("./csharp/file-tree-mapper-csharp");
const { analyzeGolangRepo } = require("./golang/file-tree-mapper-golang");
const {
  analyzeSalesforceRepo,
} = require("./salesforce/file-tree-mapper-salesforce");
const { analyzePHPRepo } = require("./php/file-tree-mapper-php");
const { analyzeVBNetRepo } = require("./vbnet/file-tree-mapper-vbnet");
const { analyzeConfigRepo } = require("./config/file-tree-mapper-config");
const { analyzeVueRepo } = require("./vue/file-tree-mapper-vue");
const { analyzeSQLRepo } = require("./sql/file-tree-mapper-sql");
const { analyzePerlRepo } = require("./perl/file-tree-mapper-perl");
const {
  getIgnorePatterns,
  getIgnorePatternsWithPrefix,
  logIgnoreInfo,
  logSkippedFiles,
} = require("./ignore-patterns");

const isWindows = process.platform === "win32";

// Helper function to count lines of code (uses source cache to avoid re-reading)
function countLinesOfCode(filePath) {
  try {
    const content = readSource(filePath);
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) count++;
    }
    return count;
  } catch (err) {
    return 0;
  }
}

// Language configuration
const LANGUAGE_CONFIG = {
  typescript: {
    extensions: ["**/*.ts", "**/*.tsx"],
    name: "TypeScript",
    analyzer: analyzeTypeScriptRepo,
    priority: 1, // Higher priority means it's checked first
  },
  javascript: {
    extensions: ["**/*.js", "**/*.jsx"],
    name: "JavaScript",
    analyzer: analyzeJavaScriptRepo,
  },
  python: {
    extensions: ["**/*.py"],
    name: "Python",
    analyzer: analyzePythonRepo,
  },
  java: {
    extensions: ["**/*.java"],
    name: "Java",
    analyzer: analyzeJavaRepo,
  },
  csharp: {
    extensions: ["**/*.cs"],
    name: "C#",
    analyzer: analyzeCSharpRepo,
  },
  golang: {
    extensions: ["**/*.go"],
    name: "Go",
    analyzer: analyzeGolangRepo,
  },
  salesforce: {
    extensions: ["**/*.cls", "**/*.trigger"],
    name: "Salesforce Apex",
    analyzer: analyzeSalesforceRepo,
  },
  php: {
    extensions: ["**/*.php"],
    name: "PHP",
    analyzer: analyzePHPRepo,
  },
  vbnet: {
    extensions: ["**/*.vb"],
    name: "VB.NET",
    analyzer: analyzeVBNetRepo,
  },
  vue: {
    extensions: ["**/*.vue"],
    name: "Vue",
    analyzer: analyzeVueRepo,
    priority: 2, // Check before plain JavaScript so .vue files are detected
  },
<<<<<<< HEAD
  sql: {
    extensions: ["**/*.sql"],
    name: "SQL/DDL (Oracle)",
    analyzer: analyzeSQLRepo,
=======
  perl: {
    extensions: ["**/*.pl", "**/*.pm", "**/*.psgi", "**/*.t"],
    name: "Perl",
    analyzer: analyzePerlRepo,
>>>>>>> cd9f950bc6129353e58ba2d4b2aff77040440188
  },
};

// ----------------------------
// Detect languages in repository
// ----------------------------
function detectLanguages(repoPath, verbose = false) {
  if (verbose) {
    console.log("\n🔍 Detecting languages in repository...");
  }

  // Always log ignore patterns info
  logIgnoreInfo(repoPath, verbose);

  const detectedLanguages = [];

  // Get ignore patterns from centralized module (supports .repoignore files)
  const ignorePatterns = getIgnorePatterns(repoPath);

  // Sort by priority (if defined) to check TypeScript before JavaScript
  const languageEntries = Object.entries(LANGUAGE_CONFIG).sort((a, b) => {
    const priorityA = a[1].priority || 0;
    const priorityB = b[1].priority || 0;
    return priorityB - priorityA;
  });

  for (const [langKey, config] of languageEntries) {
    if (verbose) {
      console.log(`   Checking for ${config.name} files...`);
    }

    let hasFiles = false;

    // Check each extension pattern
    for (const pattern of config.extensions) {
      const files = glob.sync(path.join(repoPath, pattern), {
        ignore: ignorePatterns.map((p) => path.join(repoPath, p)),
        nodir: true,
      });

      if (files.length > 0) {
        hasFiles = true;
        if (verbose) {
          console.log(`   ✓ Found ${files.length} ${pattern} files`);
        }
        // Always log skipped files for detected languages
        logSkippedFiles(repoPath, pattern, config.name, verbose, langKey);

        break;
      }
    }

    if (hasFiles) {
      detectedLanguages.push({
        key: langKey,
        name: config.name,
        analyzer: config.analyzer,
      });
      if (verbose) {
        console.log(`   ✅ ${config.name} detected`);
      }
    }
  }

  return detectedLanguages;
}

// ----------------------------
// Process a single language
// ----------------------------
async function processLanguage(language, repoPath, verbose = false, opts = {}) {
  try {
    console.log(`\n🚀 Processing ${language.name}...`);

    // Get language-specific ignore patterns (common + language-specific)
    const ignorePatterns = getIgnorePatternsWithPrefix(repoPath, {
      language: language.key,
    });

    // Call the analyzer function with language-specific ignore patterns
    const data = await Promise.resolve(
      language.analyzer(repoPath, { ...opts, ignorePatterns }),
    );

    console.log(`✅ ${language.name} analysis complete!`);

    return { language: language.key, name: language.name, data };
  } catch (err) {
    console.error(`\n❌ ${language.name} analysis failed:`, err);
    return null;
  }
}

// ----------------------------
// Merge all language outputs into single JSON
// ----------------------------
function mergeLanguageOutputs(
  languageResults,
  repoPath,
  outputDir,
  ndjsonTarget,
  filterPaths,
) {
  console.log("\n🔄 Merging all language outputs...");

  // ndjsonTarget can be a writable stream, a file path string, or falsy (in-memory mode).
  const isStream = ndjsonTarget && typeof ndjsonTarget.write === "function";
  const isFilePath = ndjsonTarget && typeof ndjsonTarget === "string";
  const mergedFiles = isStream || isFilePath ? null : [];
  let totalFilesCount = 0;

  function writeNdjsonLine(obj) {
    if (isStream) ndjsonTarget.write(JSON.stringify(obj) + "\n");
    else if (isFilePath)
      fs.appendFileSync(ndjsonTarget, JSON.stringify(obj) + "\n");
    else mergedFiles.push(obj);
  }
  const analyzedLanguages = [];
  let totalFunctions = 0;
  let totalClasses = 0;
  let totalLinesOfCode = 0;

  // Language file count statistics
  const languageFileCount = {};

  // Config file statistics and consolidated info
  const configStats = {
    totalConfigFiles: 0,
    byType: {
      json: 0,
      yaml: 0,
      docker: 0,
      env: 0,
      xml: 0,
      ini: 0,
      toml: 0,
      python: 0,
      gradle: 0,
      other: 0,
    },
    packageManagers: [],
    dockerInfo: {
      hasDockerfile: false,
      hasDockerCompose: false,
      services: [],
      exposedPorts: [],
    },
    buildTools: [],
    dependencies: {
      total: 0,
      production: 0,
      development: 0,
    },
  };

  for (const result of languageResults) {
    if (result && result.data) {
      analyzedLanguages.push(result.language);

      // Each language output should have an array of file objects
      if (Array.isArray(result.data)) {
        // Add language identifier to each file and count functions/classes
        result.data.forEach((file) => {
          const filePath = path.join(repoPath, file.path);
          const loc = countLinesOfCode(filePath);
          totalLinesOfCode += loc;

          // Process config files differently
          if (result.language === "config") {
            // Extract metadata fields (everything except path, fileName, fileType, size, lines)
            const baseFields = [
              "path",
              "fileName",
              "fileType",
              "size",
              "lines",
              "language",
            ];
            const metadata = {};

            Object.keys(file).forEach((key) => {
              if (!baseFields.includes(key)) {
                metadata[key] = file[key];
              }
            });

            const configFileData = {
              path: file.path,
              type: "config",
              language: "config",
              loc,
              metadata,
            };

            if (!filterPaths || filterPaths.has(file.path)) {
              writeNdjsonLine(configFileData);
              totalFilesCount++;
            }
            configStats.totalConfigFiles++;

            // Count by type
            if (
              file.fileType &&
              configStats.byType.hasOwnProperty(file.fileType)
            ) {
              configStats.byType[file.fileType]++;
            }

            // Extract package.json info
            if (file.fileName === "package.json" && file.packageInfo) {
              configStats.packageManagers.push("npm");
              if (file.packageInfo.dependencies) {
                configStats.dependencies.production +=
                  file.packageInfo.dependencies.length;
              }
              if (file.packageInfo.devDependencies) {
                configStats.dependencies.development +=
                  file.packageInfo.devDependencies.length;
              }
              configStats.dependencies.total =
                configStats.dependencies.production +
                configStats.dependencies.development;
            }

            // Extract Docker info
            if (file.fileType === "docker") {
              configStats.dockerInfo.hasDockerfile = true;
              if (file.dockerInfo && file.dockerInfo.exposedPorts) {
                configStats.dockerInfo.exposedPorts.push(
                  ...file.dockerInfo.exposedPorts,
                );
              }
            }

            // Extract docker-compose info
            if (file.fileName && file.fileName.includes("docker-compose")) {
              configStats.dockerInfo.hasDockerCompose = true;
              if (file.dockerCompose && file.dockerCompose.services) {
                configStats.dockerInfo.services.push(
                  ...file.dockerCompose.services,
                );
              }
              if (file.dockerCompose && file.dockerCompose.exposedPorts) {
                configStats.dockerInfo.exposedPorts.push(
                  ...file.dockerCompose.exposedPorts,
                );
              }
            }

            // Extract Maven info
            if (file.fileName === "pom.xml") {
              configStats.packageManagers.push("maven");
              configStats.buildTools.push("maven");
              if (file.mavenInfo && file.mavenInfo.dependencyCount) {
                configStats.dependencies.total +=
                  file.mavenInfo.dependencyCount;
              }
            }

            // Extract TypeScript/JavaScript compiler configs
            if (file.fileName === "tsconfig.json") {
              configStats.buildTools.push("typescript");
            }

            // Extract Python config info
            if (file.fileType === "python") {
              if (
                file.fileName === "requirements.txt" &&
                file.dependencyCount
              ) {
                configStats.dependencies.total += file.dependencyCount;
                if (!configStats.packageManagers.includes("pip")) {
                  configStats.packageManagers.push("pip");
                }
              }
              if (file.fileName === "Pipfile") {
                if (!configStats.packageManagers.includes("pipenv")) {
                  configStats.packageManagers.push("pipenv");
                }
              }
              if (file.fileName === "setup.py") {
                configStats.buildTools.push("setuptools");
              }
            }

            // Extract Gradle config info
            if (file.fileType === "gradle") {
              if (!configStats.packageManagers.includes("gradle")) {
                configStats.packageManagers.push("gradle");
              }
              if (!configStats.buildTools.includes("gradle")) {
                configStats.buildTools.push("gradle");
              }
              if (file.dependencyCount) {
                configStats.dependencies.total += file.dependencyCount;
              }
            }
          } else {
            // Code files - add type and loc
            const codeFileData = {
              ...file,
              type: "code",
              language: result.language,
              loc,
            };

            if (!filterPaths || filterPaths.has(file.path)) {
              writeNdjsonLine(codeFileData);
              totalFilesCount++;
            }

            // Count files by language
            if (!languageFileCount[result.language]) {
              languageFileCount[result.language] = 0;
            }
            languageFileCount[result.language]++;

            // Count functions in this file
            if (file.functions && Array.isArray(file.functions)) {
              totalFunctions += file.functions.length;
            }

            // Count classes in this file
            if (file.classes && Array.isArray(file.classes)) {
              totalClasses += file.classes.length;
            }
          }
        });
      } else {
        console.warn(`⚠️  Warning: ${result.name} output is not an array`);
      }
    }
  }

  // Deduplicate arrays
  configStats.packageManagers = [...new Set(configStats.packageManagers)];
  configStats.buildTools = [...new Set(configStats.buildTools)];
  configStats.dockerInfo.services = [
    ...new Set(configStats.dockerInfo.services),
  ];
  configStats.dockerInfo.exposedPorts = [
    ...new Set(configStats.dockerInfo.exposedPorts),
  ];

  // Add language file counts into byType
  Object.entries(languageFileCount).forEach(([lang, count]) => {
    configStats.byType[lang] = count;
  });

  // Build projectMetaData (always in memory — small scalars)
  const projectMetaData = {
    repositoryPath: repoPath,
    repositoryName: path.basename(repoPath),
    analyzedLanguages,
    totalFiles: totalFilesCount,
    totalFunctions,
    totalClasses,
    totalLinesOfCode,
    configs: configStats,
    generatedAt: new Date().toISOString(),
    toolVersion: "1.0.0",
  };

  const mergedOutputPath = path.join(
    outputDir,
    `${path.basename(repoPath)}-project-analysis.ndjson`,
  );

  // Log summary
  console.log(`✅ Merged output created!`);
  console.log(`📄 Output: ${mergedOutputPath}`);
  console.log(`   - Languages: ${analyzedLanguages.join(", ")}`);
  console.log(`   - Total files: ${totalFilesCount}`);
  console.log(
    `   - Code files: ${totalFilesCount - configStats.totalConfigFiles}`,
  );
  console.log(`   - Config files: ${configStats.totalConfigFiles}`);
  console.log(`   - Total functions: ${totalFunctions}`);
  console.log(`   - Total classes: ${totalClasses}`);
  console.log(`   - Total lines of code: ${totalLinesOfCode}`);

  if (configStats.totalConfigFiles > 0) {
    console.log(`\n📋 Configuration Summary:`);
    console.log(
      `   - Package Managers: ${configStats.packageManagers.length > 0 ? configStats.packageManagers.join(", ") : "None"}`,
    );
    console.log(
      `   - Build Tools: ${configStats.buildTools.length > 0 ? configStats.buildTools.join(", ") : "None"}`,
    );
    console.log(`   - Total Dependencies: ${configStats.dependencies.total}`);
    if (
      configStats.dockerInfo.hasDockerfile ||
      configStats.dockerInfo.hasDockerCompose
    ) {
      console.log(
        `   - Docker: ${configStats.dockerInfo.hasDockerfile ? "Dockerfile" : ""}${configStats.dockerInfo.hasDockerfile && configStats.dockerInfo.hasDockerCompose ? ", " : ""}${configStats.dockerInfo.hasDockerCompose ? "docker-compose" : ""}`,
      );
      if (configStats.dockerInfo.services.length > 0) {
        console.log(
          `   - Docker Services: ${configStats.dockerInfo.services.join(", ")}`,
        );
      }
    }
  }

  if (isStream || isFilePath) {
    // NDJSON mode: don't build the full output in memory, return metadata separately
    return {
      outputPath: mergedOutputPath,
      projectMetaData,
      ndjsonPath: isFilePath ? ndjsonTarget : null,
    };
  }

  // Legacy mode: build full output in memory
  const mergedOutput = {
    projectMetaData,
    files: mergedFiles,
  };

  fs.writeFileSync(mergedOutputPath, JSON.stringify(mergedOutput, null, 2));
  return { outputPath: mergedOutputPath, data: mergedOutput };
}

// ----------------------------
// Merge two projectMetaData objects (for incremental NDJSON merging)
// ----------------------------
function mergeProjectMetaData(base, incoming) {
  const mergedByType = { ...base.configs.byType };
  for (const [key, val] of Object.entries(incoming.configs.byType)) {
    mergedByType[key] = (mergedByType[key] || 0) + val;
  }

  return {
    repositoryPath: base.repositoryPath,
    repositoryName: base.repositoryName,
    analyzedLanguages: [
      ...base.analyzedLanguages,
      ...incoming.analyzedLanguages,
    ],
    totalFiles: base.totalFiles + incoming.totalFiles,
    totalFunctions: base.totalFunctions + incoming.totalFunctions,
    totalClasses: base.totalClasses + incoming.totalClasses,
    totalLinesOfCode: base.totalLinesOfCode + incoming.totalLinesOfCode,
    configs: {
      totalConfigFiles:
        base.configs.totalConfigFiles + incoming.configs.totalConfigFiles,
      byType: mergedByType,
      packageManagers: [
        ...new Set([
          ...base.configs.packageManagers,
          ...incoming.configs.packageManagers,
        ]),
      ],
      dockerInfo: {
        hasDockerfile:
          base.configs.dockerInfo.hasDockerfile ||
          incoming.configs.dockerInfo.hasDockerfile,
        hasDockerCompose:
          base.configs.dockerInfo.hasDockerCompose ||
          incoming.configs.dockerInfo.hasDockerCompose,
        services: [
          ...new Set([
            ...base.configs.dockerInfo.services,
            ...incoming.configs.dockerInfo.services,
          ]),
        ],
        exposedPorts: [
          ...new Set([
            ...base.configs.dockerInfo.exposedPorts,
            ...incoming.configs.dockerInfo.exposedPorts,
          ]),
        ],
      },
      buildTools: [
        ...new Set([
          ...base.configs.buildTools,
          ...incoming.configs.buildTools,
        ]),
      ],
      dependencies: {
        total:
          base.configs.dependencies.total + incoming.configs.dependencies.total,
        production:
          base.configs.dependencies.production +
          incoming.configs.dependencies.production,
        development:
          base.configs.dependencies.development +
          incoming.configs.dependencies.development,
      },
    },
    generatedAt: incoming.generatedAt,
    toolVersion: incoming.toolVersion,
  };
}

// ----------------------------
// Assemble final JSON output from NDJSON file
// ----------------------------
function assembleOutputFromNdjson(ndjsonPath, projectMetaData, outputJsonPath) {
  console.log("\n🔄 Assembling final output from NDJSON file...");

  const files = [];
  const content = fs.readFileSync(ndjsonPath, "utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      files.push(JSON.parse(trimmed));
    }
  }

  const output = { projectMetaData, files };
  fs.writeFileSync(outputJsonPath, JSON.stringify(output, null, 2));

  console.log(`✅ Assembled ${files.length} files into ${outputJsonPath}`);
  return output;
}

// ----------------------------
// Generate descriptions for merged output
// ----------------------------
function generateDescriptions(
  mergedOutputPath,
  repoPath,
  opts,
  verbose = false,
) {
  const provider = opts.provider || "openai";

  // Validate credentials based on provider
  if (provider === "bedrock") {
    if (!opts.awsAccessKey || !opts.awsSecretKey) {
      console.error(
        "❌ Error: --aws-access-key and --aws-secret-key are required for bedrock provider",
      );
      return false;
    }
  } else if (!opts.userApiKey && provider !== "custom") {
    console.error(
      "❌ Error: --api-key is required for --generate-descriptions",
    );
    return false;
  }

  console.log("\n🤖 Generating descriptions...");

  const descScriptPath = path.resolve(
    __dirname,
    "generate-file-descriptions.js",
  );
  let descCommand = `node "${descScriptPath}" "${repoPath}" "${mergedOutputPath}"`;

  descCommand += ` --provider ${provider}`;

  // Add credentials based on provider
  if (provider === "bedrock") {
    descCommand += ` --aws-region ${opts.awsRegion || "us-west-2"}`;
    descCommand += ` --aws-access-key ${opts.awsAccessKey}`;
    descCommand += ` --aws-secret-key ${opts.awsSecretKey}`;
  } else if (opts.userApiKey) {
    descCommand += ` --api-key ${opts.userApiKey}`;
  }

  if (opts.model) descCommand += ` --model ${opts.model}`;
  if (opts.apiUrl) descCommand += ` --api-url ${opts.apiUrl}`;
  if (opts.maxConcurrent)
    descCommand += ` --max-concurrent ${opts.maxConcurrent}`;

  try {
    if (verbose) {
      console.log("Running:", descCommand);
    }
    execSync(descCommand, {
      stdio: "inherit",
      shell: isWindows ? "cmd.exe" : undefined,
    });
    console.log("✅ Descriptions generated!");
    return true;
  } catch (err) {
    console.error("❌ Description generation failed:", err.message);
    return false;
  }
}

// ----------------------------
// Add metadata for merged output
// ----------------------------
function addMetadata(mergedOutputPath, repoPath, opts, verbose = false) {
  const provider = opts.provider || "openai";

  // Validate credentials based on provider
  if (provider === "bedrock") {
    if (!opts.awsAccessKey || !opts.awsSecretKey) {
      console.error(
        "❌ Error: --aws-access-key and --aws-secret-key are required for bedrock provider",
      );
      return false;
    }
  } else if (!opts.userApiKey && provider !== "custom") {
    console.error("❌ Error: --api-key is required for --add-metadata");
    return false;
  }

  console.log("\n🏷️  Adding metadata...");

  const metadataScriptPath = path.resolve(__dirname, "add-metadata.js");
  let metadataCommand = `node "${metadataScriptPath}" "${mergedOutputPath}" "${repoPath}"`;

  metadataCommand += ` --provider ${provider}`;

  // Add credentials based on provider
  if (provider === "bedrock") {
    metadataCommand += ` --aws-region ${opts.awsRegion || "us-west-2"}`;
    metadataCommand += ` --aws-access-key ${opts.awsAccessKey}`;
    metadataCommand += ` --aws-secret-key ${opts.awsSecretKey}`;
  } else if (opts.userApiKey) {
    metadataCommand += ` --api-key ${opts.userApiKey}`;
  }

  if (opts.model) metadataCommand += ` --model ${opts.model}`;
  if (opts.apiUrl) metadataCommand += ` --api-url ${opts.apiUrl}`;
  if (opts.mode) metadataCommand += ` --mode ${opts.mode}`;
  if (opts.maxConcurrent)
    metadataCommand += ` --max-concurrent ${opts.maxConcurrent}`;

  try {
    if (verbose) {
      console.log("Running:", metadataCommand);
    }
    execSync(metadataCommand, {
      stdio: "inherit",
      shell: isWindows ? "cmd.exe" : undefined,
    });
    console.log("✅ Metadata added!");
    return true;
  } catch (err) {
    console.error("❌ Metadata addition failed:", err.message);
    return false;
  }
}

// ----------------------------
// Main auto-detect function
// ----------------------------
async function autoDetectAndProcess(repoPath, outputDir, opts) {
  const verbose = opts.verbose || false;

  try {
    console.log(
      "╔════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║   Breeze Code Ontology Generator - Auto Language Mode     ║",
    );
    console.log(
      "╚════════════════════════════════════════════════════════════╝",
    );
    console.log(`\n📂 Repository: ${repoPath}`);
    console.log(`📁 Output directory: ${outputDir}`);

    // Step 1: Detect languages
    const detectedLanguages = detectLanguages(repoPath, verbose);

    if (detectedLanguages.length === 0) {
      console.log("\n⚠️  No supported languages detected in the repository.");
      console.log(
        "Supported file types: .js, .jsx, .ts, .tsx, .py, .java, .cs, .go, .cls, .trigger, .php, .vb",
      );
      return { success: true, languagesDetected: 0 };
    }

    console.log(
      `\n📊 Detected ${detectedLanguages.length} language(s): ${detectedLanguages.map((l) => l.name).join(", ")}`,
    );

    // Step 2: Process each language in batches, streaming results to NDJSON
    const ndjsonPath = path.join(
      outputDir,
      `${path.basename(repoPath)}-project-analysis.ndjson`,
    );
    // Clear any previous NDJSON file
    if (fs.existsSync(ndjsonPath)) fs.unlinkSync(ndjsonPath);

    // Stats accumulators (avoid holding all file data in memory)
    const analyzedLanguages = [];
    let totalFiles = 0;
    let totalFunctions = 0;
    let totalClasses = 0;
    let totalLinesOfCode = 0;
    const languageFileCount = {};
    let languagesProcessed = 0;
    let ndjsonFd = fs.openSync(ndjsonPath, "a");

    for (const language of detectedLanguages) {
      try {
        console.log(`\n🚀 Processing ${language.name}...`);

        // Streaming callback: each file result is written to NDJSON immediately
        const onResult = (fileData) => {
          // DDL records (__type: "ddl") keep their own type; code records get type = "code"
          if (fileData.__type !== 'ddl') {
            const filePath = path.join(repoPath, fileData.path);
            const loc = countLinesOfCode(filePath);
            totalLinesOfCode += loc;

            fileData.type = "code";
            fileData.language = language.key;
            fileData.loc = loc;
          } else {
            fileData.language = language.key;
          }

          fs.writeSync(ndjsonFd, JSON.stringify(fileData) + "\n");
          totalFiles++;
          languageFileCount[language.key] =
            (languageFileCount[language.key] || 0) + 1;

          if (fileData.functions && Array.isArray(fileData.functions)) {
            totalFunctions += fileData.functions.length;
          }
          if (fileData.classes && Array.isArray(fileData.classes)) {
            totalClasses += fileData.classes.length;
          }
        };

        await Promise.resolve(
          language.analyzer(repoPath, { ...opts, onResult }),
        );
        analyzedLanguages.push(language.key);
        languagesProcessed++;
        console.log(`✅ ${language.name} analysis complete!`);
      } catch (err) {
        console.error(`\n❌ ${language.name} analysis failed:`, err);
      }
    }

    if (languagesProcessed === 0) {
      fs.closeSync(ndjsonFd);
      console.error("\n❌ No languages were successfully processed");
      return {
        success: false,
        error: "No languages were successfully processed",
      };
    }

    // Step 2.5: Process config files (always run - these are few root-level files)
    const configStats = {
      totalConfigFiles: 0,
      byType: {
        json: 0,
        yaml: 0,
        docker: 0,
        env: 0,
        xml: 0,
        ini: 0,
        toml: 0,
        python: 0,
        gradle: 0,
        other: 0,
      },
      packageManagers: [],
      dockerInfo: {
        hasDockerfile: false,
        hasDockerCompose: false,
        services: [],
        exposedPorts: [],
      },
      buildTools: [],
      dependencies: { total: 0, production: 0, development: 0 },
    };

    try {
      const configData = analyzeConfigRepo(repoPath);
      if (configData && configData.length > 0) {
        for (const file of configData) {
          const filePath = path.join(repoPath, file.path);
          const loc = countLinesOfCode(filePath);
          totalLinesOfCode += loc;

          const baseFields = [
            "path",
            "fileName",
            "fileType",
            "size",
            "lines",
            "language",
          ];
          const metadata = {};
          Object.keys(file).forEach((key) => {
            if (!baseFields.includes(key)) {
              metadata[key] = file[key];
            }
          });

          const configFileData = {
            path: file.path,
            type: "config",
            language: "config",
            loc,
            metadata,
          };
          fs.writeSync(ndjsonFd, JSON.stringify(configFileData) + "\n");
          totalFiles++;
          configStats.totalConfigFiles++;

          if (
            file.fileType &&
            configStats.byType.hasOwnProperty(file.fileType)
          ) {
            configStats.byType[file.fileType]++;
          }
          if (file.fileName === "package.json" && file.packageInfo) {
            configStats.packageManagers.push("npm");
            if (file.packageInfo.dependencies)
              configStats.dependencies.production +=
                file.packageInfo.dependencies.length;
            if (file.packageInfo.devDependencies)
              configStats.dependencies.development +=
                file.packageInfo.devDependencies.length;
            configStats.dependencies.total =
              configStats.dependencies.production +
              configStats.dependencies.development;
          }
          if (file.fileType === "docker") {
            configStats.dockerInfo.hasDockerfile = true;
            if (file.dockerInfo && file.dockerInfo.exposedPorts)
              configStats.dockerInfo.exposedPorts.push(
                ...file.dockerInfo.exposedPorts,
              );
          }
          if (file.fileName && file.fileName.includes("docker-compose")) {
            configStats.dockerInfo.hasDockerCompose = true;
            if (file.dockerCompose && file.dockerCompose.services)
              configStats.dockerInfo.services.push(
                ...file.dockerCompose.services,
              );
            if (file.dockerCompose && file.dockerCompose.exposedPorts)
              configStats.dockerInfo.exposedPorts.push(
                ...file.dockerCompose.exposedPorts,
              );
          }
          if (file.fileName === "pom.xml") {
            configStats.packageManagers.push("maven");
            configStats.buildTools.push("maven");
            if (file.mavenInfo && file.mavenInfo.dependencyCount)
              configStats.dependencies.total += file.mavenInfo.dependencyCount;
          }
          if (file.fileName === "tsconfig.json")
            configStats.buildTools.push("typescript");
          if (file.fileType === "python") {
            if (file.fileName === "requirements.txt" && file.dependencyCount) {
              configStats.dependencies.total += file.dependencyCount;
              if (!configStats.packageManagers.includes("pip"))
                configStats.packageManagers.push("pip");
            }
            if (
              file.fileName === "Pipfile" &&
              !configStats.packageManagers.includes("pipenv")
            )
              configStats.packageManagers.push("pipenv");
            if (file.fileName === "setup.py")
              configStats.buildTools.push("setuptools");
          }
          if (file.fileType === "gradle") {
            if (!configStats.packageManagers.includes("gradle"))
              configStats.packageManagers.push("gradle");
            if (!configStats.buildTools.includes("gradle"))
              configStats.buildTools.push("gradle");
            if (file.dependencyCount)
              configStats.dependencies.total += file.dependencyCount;
          }
        }
      }
    } catch (err) {
      console.warn(`\n⚠️  Config file processing failed: ${err.message}`);
    }

    fs.closeSync(ndjsonFd);

    // Deduplicate config arrays
    configStats.packageManagers = [...new Set(configStats.packageManagers)];
    configStats.buildTools = [...new Set(configStats.buildTools)];
    configStats.dockerInfo.services = [
      ...new Set(configStats.dockerInfo.services),
    ];
    configStats.dockerInfo.exposedPorts = [
      ...new Set(configStats.dockerInfo.exposedPorts),
    ];

    // Add language file counts
    Object.entries(languageFileCount).forEach(([lang, count]) => {
      configStats.byType[lang] = count;
    });

    const projectMetaData = {
      repositoryPath: repoPath,
      repositoryName: path.basename(repoPath),
      analyzedLanguages,
      totalFiles,
      totalFunctions,
      totalClasses,
      totalLinesOfCode,
      configs: configStats,
      generatedAt: new Date().toISOString(),
      toolVersion: "1.0.0",
    };

    // Log summary
    console.log(`\n✅ Processing complete!`);
    console.log(`   - Languages: ${analyzedLanguages.join(", ")}`);
    console.log(`   - Total files: ${totalFiles}`);
    console.log(
      `   - Code files: ${totalFiles - configStats.totalConfigFiles}`,
    );
    console.log(`   - Config files: ${configStats.totalConfigFiles}`);
    console.log(`   - Total functions: ${totalFunctions}`);
    console.log(`   - Total classes: ${totalClasses}`);
    console.log(`   - Total lines of code: ${totalLinesOfCode}`);

    // Prepend projectMetaData using streaming (avoid reading entire file into memory)
    const tmpPath = ndjsonPath + ".tmp";
    const metaLine =
      JSON.stringify({ __type: "projectMetaData", ...projectMetaData }) + "\n";
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpPath);
      ws.write(metaLine);
      const rs = fs.createReadStream(ndjsonPath);
      rs.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      rs.on("error", reject);
    });
    fs.renameSync(tmpPath, ndjsonPath);

    // Streaming gzip (avoid loading entire file into memory)
    const gzipPath = ndjsonPath + ".gz";
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(ndjsonPath);
      const gzip = zlib.createGzip();
      const output = fs.createWriteStream(gzipPath);
      input.pipe(gzip).pipe(output);
      output.on("finish", resolve);
      output.on("error", reject);
    });

    // Remove the uncompressed NDJSON file
    fs.unlinkSync(ndjsonPath);
    console.log(`\n📦 Compressed NDJSON output: ${gzipPath}`);

    // Step 5: Generate descriptions if requested
    if (opts.generateDescriptions) {
      generateDescriptions(gzipPath, repoPath, opts, verbose);
    }

    // Step 6: Add metadata if requested
    if (opts.addMetadata) {
      addMetadata(gzipPath, repoPath, opts, verbose);
    }

    // Summary
    console.log(
      "\n╔════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║                    Processing Complete!                   ║",
    );
    console.log(
      "╚════════════════════════════════════════════════════════════╝",
    );
    console.log(
      `\n✅ Successfully processed ${languagesProcessed} language(s)`,
    );
    console.log(`📄 Output: ${gzipPath}`);
    console.log("\n🎉 All tasks completed successfully!");

    return {
      success: true,
      languagesDetected: languagesProcessed,
      outputPath: gzipPath,
    };
  } catch (err) {
    console.error("\n❌ Analysis failed:", err.message);
    if (err.stderr) {
      console.error("Error details:", err.stderr.toString());
    }
    console.error("\n💡 Troubleshooting:");
    console.error("   1. Make sure the repository path is correct");
    console.error(
      "   2. Check that tree-sitter modules are installed: npm rebuild",
    );
    console.error(
      "   3. Use --verbose flag to see detailed processing information",
    );
    console.error(
      "   4. On Windows, try running in WSL or Git Bash if issues persist",
    );
    return { success: false, error: err.message };
  }
}

// Export functions
module.exports = {
  autoDetectAndProcess,
  detectLanguages,
  processLanguage,
  mergeLanguageOutputs,
  mergeProjectMetaData,
  assembleOutputFromNdjson,
  generateDescriptions,
  addMetadata,
};
