const { execFile } = require("child_process");
const path = require("path");

/**
 * Runs generate-file-descriptions.js as an async child process.
 * Returns a promise that resolves when descriptions are generated.
 */
function generateDescriptionsAsync(outputJsonPath, repoPath, opts) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, "generate-file-descriptions.js");
    const args = [scriptPath, repoPath, outputJsonPath];

    args.push("--provider", opts.provider || "openai");

    if (opts.provider === "bedrock") {
      if (opts.awsAccessKey) args.push("--aws-access-key", opts.awsAccessKey);
      if (opts.awsSecretKey) args.push("--aws-secret-key", opts.awsSecretKey);
      if (opts.awsRegion) args.push("--aws-region", opts.awsRegion);
    } else if (opts.apiKey) {
      args.push("--api-key", opts.apiKey);
    }

    if (opts.model) args.push("--model", opts.model);
    if (opts.apiUrl) args.push("--api-url", opts.apiUrl);
    if (opts.maxConcurrent) args.push("--max-concurrent", String(opts.maxConcurrent));

    console.log(`Running description generation with provider: ${opts.provider}`);

    const child = execFile("node", args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);

      if (error) {
        reject(new Error(`Description generation failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Runs add-metadata.js as an async child process.
 * Returns a promise that resolves when metadata is added.
 */
function addMetadataAsync(outputJsonPath, repoPath, opts) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, "add-metadata.js");
    const args = [scriptPath, outputJsonPath, repoPath];

    args.push("--provider", opts.provider || "openai");

    if (opts.provider === "bedrock") {
      if (opts.awsAccessKey) args.push("--aws-access-key", opts.awsAccessKey);
      if (opts.awsSecretKey) args.push("--aws-secret-key", opts.awsSecretKey);
      if (opts.awsRegion) args.push("--aws-region", opts.awsRegion);
    } else if (opts.apiKey) {
      args.push("--api-key", opts.apiKey);
    }

    if (opts.model) args.push("--model", opts.model);
    if (opts.apiUrl) args.push("--api-url", opts.apiUrl);
    if (opts.mode) args.push("--mode", opts.mode);
    if (opts.maxConcurrent) args.push("--max-concurrent", String(opts.maxConcurrent));

    console.log(`Running metadata generation with provider: ${opts.provider}`);

    const child = execFile("node", args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);

      if (error) {
        reject(new Error(`Metadata generation failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { generateDescriptionsAsync, addMetadataAsync };
