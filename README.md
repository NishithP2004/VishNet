# VishNet

VishNet is a voice-based social engineering simulation and training platform. It orchestrates AI voice phishing (vishing) scenarios using configurable persona templates, real-time LLM responses, voice cloning, call transcription, and a knowledge graph for extracting and storing sensitive entities (PII) for post-exercise analysis.

> IMPORTANT: This project contains powerful social engineering capabilities. Use only for authorized security awareness training with explicit consent. Never deploy against real users without prior written approval. Remove any hard‑coded secrets before sharing the code.

## ✨ Key Features

- **Persona-Driven Vishing Simulation** – Rich persona prompt templates under `agent/personas/` guide realistic, psychologically sophisticated interactions.
- **Dual Operation Modes** – `normal` (generic helpful agent) and `impersonation` (persona-based identity + cloned voice) for advanced realism.
- **Real-Time LLM Agent** – Gemini model (via LangChain) streams responses; optional LangGraph agent for impersonation workflows.
- **Voice Cloning & TTS** – ElevenLabs used to create a cloned voice from the caller's channel and synthesize agent replies.
- **Call Handling via Twilio** – Automated outbound calls, WebSocket conversation relay, call recording, dual-channel audio separation.
- **Audio Processing Pipeline** – Separates caller/recipient channels with `ffmpeg`, performs transcription + correction.
- **Knowledge Graph Integration (Neo4j)** – Extracted PII relationships can be sent to a Neo4j memory MCP server via Model Context Protocol (MCP) tools.
- **Redis Pub/Sub Orchestration** – Event-driven pipeline for call lifecycle: create call → recording split → transcription → voice clone → playback.
- **Ngrok Exposure** – Secure public URL for Twilio callbacks and WebSocket relay during development.

## 🏗 Architecture Overview

```
User <-phone-> Twilio Conversation Relay <-> Fastify Server (WebSocket / REST)
																	 │
																	 ├─ Redis Pub/Sub Events
																	 │      create_call
																	 │      separate_recording
																	 │      transcribe_recording
																	 │      create_voice_clone
																	 │
																	 ├─ LLM Agents (Gemini via LangChain / LangGraph)
																	 │
																	 ├─ ElevenLabs (voice clone + TTS)
																	 │
																	 └─ Neo4j Memory MCP (for transcript + PII graph enrichment)
```

### Flow Summary
1. `/call` endpoint publishes `create_call` event.
2. Twilio places the call; `/twiml` configures a WebSocket conversation relay.
3. User speech → agent prompt via WebSocket (`prompt` messages).
4. Responses streamed; optionally synthesized to audio and pushed back as a `play` command.
5. When recording completes, Twilio POSTs to `/recording-status` → events trigger audio separation & transcription.
6. Transcript is corrected; voice clone created; persona voice stored in Redis for reuse.
7. Extracted PII can be mapped into Neo4j (tool invocation inside agent chains).

## 📂 Repository Structure

```
docker-compose.yaml         # Multi-service runtime: agent, redis, neo4j, neo4j-memory-mcp
agent/
  index.js                 # Fastify server entrypoint & WebSocket handlers
  agent.js                 # LangGraph-based impersonation + transcription agent logic
  ibm_agent.js             # ReAct agent (normal mode)
  prompts.js               # System + persona prompt templates
  services/redis.js        # Redis connection + pub/sub channels
  services/11labs.js       # ElevenLabs API client wrapper
  utils.js                 # Audio processing helpers (ffmpeg, channel separation, TTS file writing)
  personas/*.md            # Persona definitions (training scenarios)
  recordings/              # Stored/raw separated call audio
  temp/                    # Generated TTS audio files
  package.json             # Dependencies and scripts
README.md
```

## ⚙️ Environment Variables

Create `agent/.env` from the provided template (`agent/.env.example`). Do **NOT** commit real secrets.

