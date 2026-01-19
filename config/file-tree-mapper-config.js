/**
 * Config File Parser
 * Parses JSON, XML, Docker, and other configuration/deployment files
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");

// Patterns for config files to parse (root level only)
const CONFIG_PATTERNS = {
  json: ["package.json", "tsconfig.json", "jsconfig.json", "*.json"],
  yaml: ["*.yml", "*.yaml", "docker-compose.yml", "docker-compose.yaml"],
  docker: ["Dockerfile", "Dockerfile.*"],
  env: [".env", ".env.*"],
  ini: ["*.ini"],
  toml: ["*.toml", "pyproject.toml"],
  xml: ["*.xml", "pom.xml"],
  python: ["requirements.txt", "setup.py", "Pipfile"],
  gradle: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
  other: [".gitignore", ".dockerignore", "Makefile", "README.md", "README.rst", "LICENSE"]
};

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/build/**",
  "**/dist/**",
  "**/target/**",
  "**/.venv/**",
  "**/venv/**",
  "**/env/**",
  "**/__pycache__/**",
  "**/.eggs/**",
  "**/*.egg-info/**",
  "**/.git/**",
  "**/output/**",
  "**/test-output/**"
];

/**
 * Parse JSON file and extract metadata
 */
function parseJsonFile(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    const relativePath = path.relative(repoPath, filePath);
    const fileName = path.basename(filePath);

    const metadata = {
      path: relativePath,
      fileType: "json",
      fileName,
      size: fs.statSync(filePath).size
    };

    // Extract specific metadata for well-known JSON files
    if (fileName === "package.json") {
      metadata.packageInfo = {
        name: data.name,
        version: data.version,
        description: data.description,
        main: data.main,
        scripts: data.scripts ? Object.keys(data.scripts) : [],
        dependencies: data.dependencies ? Object.keys(data.dependencies) : [],
        devDependencies: data.devDependencies ? Object.keys(data.devDependencies) : []
      };
    } else if (fileName === "tsconfig.json" || fileName === "jsconfig.json") {
      metadata.compilerConfig = {
        target: data.compilerOptions?.target,
        module: data.compilerOptions?.module,
        outDir: data.compilerOptions?.outDir,
        rootDir: data.compilerOptions?.rootDir,
        strict: data.compilerOptions?.strict,
        include: data.include,
        exclude: data.exclude
      };
    } else {
      // Generic JSON - extract top-level keys
      metadata.topLevelKeys = Object.keys(data);
    }

    return metadata;
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "json",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse YAML file and extract metadata
 */
function parseYamlFile(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);
    const fileName = path.basename(filePath);

    const metadata = {
      path: relativePath,
      fileType: "yaml",
      fileName,
      size: fs.statSync(filePath).size,
      lines: content.split("\n").length
    };

    // For docker-compose files
    if (fileName.includes("docker-compose")) {
      const services = [];
      const lines = content.split("\n");
      let inServices = false;

      for (const line of lines) {
        if (line.match(/^services:/)) {
          inServices = true;
        } else if (inServices && line.match(/^  \w+:/)) {
          const serviceName = line.trim().replace(":", "");
          services.push(serviceName);
        } else if (line.match(/^\w+:/) && !line.match(/^services:/)) {
          inServices = false;
        }
      }

      metadata.dockerCompose = {
        services,
        serviceCount: services.length
      };

      // Extract ports and volumes
      const ports = [];
      const volumes = [];
      for (const line of lines) {
        if (line.match(/^\s+- ["']?\d+:\d+/)) {
          ports.push(line.trim().replace(/^-\s*["']?/, "").replace(/["']$/, ""));
        }
        if (line.match(/^\s+- [./]/)) {
          volumes.push(line.trim().replace(/^-\s*/, ""));
        }
      }

      if (ports.length > 0) metadata.dockerCompose.exposedPorts = ports;
      if (volumes.length > 0) metadata.dockerCompose.volumes = volumes;
    } else {
      // Generic YAML - extract basic structure
      const topLevelKeys = [];
      const lines = content.split("\n");

      for (const line of lines) {
        if (line.match(/^\w+:/) && !line.startsWith(" ")) {
          const key = line.split(":")[0].trim();
          topLevelKeys.push(key);
        }
      }

      metadata.topLevelKeys = topLevelKeys;
    }

    return metadata;
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "yaml",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse Dockerfile and extract metadata
 */
function parseDockerfile(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);
    const lines = content.split("\n");

    const metadata = {
      path: relativePath,
      fileType: "docker",
      fileName: path.basename(filePath),
      size: fs.statSync(filePath).size
    };

    const dockerInfo = {
      baseImages: [],
      exposedPorts: [],
      volumes: [],
      workdir: null,
      entrypoint: null,
      cmd: null,
      env: []
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("FROM ")) {
        const image = trimmed.replace("FROM ", "").split(" ")[0];
        dockerInfo.baseImages.push(image);
      } else if (trimmed.startsWith("EXPOSE ")) {
        const ports = trimmed.replace("EXPOSE ", "").split(" ");
        dockerInfo.exposedPorts.push(...ports);
      } else if (trimmed.startsWith("VOLUME ")) {
        const volume = trimmed.replace("VOLUME ", "");
        dockerInfo.volumes.push(volume);
      } else if (trimmed.startsWith("WORKDIR ")) {
        dockerInfo.workdir = trimmed.replace("WORKDIR ", "");
      } else if (trimmed.startsWith("ENTRYPOINT ")) {
        dockerInfo.entrypoint = trimmed.replace("ENTRYPOINT ", "");
      } else if (trimmed.startsWith("CMD ")) {
        dockerInfo.cmd = trimmed.replace("CMD ", "");
      } else if (trimmed.startsWith("ENV ")) {
        const envVar = trimmed.replace("ENV ", "").split(" ")[0].split("=")[0];
        dockerInfo.env.push(envVar);
      }
    }

    metadata.dockerInfo = dockerInfo;
    return metadata;
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "docker",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse .env file and extract metadata
 */
function parseEnvFile(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);
    const lines = content.split("\n");

    const variables = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const varName = trimmed.split("=")[0];
        if (varName) {
          variables.push(varName);
        }
      }
    }

    return {
      path: relativePath,
      fileType: "env",
      fileName: path.basename(filePath),
      size: fs.statSync(filePath).size,
      variableCount: variables.length,
      variables
    };
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "env",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse XML file and extract metadata
 */
function parseXmlFile(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);
    const fileName = path.basename(filePath);

    const metadata = {
      path: relativePath,
      fileType: "xml",
      fileName,
      size: fs.statSync(filePath).size
    };

    // Extract root element
    const rootMatch = content.match(/<(\w+)[>\s]/);
    if (rootMatch) {
      metadata.rootElement = rootMatch[1];
    }

    // For pom.xml (Maven)
    if (fileName === "pom.xml") {
      const groupIdMatch = content.match(/<groupId>(.*?)<\/groupId>/);
      const artifactIdMatch = content.match(/<artifactId>(.*?)<\/artifactId>/);
      const versionMatch = content.match(/<version>(.*?)<\/version>/);

      metadata.mavenInfo = {
        groupId: groupIdMatch ? groupIdMatch[1] : null,
        artifactId: artifactIdMatch ? artifactIdMatch[1] : null,
        version: versionMatch ? versionMatch[1] : null
      };

      // Count dependencies
      const dependencyMatches = content.match(/<dependency>/g);
      metadata.mavenInfo.dependencyCount = dependencyMatches ? dependencyMatches.length : 0;
    }

    return metadata;
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "xml",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse Python config files (requirements.txt, setup.py, Pipfile)
 */
function parsePythonConfig(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);
    const fileName = path.basename(filePath);

    const metadata = {
      path: relativePath,
      fileType: "python",
      fileName,
      size: fs.statSync(filePath).size
    };

    if (fileName === "requirements.txt") {
      // Count dependencies in requirements.txt
      const lines = content.split("\n").filter(line => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-");
      });
      metadata.dependencyCount = lines.length;
      metadata.dependencies = lines.map(line => line.split("==")[0].split(">=")[0].split("<=")[0].trim());
    } else if (fileName === "setup.py") {
      // Extract package name and version from setup.py
      const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
      const versionMatch = content.match(/version\s*=\s*["']([^"']+)["']/);
      metadata.packageInfo = {
        name: nameMatch ? nameMatch[1] : null,
        version: versionMatch ? versionMatch[1] : null
      };
    } else if (fileName === "Pipfile") {
      metadata.packageManager = "pipenv";
      // Count packages section
      const packagesMatch = content.match(/\[packages\]/);
      if (packagesMatch) {
        metadata.hasPipenv = true;
      }
    }

    return metadata;
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "python",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse Gradle build files
 */
function parseGradleConfig(filePath, repoPath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);
    const fileName = path.basename(filePath);

    const metadata = {
      path: relativePath,
      fileType: "gradle",
      fileName,
      size: fs.statSync(filePath).size
    };

    // Count dependencies
    const dependencyMatches = content.match(/implementation|api|compile|testImplementation/g);
    metadata.dependencyCount = dependencyMatches ? dependencyMatches.length : 0;

    // Check for Kotlin DSL
    metadata.isKotlinDSL = fileName.endsWith(".kts");

    return metadata;
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType: "gradle",
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Parse generic config file (INI, TOML, other)
 */
function parseGenericConfig(filePath, repoPath, fileType) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relativePath = path.relative(repoPath, filePath);

    return {
      path: relativePath,
      fileType,
      fileName: path.basename(filePath),
      size: fs.statSync(filePath).size,
      lines: content.split("\n").length
    };
  } catch (err) {
    return {
      path: path.relative(repoPath, filePath),
      fileType,
      fileName: path.basename(filePath),
      error: `Failed to parse: ${err.message}`
    };
  }
}

