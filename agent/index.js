import "dotenv/config";
import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static"

import ngrok from "@ngrok/ngrok"
import agent from "./ibm_agent.js"
import { transcribeRecording, synthesizeAgentResponseAudio, getLangchainAgent, generateReport } from "./agent.js";
import { UserMessage } from "beeai-framework/backend/message"
import { SYSTEM_PROMPT, WELCOME_GREETING, PERSONA_TEMPLATES } from "./prompts.js";
import { publishToChannel, client as redis, subscriber, channels } from "./services/redis.js";
import { client as _11labs } from "./services/11labs.js"
import { convertToPdf, separateTwilioRecording } from "./utils.js"
import fs from "node:fs/promises"

import twilio from "twilio"
import { createReadStream } from "node:fs";
import path from "node:path"
import { fileURLToPath } from "node:url"
import z from "zod"

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

const PORT = process.env.PORT || 8080
const DOMAIN = process.env.NGROK_DOMAIN
const WS_URL = `wss://${DOMAIN}/ws`

const requestSchema = z.object({
    ph: z.string().describe("The target user's phone number"),
    name: z.string().describe("The target user's name"),
    persona: z.string().describe("The name of the persona template to be adopted by the Agent"),
    mode: z.enum(["normal", "impersonation"]).default("normal").describe("Influences the nature of actions performed by the LLM Agent"),
    voice_id: z.string().default(process.env["ELEVENLABS_VOICE_ID"] || "Xb7hH8MSUJpSbSDYk0k2").describe("The ElevenLabs Voice ID")
})

const sessions = new Map()
const agents = new Map()

let details = await client.balance.fetch();
console.log("Account sid: %s\nBalance: %f %s", details.accountSid, details.balance, details.currency)

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fastify.register(fastifyStatic, {
    root: path.join(__dirname, "recordings"),
    prefix: "/recordings/"
})

fastify.register(fastifyStatic, {
    root: path.join(__dirname, "temp"),
    prefix: "/audio/",
    decorateReply: false
})

fastify.register(fastifyStatic, {
    root: path.join(__dirname, "reports"),
    prefix: "/reports_archive/",
    decorateReply: false
})

function updateConversationHistory(callSid, arr) {
    const conversation = sessions.get(callSid)
    conversation.push(...arr)
}

fastify.register(async function (fastify) {
    fastify.get("/ws", { websocket: true }, (ws, req) => {
        ws.on("message", async data => {
            const message = JSON.parse(data)
            console.log("Message:", message)
            const callSid = message.callSid;
            try {
                switch (message.type) {
                    case "setup":
                        const { persona, name, mode } = message.customParameters;

                        console.log("Setup for call:", callSid)
                        ws.callSid = callSid;
                        ws.mode = mode;

                        sessions.set(callSid, [{
                            role: "system",
                            content: SYSTEM_PROMPT
                        }])

                        if (mode === "normal") {
                            agent.memory.add(new UserMessage(`Persona: ${PERSONA_TEMPLATES[persona]}\nYou are now speaking with ${name}`))
                            agents.set(callSid, agent)
                        } else {
                            const agent = getLangchainAgent(persona.slice(0, persona.lastIndexOf("_")), name)
                            agents.set(callSid, agent)
                            const voiceId = await redis.hGet("persona", persona)
                            ws.voiceId = voiceId;
                        }

                        break;
                    case "prompt":
                        console.log("Processing prompt:", message.voicePrompt)
                        updateConversationHistory(ws.callSid, [
                            {
                                role: "user",
                                content: message.voicePrompt
                            }
                        ])

                        const _agent = agents.get(ws.callSid)

                        if (ws.mode === "normal") {
                            const response = await _agent.run({
                                prompt: message.voicePrompt
                            })

                            updateConversationHistory(ws.callSid, [
                                {
                                    role: "assistant",
                                    content: response.result.text
                                }
                            ])

                            ws.send(
                                JSON.stringify({
                                    type: "text",
                                    token: response.result.text,
                                    last: true
                                })
                            )
                        } else {
                            const { text: response } = await synthesizeAgentResponseAudio({ ws, callSid: ws.callSid, voiceId: ws.voiceId, agent: _agent }, message.voicePrompt)

                            updateConversationHistory(ws.callSid, [
                                {
                                    role: "assistant",
                                    content: response
                                }
                            ])
                        }

                        break;
                    case "interrupt":
                        console.log("Handling interruption...")
                        console.log(message.utteranceUntilInterrupt)
                        break;
                    default:
                        console.warn("Unknown message type received:", message.type)
                        break;
                }
            } catch (err) {
                console.error(`Error processing message for call (${callSid}):`, err.message)
            }
        });

        ws.on("close", async () => {
            console.log("Websocket connection closed")
            const transcript = generateTranscript(ws.callSid)
            await redis.hSet(`call:${ws.callSid}`, "original_transcript", transcript || "No Transcript Available")

            sessions.delete(ws.callSid)
            agents.delete(ws.callSid)
        })
    })
})

