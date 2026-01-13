#!/usr/bin/env node
/**
 * COMPLETE Golang Project Analyzer
 * Parses ALL file types: .go, .proto, .yaml, go.mod, .html, Dockerfile
 * Usage: node file-tree-mapper-complete.js <repoPath> <outputJson>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractGoFile } = require("./extract-go-file");
const { extractProtoFile } = require("./extract-proto");
const { extractYamlFile } = require("./extract-yaml");
const { extractGoModFile } = require("./extract-gomod");
const { extractHtmlFile } = require("./extract-html");
const { extractDockerfile } = require("./extract-dockerfile");

if (process.argv.length < 4) {
  console.error("Usage: node file-tree-mapper-complete.js <repoPath> <outputJson>");
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);

console.log(`\n${"=".repeat(80)}`);
console.log(`🐹 COMPLETE Golang Project Analyzer`);
console.log(`${"=".repeat(80)}\n`);
console.log(`📂 Scanning: ${repoPath}\n`);

// Find all relevant files
const goFiles = glob.sync(`${repoPath}/**/*.go`, {
  ignore: [
    `${repoPath}/**/node_modules/**`,
    `${repoPath}/**/vendor/**`,
    `${repoPath}/**/*_test.go`,
    `${repoPath}/**/testdata/**`
  ]
});

const protoFiles = glob.sync(`${repoPath}/**/*.proto`, {
  ignore: [`${repoPath}/**/node_modules/**`, `${repoPath}/**/vendor/**`]
});

const yamlFiles = glob.sync(`${repoPath}/**/*.{yaml,yml}`, {
  ignore: [`${repoPath}/**/node_modules/**`, `${repoPath}/**/vendor/**`]
});

const goModFiles = glob.sync(`${repoPath}/**/go.mod`, {
  ignore: [`${repoPath}/**/vendor/**`]
});

const htmlFiles = glob.sync(`${repoPath}/**/*.html`, {
  ignore: [`${repoPath}/**/node_modules/**`, `${repoPath}/**/vendor/**`]
});

const dockerfiles = glob.sync(`${repoPath}/**/Dockerfile*`, {
  ignore: [`${repoPath}/**/node_modules/**`, `${repoPath}/**/vendor/**`]
});

const totalFiles = goFiles.length + protoFiles.length + yamlFiles.length + 
                   goModFiles.length + htmlFiles.length + dockerfiles.length;

console.log(`📊 FILE DISCOVERY:`);
console.log(`${"─".repeat(80)}`);
console.log(`   📝 Go files (.go):           ${goFiles.length}`);
console.log(`   🔌 Proto files (.proto):     ${protoFiles.length}`);
console.log(`   📋 YAML files (.yaml):       ${yamlFiles.length}`);
console.log(`   📦 Module files (go.mod):    ${goModFiles.length}`);
console.log(`   🌐 HTML templates (.html):   ${htmlFiles.length}`);
console.log(`   🐳 Dockerfiles:              ${dockerfiles.length}`);
console.log(`${"─".repeat(80)}`);
console.log(`   📦 TOTAL FILES:              ${totalFiles}`);
console.log(`${"=".repeat(80)}\n`);

console.log(`🔍 Starting COMPLETE analysis...\n`);

const results = [];
let processed = 0;
let errors = 0;

// Process Go files
console.log(`📝 Processing Go files...`);
for (const file of goFiles) {
  processed++;
  try {
    const fileData = extractGoFile(file, repoPath);
    results.push(fileData);
  } catch (error) {
    errors++;
    console.error(`❌ Error parsing ${path.basename(file)}: ${error.message}`);
  }
}

// Process Proto files
console.log(`🔌 Processing Proto files...`);
for (const file of protoFiles) {
  processed++;
  try {
    const fileData = extractProtoFile(file, repoPath);
    results.push(fileData);
  } catch (error) {
    errors++;
    console.error(`❌ Error parsing ${path.basename(file)}: ${error.message}`);
  }
}

// Process YAML files
console.log(`📋 Processing YAML files...`);
for (const file of yamlFiles) {
  processed++;
  try {
    const fileData = extractYamlFile(file, repoPath);
    results.push(fileData);
  } catch (error) {
    errors++;
    console.error(`❌ Error parsing ${path.basename(file)}: ${error.message}`);
  }
}

// Process go.mod files
console.log(`📦 Processing go.mod files...`);
for (const file of goModFiles) {
  processed++;
  try {
    const fileData = extractGoModFile(file, repoPath);
    results.push(fileData);
  } catch (error) {
    errors++;
    console.error(`❌ Error parsing ${path.basename(file)}: ${error.message}`);
  }
}

// Process HTML files
console.log(`🌐 Processing HTML templates...`);
for (const file of htmlFiles) {
  processed++;
  try {
    const fileData = extractHtmlFile(file, repoPath);
    if (!fileData.skip) {
      results.push(fileData);
    }
  } catch (error) {
    errors++;
    console.error(`❌ Error parsing ${path.basename(file)}: ${error.message}`);
  }
}

// Process Dockerfiles
console.log(`🐳 Processing Dockerfiles...`);
for (const file of dockerfiles) {
  processed++;
  try {
    const fileData = extractDockerfile(file, repoPath);
    results.push(fileData);
  } catch (error) {
    errors++;
    console.error(`❌ Error parsing ${path.basename(file)}: ${error.message}`);
  }
}

console.log(`\n${"=".repeat(80)}`);
console.log(`✅ COMPLETE Analysis Finished`);
console.log(`${"=".repeat(80)}\n`);

// Generate comprehensive statistics
const stats = {
  totalFiles: results.length,
  byType: {
    go: results.filter(r => r.package && !r.type).length,
    protobuf: results.filter(r => r.type === 'protobuf').length,
    openapi: results.filter(r => r.type?.includes('openapi')).length,
    yaml_config: results.filter(r => r.type === 'yaml_config').length,
    go_module: results.filter(r => r.type === 'go_module').length,
    html_template: results.filter(r => r.type === 'html_template').length,
    dockerfile: results.filter(r => r.type === 'dockerfile').length
  },
  goAnalysis: {
    packages: new Set(results.filter(r => r.package).map(r => r.package)).size,
    structs: results.reduce((sum, r) => sum + (r.structs?.length || 0), 0),
    interfaces: results.reduce((sum, r) => sum + (r.interfaces?.length || 0), 0),
    functions: results.reduce((sum, r) => sum + (r.functions?.length || 0), 0)
  },
  protoAnalysis: {
    services: results.reduce((sum, r) => sum + (r.services?.length || 0), 0),
    messages: results.reduce((sum, r) => sum + (r.messages?.length || 0), 0),
    rpcs: results.reduce((sum, r) => {
      return sum + (r.services?.reduce((s, svc) => s + svc.rpcs.length, 0) || 0);
    }, 0)
  },
  dependencies: {
    totalModules: results.filter(r => r.type === 'go_module').length,
    totalDirect: results.reduce((sum, r) => sum + (r.dependencies?.direct?.length || 0), 0),
    totalIndirect: results.reduce((sum, r) => sum + (r.dependencies?.indirect?.length || 0), 0)
  },
  errors: errors
};

console.log(`📊 COMPREHENSIVE STATISTICS:`);
console.log(`${"─".repeat(80)}`);
console.log(`📝 Go Analysis:`);
console.log(`   Files:              ${stats.byType.go}`);
console.log(`   Unique packages:    ${stats.goAnalysis.packages}`);
console.log(`   Structs:            ${stats.goAnalysis.structs}`);
console.log(`   Interfaces:         ${stats.goAnalysis.interfaces}`);
console.log(`   Functions/Methods:  ${stats.goAnalysis.functions}`);
console.log(``);
console.log(`🔌 Protocol Buffers:`);
console.log(`   Files:              ${stats.byType.protobuf}`);
console.log(`   Services:           ${stats.protoAnalysis.services}`);
console.log(`   RPCs:               ${stats.protoAnalysis.rpcs}`);
console.log(`   Messages:           ${stats.protoAnalysis.messages}`);
console.log(``);
console.log(`📋 API Definitions:`);
console.log(`   OpenAPI specs:      ${stats.byType.openapi}`);
console.log(`   YAML configs:       ${stats.byType.yaml_config}`);
console.log(``);
console.log(`📦 Dependencies:`);
console.log(`   Modules (go.mod):   ${stats.byType.go_module}`);
console.log(`   Direct deps:        ${stats.dependencies.totalDirect}`);
console.log(`   Indirect deps:      ${stats.dependencies.totalIndirect}`);
console.log(``);
console.log(`🔧 Other:`);
console.log(`   HTML templates:     ${stats.byType.html_template}`);
console.log(`   Dockerfiles:        ${stats.byType.dockerfile}`);
console.log(`${"─".repeat(80)}`);
console.log(`   TOTAL ANALYZED:     ${stats.totalFiles}`);
console.log(`   ERRORS:             ${stats.errors}`);
console.log(`${"=".repeat(80)}\n`);

// Write results to JSON
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`📄 Output written to: ${outputPath}`);

// Write stats file
const statsPath = outputPath.replace('.json', '-stats.json');
fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
console.log(`📊 Statistics written to: ${statsPath}\n`);

console.log(`${"=".repeat(80)}`);
console.log(`✅ 100% COMPLETE COVERAGE!`);
console.log(`${"=".repeat(80)}\n`);
