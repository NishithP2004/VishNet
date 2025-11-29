import "dotenv/config"

import { ReActAgent } from "beeai-framework/agents/react/agent"
// import { WatsonxChatModel } from "beeai-framework/adapters/watsonx/backend/chat"
// import { OllamaChatModel } from "beeai-framework/adapters/ollama/backend/chat"
import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { LangChainChatModel } from "beeai-framework/adapters/langchain/backend/chat";
import { UnconstrainedMemory } from "beeai-framework/memory/unconstrainedMemory"
import { SYSTEM_PROMPT } from "./prompts.js"
/* import { Logger } from "beeai-framework/logger/logger"
import { Emitter } from "beeai-framework/emitter/emitter"

Logger.defaults.pretty = true

const logger = Logger.root.child({
    level: "trace",
    name: "app"
})

Emitter.root.match("*.*", (data, event) => {
    const logLevel = event.path.includes(".run.") ? "trace": "info"
    logger[logLevel](`Event '${event.path}' triggered by '${event.creator.constructor.name}'`)
}) */

const agent = new ReActAgent({
    llm: new LangChainChatModel(new ChatGoogleGenerativeAI({
        model: "gemini-2.5-flash",
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
        prompt: "How many r's are there in strawberry?"
    })

console.log("Agent Response:", response.result.text) */

export default agent;