function generateTranscript(callSid) {
    const conversation = sessions.get(callSid);
    conversation.shift()

    return conversation.reduce((prev, cur) => prev + `${cur.role}: ${cur.content}\n`, "")
}

fastify.post("/twiml", async (request, reply) => {
    const { name, persona, mode, voice_id } = request.query;

    const response = new VoiceResponse()
    const connect = response.connect()

    const conversationRelay = connect.conversationRelay({
        url: WS_URL,
        welcomeGreeting: WELCOME_GREETING,
        ttsProvider: "ElevenLabs",
        voice: `${voice_id}`
    })

    conversationRelay.parameter({
        name: "persona",
        value: persona
    })

    conversationRelay.parameter({
        name: "name",
        value: name
    })

    conversationRelay.parameter({
        name: "mode",
        value: mode
    })

    reply.type("text/xml").send(conversationRelay.toString())
})

fastify.get("/personas", async (request, reply) => {
    reply.send({
        personas: {
            "normal": Object.keys(PERSONA_TEMPLATES),
            "impersonation": Object.keys(await redis.hGetAll('persona'))
        }
    })
})

fastify.get("/calls", async (request, reply) => {
    try {
        const keys = await redis.keys("call:*")
        const calls = await Promise.all(keys.map(async (key) => {
            const name = await redis.hGet(key, "name")
            const ph = await redis.hGet(key, "ph")
            return {
                name,
                ph,
                callSid: key.replace("call:", "")
            }
        }))

        reply.send({ calls, success: true })
    } catch (err) {
        reply.status(500).send({ error: err.message, success: false })
    }
})

fastify.get("/calls/:callSid", async (request, reply) => {
    try {
        const callSid = request.params.callSid
        const data = await redis.hGetAll(`call:${callSid}`)

        if (!data) {
            return reply.status(404).send({ error: "The provided CallSid does not exist", success: false })
        }

        reply.send({
            data,
            success: true
        })
    } catch (err) {
        reply.status(500).send({ error: err.message, success: false })
    }
})

fastify.get("/reports/:callSid", async (request, reply) => {
    try {
        const callSid = request.params.callSid
        const data = await redis.hGetAll(`call:${callSid}`)

        if (!data) {
            return reply.status(404).send({ error: "The provided CallSid does not exist", success: false })
        }

        reply.send({
            data: {
                timestamp: data.timestamp,
                report: data.report || "Report not found for the given CallSid",
                transcript: data["processed_transcript"] || data["original_transcript"],
                name: data.name,
                ph: data.ph
            },
            success: true
        })
    } catch (err) {
        reply.status(500).send({ error: err.message, success: false })
    }
})

async function createCall(ph, name, persona, mode = "normal", voice_id) {
    try {
        const call = await client.calls.create({
            to: ph,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: encodeURI(`https://${DOMAIN}/twiml?persona=${persona}&name=${name}&mode=${mode}&voice_id=${voice_id}`),
            // statusCallback: `${process.env.HOST_URL}/twilio/status`,
            // statusCallbackMethod: "POST",
            // statusCallbackEvent: ["initiated", "answered", "completed"],
            record: true,
            recordingChannels: "dual",
            recordingStatusCallback: `https://${DOMAIN}/recording-status`,
            recordingStatusCallbackMethod: "POST"
        })
        console.log("Call Initiated: %s", call.sid);
        return call
    } catch (err) {
        console.error(`Error placing a call to ${ph}:`, err.message)
        throw err
    }
}

