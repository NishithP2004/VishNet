import {
    createClient
} from "redis";
import "dotenv/config"
import { v4 } from "uuid"

const client = createClient({
    /* username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD, */
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});

const publisher = client.duplicate();
const subscriber = client.duplicate();

await Promise.all([
    client.connect(),
    subscriber.connect(),
    publisher.connect()
]).then(() => console.log("Connected to Redis successfully.")).catch(err => console.error)

const channels = ["create_call", "separate_recording", "transcribe_recording", "generate_report", "send_report", "create_voice_clone"]

async function publishToChannel(channel, data) {
    await publisher.publish(channel, JSON.stringify({
        id: v4(),
        timestamp: new Date().getTime(),
        data
    }))
}

export {
    client,
    subscriber,
    publisher,
    publishToChannel,
    channels
}