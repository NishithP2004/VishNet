import "dotenv/config"

import { ReActAgent } from "beeai-framework/agents/react/agent"
import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { LangChainChatModel } from "beeai-framework/adapters/langchain/backend/chat";
import { UnconstrainedMemory } from "beeai-framework/memory/unconstrainedMemory"
import { SYSTEM_PROMPT } from "./prompts.js"

/* import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPTool } from "beeai-framework/tools/mcp" 

const client = new Client(
    {
        name: "neo4j-memory-mcp",
        version: "1.0.0"
    }
)

await client.connect(
    new StreamableHTTPClientTransport(process.env["NEO4J_MEMORY_MCP"])
)

const tools = await MCPTool.fromClient(client) */

const agent = new ReActAgent({
    llm: new LangChainChatModel(new ChatGoogleGenerativeAI({
        model: process.env["GEMINI_MODEL"] || "gemini-2.5-flash",
        apiKey: process.env["GOOGLE_API_KEY"]
    })),
    memory: new UnconstrainedMemory(),
    tools: [],
    templates: {
        system: (template) =>
            template.fork((config) => {
                config.defaults.instructions = SYSTEM_PROMPT
            })
    },
    stream: true
})

/* const response = await agent
    .run({
        prompt: "How many r's are there in the word strawberry ?"
    })
 
console.log("Agent Response:", response.result.text) */

export default agent;