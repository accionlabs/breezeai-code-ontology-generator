require("dotenv").config();


module.exports = {
    API_KEY: process.env.API_KEY,
    BREEZE_API_URL: process.env.BREEZE_API_URL,
    // LLM provider credentials
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AWS_ACCESS_KEY: process.env.AWS_ACCESS_KEY,
    AWS_SECRET_KEY: process.env.AWS_SECRET_KEY,
    AWS_REGION: process.env.AWS_REGION || "us-west-2",
 };