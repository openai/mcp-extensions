import { App } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const app = new App({ name: "sql-query-builder", version: "0.1.0" });
const openai = new OpenAIExtensions(app);

export { app, openai };