| Variable | Purpose |
|----------|---------|
| `GOOGLE_API_KEY` | Gemini model access |
| `GEMINI_MODEL` | Model name (e.g. `gemini-2.5-flash`) |
| `TWILIO_SID`, `TWILIO_AUTH_TOKEN` | Auth for Twilio REST + recording download |
| `TWILIO_PHONE_NUMBER` | Verified Twilio outbound number |
| `ELEVENLABS_API_KEY` | ElevenLabs voice clone & TTS |
| `NGROK_DOMAIN` | Public domain for callbacks (e.g. `your-app.ngrok-free.app`) |
| `NGROK_AUTHTOKEN` | Ngrok auth token (optional if already set globally) |
| `REDIS_HOST`, `REDIS_PORT` | Redis connection info (in Docker: `redis`, `6379`) |
| `NEO4J_MEMORY_MCP` | MCP server base URL (e.g. `http://neo4j-memory-mcp:8000/api/mcp/`) |

## 🐳 Docker Compose Setup

Prerequisites: Docker & Docker Compose installed.

```bash
docker compose build
docker compose up -d
```

Services started:
- `agent` (Fastify server + LLM interaction)
- `redis` (pub/sub event bus)
- `neo4j` (graph database)
- `neo4j-memory-mcp` (MCP adapter over Neo4j)

The agent waits 10s (`sleep 10 && node index.js`) allowing dependencies to become available.

## ▶️ Local Development (Without Full Compose)

1. Install dependencies:
	```bash
	cd agent
	npm install
	```
2. Start Redis & Neo4j locally (or via Docker).
3. Start ngrok exposing the agent port (e.g. `ngrok http 3000`). Set `NGROK_DOMAIN` accordingly.
4. Run the server:
	```bash
	node index.js
	```
5. Configure Twilio webhook for voice calls to `https://<NGROK_DOMAIN>/twiml`.

## 🔌 API Endpoints

### `POST /call`
Initiates an outbound training call.
Body (JSON):
```json
{ "ph": "+15551234567", "name": "Alice", "persona": "bank_relationship_manager", "mode": "normal" }
```
Response:
```json
{ "success": true }
```

### `GET /personas`
Lists available persona names for both modes.

### `POST /twiml`
Twilio internal: returns XML TwiML with conversation relay setup. Not called directly by users.

### `POST /recording-status`
Twilio callback when a call recording is ready; triggers downstream audio processing.

## 🔁 WebSocket Interaction (`/ws`)

Messages sent by client (JSON):
- `setup` – `{ type: "setup", callSid, customParameters: { persona, name, mode } }`
- `prompt` – `{ type: "prompt", callSid, voicePrompt: "User speech text" }`
- `interrupt` – `{ type: "interrupt", callSid, utteranceUntilInterrupt }`

Messages sent by server:
- Streaming text tokens: `{ type: "text", token, last }`
- Play synthesized audio: `{ type: "play", source, loop, preemptible, interruptible }`

## 🧠 Knowledge Graph & Transcript Processing

1. Dual-channel WAV generated from Twilio recording.
2. `utils.separateTwilioRecording` splits caller vs recipient.
3. Transcription agent (`TRANSCRIPT_GENERATION_PROMPT`) corrects base transcript + enriches PII relationships (executed via MCP tooling internally – not exposed publicly).
4. Redis stores raw and processed transcripts plus cloned voice ID.

## 🔒 Security & Ethics

- Treat all collected PII as sensitive; secure storage & encryption at rest recommended (not yet implemented).
- Never use real customer data in development environments.
- Secrets in `agent/.env` should be rotated regularly; prefer a secret manager in production.
- Explicitly inform participants; include opt-out instructions in real training calls.
- Comply with all applicable privacy and telecom laws (GDPR, HIPAA, PCI DSS where relevant).

## 🧪 Testing Ideas (Not Implemented Yet)

- Unit tests for Redis channel publishing & handler routing.
- Mock ElevenLabs TTS responses to validate audio pipeline without external calls.
- Integration test: simulate full call event chain using fixture recording.

## 🚀 Future Improvements

- Add automated test suite & CI workflow.
- Implement encryption / secure vault for sensitive transcripts.
- Add persona performance analytics dashboard.
- Extend PII extraction with confidence scores.
- Rate limiting & abuse detection for WebSocket prompts.
- Replace ngrok with managed ingress (e.g., API Gateway or reverse proxy).