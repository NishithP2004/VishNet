import ffmpeg from "fluent-ffmpeg"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { randomBytes } from "node:crypto"
import "dotenv/config"

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const output_dirs =["./recordings", "./temp"]

for(let output_dir of output_dirs) {
    try {
        fs.accessSync(output_dir, fs.constants.R_OK | fs.constants.W_OK)
    } catch(err) {
        fs.mkdirSync(output_dir)
    }
}

async function separateTwilioRecording(RecordingUrl, RecordingSid, outputDir = "./recordings") {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    try {
        console.log(`Downloading recording: ${RecordingSid}`)

        const audioBuffer = await downloadRecording(RecordingUrl, accountSid, authToken);

        const tempInputPath = path.join(outputDir, `temp_${RecordingSid}.wav`);
        fs.writeFileSync(tempInputPath, audioBuffer)
        console.log(`Saved temporary file: ${tempInputPath}`)

        const callerPath = path.join(outputDir, `caller_${RecordingSid}.wav`);
        const recipientPath = path.join(outputDir, `recipient_${RecordingSid}.wav`);

        console.log(`Extracting caller audio (left channel)...`);
        await extractChannel(tempInputPath, callerPath, 0)

        console.log(`Extracting recipient audio (right channel)...`);
        await extractChannel(tempInputPath, recipientPath, 1)

        // fs.unlinkSync(tempInputPath)
        console.log("Temporary file cleaned up")

        console.log("Audio separation complete!")
        return {
            caller: callerPath,
            recipient: recipientPath,
            original: tempInputPath
        }

    } catch (err) {
        console.error("Error separating Twilio recording:", err)
        throw err;
    }
}

async function downloadRecording(url, username, password) {
    try {
        const auth = Buffer.from(`${username}:${password}`).toString("base64")

        const audioBuffer = await fetch(url, {
            headers: {
                Authorization: `Basic ${auth}`
            },
            method: "GET"
        })
            .then(res => res.arrayBuffer())

        return Buffer.from(audioBuffer)
    } catch(err) {
        console.error("Error downloading audio file from Twilio:", err)
        throw err
    }
}

async function extractChannel(inputPath, outputPath, channelIndex) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(`pan=mono|c0=c${channelIndex}`)
            .audioFilters(`silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-30dB`)
            .audioCodec('pcm_s16le')
            .format('wav')
            .save(outputPath)
            .on('end', () => {
                console.log(`Channel ${channelIndex} saved to: ${outputPath}`)
                resolve(outputPath)
            })
            .on('error', (err) => {
                console.error(`Error extracting channel ${channelIndex}:`, err.message)
                reject(err)
            })
    })
}

async function convertMulawBufferToBuffer(inputBuffer, format="wav", opts={}) {
    const { sampleRate=8000, channels=1, codec } = opts;

    return new Promise((resolve, reject) => {
        const inputStream = Readable.from(inputBuffer)
        const outChunks = []

        const command = ffmpeg()
            .input(inputStream)
            .inputFormat("mulaw")
            .inputOptions([`-ar ${sampleRate}`, `-ac ${channels}`])
        
        if(codec) command.audioCodec(codec);

        const ffout = command   
            .format(format)
            .on('start', comd => {})
            .on('error', err => reject(err))
            .on('end', () => {
                resolve(Buffer.concat(outChunks))
            })
            .pipe()

        ffout.on('data', chunk => outChunks.push(chunk))
        ffout.on('error', err => reject(err))
    })
}

function createAudioWriteStream(callSid) {
    const filename = `${callSid}_${randomBytes(4).toString("hex")}.mp3`
    const writeStream = fs.createWriteStream(`temp/${filename}`, {
        flags: "a"
    })
   
    return { stream: writeStream, filename };
}

export { separateTwilioRecording, convertMulawBufferToBuffer, createAudioWriteStream };