import "dotenv/config"
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"

const client = new ElevenLabsClient({
    environment: "https://api.elevenlabs.io",
    apiKey: process.env.ELEVENLABS_API_KEY
})

export {
    client
}