import "dotenv/config";
import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormbody from "@fastify/formbody";

import ngrok from "@ngrok/ngrok"
import agent from "./agent.js"
import { UserMessage } from "beeai-framework/backend/message"
import { SYSTEM_PROMPT, WELCOME_GREETING, PERSONA_TEMPLATES } from "./prompts.js";

import twilio from "twilio"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

const PORT = process.env.PORT || 8080
const DOMAIN = process.env.NGROK_URL
const WS_URL = `wss://${DOMAIN}/ws`
const sessions = new Map()
const agents = new Map()

let details = await client.balance.fetch();
console.log("Account sid: %s\nBalance: %f %s", details.accountSid, details.balance, details.currency)

// const base64Auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64")

const fastify = new Fastify({
    logger: {
        transport: {
            target: "pino-pretty",
            options: {
                colorize: true
            }
        }
    }
})

fastify.register(fastifyWs)
fastify.register(fastifyFormbody)

fastify.register(async function (fastify) {
    fastify.get("/ws", { websocket: true }, (ws, req) => {
        ws.on("message", async data => {
            const message = JSON.parse(data)
            console.log("Message:", message)

            switch (message.type) {
                case "setup":
                    const callSid = message.callSid;
                    console.log("Setup for call:", callSid)
                    ws.callSid = callSid;
                    sessions.set(callSid, [{
                        role: "system",
                        content: SYSTEM_PROMPT
                    }])
                    agent.memory.add(new UserMessage(`Persona: ${PERSONA_TEMPLATES["Sales Executive"]}`))

                    agents.set(callSid, agent)
                    break;
                case "prompt":
                    console.log("Processing prompt:", message.voicePrompt)
                    const conversation = sessions.get(ws.callSid)
                    conversation.push({
                        role: "user",
                        content: message.voicePrompt
                    })

                    const _agent = agents.get(ws.callSid)
                    const response = await _agent.run({
                        prompt: message.voicePrompt,
                    })

                    conversation.push({
                        role: "assistant",
                        content: response.result.text
                    })

                    ws.send(
                        JSON.stringify({
                            type: "text",
                            token: response.result.text,
                            last: true
                        })
                    )

                    break;
                case "interrupt":
                    console.log("Handling interruption...")
                    console.log(message.voicePrompt)
                    break;
                default:
                    console.warn("Unknown message type received:", message.type)
                    break;
            }
        });

        ws.on("close", () => {
            console.log("Websocket connection closed")
            sessions.delete(ws.callSid)
        })
    })
})

fastify.post("/twiml", async (request, reply) => {
    const response = new VoiceResponse()
    const connect = response.connect()
    const conversationRelay = connect.conversationRelay({
        url: WS_URL,
        welcomeGreeting: WELCOME_GREETING,
    })

    reply.type("text/xml").send(conversationRelay.toString())
})

fastify.post("/call", async (request, reply) => {
    try {
        const ph = request.body.ph;
        const call = await client.calls.create({
            to: ph,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: `https://${DOMAIN}/twiml`,
            // statusCallback: `${process.env.HOST_URL}/twilio/status`,
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["initiated", "answered", "completed"],
            record: true,
            recordingChannels: "dual",
            recordingStatusCallback: `https://${DOMAIN}/recording-status`,
            recordingStatusCallbackMethod: "POST"
        })

        console.log("Call Initiated: %s", call.sid);

        reply.status(201).send({
            success: true,
            sid: call.sid
        })
    } catch (err) {
        reply.status(500).send({
            error: err.message,
            success: false
        })
    }
})

fastify.post("/recording-status", (request, reply) => {
    const { 
        CallSid,
        RecordingSid,
        RecordingUrl,
        RecordingStatus,
        RecordingDuration 
    } = request.body;

    console.log(request.body)

    reply.code(200).send("OK")
})

try {
    fastify.listen({ port: PORT })
    await ngrok.connect({
        authtoken_from_env: true,
        port: PORT,
        proto: "http",
        domain: DOMAIN
    })

    console.log(`Server running at http://localhost:${PORT} and wss://${DOMAIN}/ws`)
} catch (err) {
    fastify.log.error(err)
    process.exit(1)
}