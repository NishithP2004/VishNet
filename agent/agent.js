import "dotenv/config"
import { createAgent, toolStrategy, HumanMessage } from "langchain"
import { MemorySaver } from "@langchain/langgraph"
// import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { ChatGoogleGenerativeAIEx } from "@h1deya/langchain-google-genai-ex"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import z from "zod"
import { IMPERSONATION_PROMPT, SYSTEM_PROMPT, TRANSCRIPT_GENERATION_PROMPT } from "./prompts.js"
import { randomBytes } from "node:crypto"
// import { convertMulawBufferToBuffer } from "./utils.js"
// import fs from "node:fs/promises"
import { createAudioWriteStream } from "./utils.js"
import { Readable } from "node:stream"
import { client as _11labs } from "./services/11labs.js"

const model = new ChatGoogleGenerativeAIEx({ // new ChatGoogleGenerativeAI({})
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    temperature: 0.7
})

const client = new MultiServerMCPClient({
    neo4j_memory_mcp: {
        transport: "http",
        url: process.env["NEO4J_MEMORY_MCP"],
        type: "http"
    }
})

const tools = await client.getTools()

const transcriptionAgent = createAgent({
    model,
    systemPrompt: TRANSCRIPT_GENERATION_PROMPT,
    tools,
    responseFormat: toolStrategy(z.object({
        transcript: z.string()
    }))
})

const checkpointer = new MemorySaver()

const agent = createAgent({
    model,
    systemPrompt: SYSTEM_PROMPT + "\n\n" + IMPERSONATION_PROMPT,
    checkpointer,
    tools
})

async function transcribeRecording(transcript, audioBuffer) {
    try {
        const humanMessage = new HumanMessage({
            content: [
                {
                    type: "text",
                    text: transcript
                },
                {
                    type: "audio",
                    source_type: "base64",
                    mime_type: "audio/wav",
                    data: audioBuffer
                }
            ]
        })

        const result = await transcriptionAgent.invoke({
            messages: humanMessage
        })

        return result.structuredResponse
    } catch (err) {
        console.error("Error transcribing discussion:", err.message)
        throw err
    }
}

// await fs.writeFile("diagram.png", await agent.drawMermaidPng())

/**
 * Generate the agent's text response for the given input and synthesize it to audio.
 * Writes audio to disk and notifies the websocket to play it.
 *
 * Inputs:
 * - context: { ws, callSid, voiceId, agent }
 * - text: prompt text from the user
 * - options: { ttsModelId?, outputFormat? }
 *
 * Output: { text: string, filename: string, url: string }
 */
async function synthesizeAgentResponseAudio(context, text, options = {}) {
    const { ws, callSid, voiceId, agent: _agent } = context;
    const {
        ttsModelId = "eleven_multilingual_v2",
        outputFormat = "mp3_22050_32"
    } = options;

    const selectedVoiceId = voiceId || process.env.ELEVENLABS_VOICE_ID || "Xb7hH8MSUJpSbSDYk0k2";

    // Prepare output file stream
    const { stream: audioWriteStream, filename } = createAudioWriteStream(callSid);

    // Build the message for the agent
    const humanMessage = new HumanMessage({
        content: [
            { type: "text", text }
        ]
    });

    // Aggregate streamed tokens into a single string (defensive on types)
    const chunks = [];

    try {
        const stream = await _agent.stream(
            { messages: humanMessage },
            { streamMode: "messages", configurable: { thread_id: `user_${randomBytes(4).toString("hex")}` } }
        );

        for await (const [token/*, metadata*/] of stream) {
            const content = token?.content;
            if (typeof content === "string") {
                chunks.push(content);
            } else if (Array.isArray(content)) {
                const parts = content
                    .map(c => (typeof c === "string" ? c : c?.text ?? ""))
                    .filter(Boolean);
                if (parts.length) chunks.push(parts.join(""));
            } else if (content && typeof content === "object" && typeof content.text === "string") {
                chunks.push(content.text);
            }
        }

        const aiResponse = chunks.join("");

        // Convert to speech using ElevenLabs
        const audio = await _11labs.textToSpeech.convert(selectedVoiceId, {
            text: aiResponse,
            modelId: ttsModelId,
            outputFormat
        });

        const url = `https://${process.env.NGROK_DOMAIN}/audio/${filename}`;

        await new Promise(async (resolve, reject) => {
            try {
                let readableNode;
                // If ElevenLabs returns a Web ReadableStream, convert it to a Node Readable
                if (audio && typeof audio?.getReader === 'function') {
                    readableNode = Readable.fromWeb(audio);
                } else if (audio && typeof audio?.pipe === 'function') {
                    // Already a Node stream
                    readableNode = audio;
                } else if (audio?.body && typeof audio.body?.getReader === 'function') {
                    // Some SDKs return a Response-like object
                    readableNode = Readable.fromWeb(audio.body);
                } else {
                    return reject(new Error('Unexpected audio stream type from ElevenLabs'));
                }

                readableNode.once('error', reject);
                audioWriteStream.once('error', reject);
                audioWriteStream.once('finish', () => {
                    try {
                        ws?.send?.(JSON.stringify({
                            type: "play",
                            source: url,
                            loop: 1,
                            preemptible: false,
                            interruptible: true
                        }));
                    } catch (e) {
                        console.error("Failed to send play message:", e.message);
                    }
                    resolve();
                });

                readableNode.pipe(audioWriteStream);
            } catch (e) {
                reject(e);
            }
        });

        return { text: aiResponse, filename, url };
    } catch (err) {
        console.error("Error generating response:", err.message);
        throw err;
    }
}

export { transcribeRecording, synthesizeAgentResponseAudio, agent }