/**
 * Main function to analyze config files in repository (root level only)
 */
function analyzeConfigRepo(repoPath) {
  console.log("\n📋 Analyzing root-level configuration files...");

  const configFiles = [];
  const stats = {
    json: 0,
    yaml: 0,
    docker: 0,
    env: 0,
    xml: 0,
    ini: 0,
    toml: 0,
    python: 0,
    gradle: 0,
    other: 0
  };

  // Process each config type (root level only)
  for (const [configType, patterns] of Object.entries(CONFIG_PATTERNS)) {
    for (const pattern of patterns) {
      // Use cwd option to search only in the root directory
      const files = glob.sync(pattern, {
        cwd: repoPath,
        absolute: true,
        nodir: true,
        dot: true // Include dotfiles like .env
      });

      for (const file of files) {
        // Double-check that file is actually in root directory (not subdirectory)
        const relativePath = path.relative(repoPath, file);
        if (relativePath.includes(path.sep)) {
          // Skip files in subdirectories
          continue;
        }

        let metadata;

        switch (configType) {
          case "json":
            metadata = parseJsonFile(file, repoPath);
            stats.json++;
            break;
          case "yaml":
            metadata = parseYamlFile(file, repoPath);
            stats.yaml++;
            break;
          case "docker":
            metadata = parseDockerfile(file, repoPath);
            stats.docker++;
            break;
          case "env":
            metadata = parseEnvFile(file, repoPath);
            stats.env++;
            break;
          case "xml":
            metadata = parseXmlFile(file, repoPath);
            stats.xml++;
            break;
          case "ini":
            metadata = parseGenericConfig(file, repoPath, "ini");
            stats.ini++;
            break;
          case "toml":
            metadata = parseGenericConfig(file, repoPath, "toml");
            stats.toml++;
            break;
          case "python":
            metadata = parsePythonConfig(file, repoPath);
            stats.python++;
            break;
          case "gradle":
            metadata = parseGradleConfig(file, repoPath);
            stats.gradle++;
            break;
          case "other":
            metadata = parseGenericConfig(file, repoPath, "other");
            stats.other++;
            break;
        }

        if (metadata) {
          configFiles.push(metadata);
        }
      }
    }
  }

  console.log(`   Found ${configFiles.length} root-level configuration files:`);
  if (stats.json > 0) console.log(`   - JSON: ${stats.json}`);
  if (stats.yaml > 0) console.log(`   - YAML: ${stats.yaml}`);
  if (stats.docker > 0) console.log(`   - Docker: ${stats.docker}`);
  if (stats.xml > 0) console.log(`   - XML: ${stats.xml}`);
  if (stats.python > 0) console.log(`   - Python: ${stats.python}`);
  if (stats.gradle > 0) console.log(`   - Gradle: ${stats.gradle}`);
  if (stats.env > 0) console.log(`   - ENV: ${stats.env}`);
  if (stats.ini > 0) console.log(`   - INI: ${stats.ini}`);
  if (stats.toml > 0) console.log(`   - TOML: ${stats.toml}`);
  if (stats.other > 0) console.log(`   - Other: ${stats.other}`);

  return configFiles;
}

module.exports = {
  analyzeConfigRepo
};