fastify.post("/call", async (request, reply) => {
    try {
        const parsed = requestSchema.safeParse(request.body)

        if (!parsed.success) {
            return reply.status(400).send({
                success: false,
                message: parsed.error.message
            })
        }

        await publishToChannel("create_call", parsed.data)

        reply.status(201).send({
            success: true
        })
    } catch (err) {
        reply.status(500).send({
            error: err.message,
            success: false
        })
    }
})

fastify.post("/recording-status", async (request, reply) => {
    const {
        CallSid,
        RecordingSid,
        RecordingUrl,
    } = request.body;

    reply.code(200).send("OK")

    await publishToChannel("separate_recording", {
        CallSid,
        RecordingSid,
        RecordingUrl
    })
})

fastify.get("/", (request, reply) => {
    reply.send({
        message: "Welcome to the VishNet API Server !",
        success: true
    })
})

try {
    await subscriber.subscribe(channels, (message, channel) => {
        subscriber.emit('message', channel, message)
    })

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

subscriber.on("message", async (channel, message) => {
    console.log(`Received message on channel : ${channel}`)

    try {
        const msg = JSON.parse(message)
        const { data, timestamp } = msg

        if (channel === "create_call") {
            const { ph, persona, name, mode, voice_id } = data

            const call = await createCall(ph, name, persona, mode, voice_id)
            await redis.hSet(`call:${call.sid}`, { timestamp, ph, persona, name, mode, voice_id })
        } else if (channel === "separate_recording") {
            const { RecordingUrl, RecordingSid, CallSid } = data;
            const recordings = await separateTwilioRecording(RecordingUrl, RecordingSid)

            const { ph, name, original_transcript } = await redis.hGetAll(`call:${CallSid}`)

            await publishToChannel("transcribe_recording", {
                CallSid,
                recordings,
                ph,
                name,
                original_transcript
            })
        } else if (channel === "transcribe_recording") {
            const { recordings, CallSid, ph, name, original_transcript } = data;

            const audioBuffer = await fs.readFile(recordings.original, 'base64')
            const processed_transcript = (await transcribeRecording(original_transcript, audioBuffer))?.transcript

            await redis.hSet(`call:${CallSid}`, "processed_transcript", processed_transcript)

            await publishToChannel("generate_report", {
                CallSid,
                recordings,
                ph,
                name,
                transcript: processed_transcript || original_transcript
            })
        } else if (channel === "generate_report") {
            const { recordings, CallSid, ph, name, transcript } = data;

            console.log(`Generating report for call ${CallSid}...`)
            const audioBuffer = await fs.readFile(recordings.original, 'base64')
            const report = (await generateReport(transcript, audioBuffer))?.report

            await redis.hSet(`call:${CallSid}`, "report", report)

            await publishToChannel("send_report", {
                CallSid,
                ph,
                report
            })

            await publishToChannel("create_voice_clone", {
                CallSid,
                recordings,
                name
            })
        } else if (channel === "send_report") {
            const { CallSid, ph, report } = data;

            const filename = await convertToPdf(report, CallSid)
            const fileUrl = `https://${DOMAIN}/reports_archive/${filename}`
            console.log("Report URL:", fileUrl)

            await client.messages.create({
                body: "🔒 *VishNet Security Assessment Report*\n\nYour personalized vishing simulation analysis is ready. Please find the detailed report attached.\n\nReview the findings to understand potential vulnerabilities and improve your security posture.\n\nStay vigilant!",
                mediaUrl: [fileUrl],
                from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
                to: `whatsapp:${ph}`
            })
                .then(message => console.log(message.sid))

        } else if (channel === "create_voice_clone") {
            const { CallSid, recordings, name } = data;

            const clonedVoice = await _11labs.voices.ivc.create({
                name: `${name} - ${CallSid}`,
                files: [createReadStream(recordings.caller)],
                description: "Cloned voice created using VishNet",
                removeBackgroundNoise: true
            })

            console.log("Cloned Voice:", clonedVoice)
            await redis.hSet(`call:${CallSid}`, "voice", clonedVoice.voiceId)
            await redis.hSet(`persona`, `${name}_${CallSid}`, clonedVoice.voiceId)
        }
    } catch (err) {
        console.error(`Error processing Redis message on channel "${channel}":`, err.message)
    }
})