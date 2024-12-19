require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { AssemblyAI } = require('assemblyai');
const { spawn } = require('child_process');
const stream = require('stream');
const { Buffer } = require('buffer');
const path = require('path');
const cors = require('cors');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// AssemblyAI Configuration
const assemblyAI = new AssemblyAI({
    apiKey: process.env.ASSEMBLYAI_API_KEY
});

// Cache and stream management
const audioCache = new Map();
const liveStreams = new Map();

// Utility: Buffer to Stream conversion
const bufferToStream = (buffer) => {
    const readable = new stream.Readable();
    readable._read = () => {};
    readable.push(buffer);
    readable.push(null);
    return readable;
};

// Utility: Sliding Window Buffer for Live Streams
class SlidingBuffer {
    constructor(maxDuration = 10) { // 10 seconds default
        this.maxDuration = maxDuration;
        this.chunks = [];
        this.totalDuration = 0;
    }

    addChunk(chunk, duration) {
        this.chunks.push({ chunk, duration });
        this.totalDuration += duration;

        while (this.totalDuration > this.maxDuration) {
            const removed = this.chunks.shift();
            this.totalDuration -= removed.duration;
        }
    }

    getBuffer() {
        return Buffer.concat(this.chunks.map(c => c.chunk));
    }

    clear() {
        this.chunks = [];
        this.totalDuration = 0;
    }
}

// YouTube Audio Download Function
const downloadYoutubeAudio = (url, isLive = false) => {
    return new Promise((resolve, reject) => {
        const ffmpegPath = process.env.FFMPEG_PATH || 'C:\\Program Files\\FFmpeg\\bin';
        const audioChunks = [];
        let isAudioData = false;

        const options = [
            '-x',
            '--audio-format', 'mp3',
            '--output', '-',
            '--no-playlist',
            '--ffmpeg-location', ffmpegPath
        ];

        if (isLive) {
            options.push('--live-from-start');
        }

        const ytDlpProcess = spawn('yt-dlp', [...options, url]);

        ytDlpProcess.stdout.on('data', (chunk) => {
            isAudioData = true;
            audioChunks.push(chunk);
        });

        ytDlpProcess.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.includes('Error') && !message.includes('[download]') && !message.includes('[youtube]') && !message.includes('[info]')) {
                console.error('Download Error:', message);
            } else {
                console.log('Download Progress:', message);
            }
        });

        ytDlpProcess.on('close', (code) => {
            if (code === 0 && isAudioData) {
                const audioBuffer = Buffer.concat(audioChunks);
                resolve(audioBuffer);
            } else {
                reject(new Error(`Download failed with code ${code}. No audio data received.`));
            }
        });

        ytDlpProcess.on('error', (error) => {
            console.error('Process Error:', error);
            reject(error);
        });
    });
};

// Live Stream Processing Function
const processLiveStream = async (url, ws, language) => {
    const slidingBuffer = new SlidingBuffer();
    let currentStream = null;

    try {
        currentStream = spawn('yt-dlp', [
            '-x',
            '--audio-format', 'mp3',
            '--output', '-',
            '--live-from-start',
            url
        ]);

        currentStream.stdout.on('data', async (chunk) => {
            try {
                slidingBuffer.addChunk(chunk, 1); // Assume 1 second per chunk

                if (slidingBuffer.totalDuration >= 10) { // Process every 10 seconds
                    const audioBuffer = slidingBuffer.getBuffer();
                    
                    const audioFile = await assemblyAI.files.upload(
                        bufferToStream(audioBuffer),
                        {
                            fileName: 'live-stream.mp3',
                            contentType: 'audio/mp3'
                        }
                    );

                    const transcript = await assemblyAI.transcripts.transcribe({
                        audio: audioFile,
                        language_code: language
                    });

                    ws.send(JSON.stringify({
                        type: 'transcription',
                        text: transcript.text,
                        timestamp: Date.now()
                    }));

                    slidingBuffer.clear();
                }
            } catch (error) {
                console.error('Live stream processing error:', error);
                ws.send(JSON.stringify({
                    type: 'error',
                    error: 'Stream processing failed',
                    details: error.message
                }));
            }
        });

        currentStream.stderr.on('data', (data) => {
            console.log('Stream progress:', data.toString());
        });

        return currentStream;
    } catch (error) {
        console.error('Stream setup error:', error);
        throw error;
    }
};

// Recorded Video Transcription Endpoint
app.post('/api/transcribe-recorded', async (req, res) => {
    const { video_url, language = 'en' } = req.body;

    if (!video_url) {
        return res.status(400).json({ error: 'Video URL is required' });
    }

    try {
        console.log('Processing recorded video:', video_url);
        
        // Download audio
        const audioBuffer = await downloadYoutubeAudio(video_url, false);
        const cacheKey = `youtube-${Date.now()}`;
        audioCache.set(cacheKey, audioBuffer);

        console.log('Successfully downloaded audio, size:', audioBuffer.length);
        
        // Upload to AssemblyAI
        const audioFile = await assemblyAI.files.upload(bufferToStream(audioBuffer), {
            fileName: 'audio.mp3',
            contentType: 'audio/mp3'
        });

        console.log('Successfully uploaded to AssemblyAI');

        // Get transcription
        const transcript = await assemblyAI.transcripts.transcribe({
            audio: audioFile,
            language_code: language
        });

        // Clean up cache
        audioCache.delete(cacheKey);
        console.log('Cleaned up cache');

        res.json({ text: transcript.text });
    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({
            error: 'Failed to transcribe video',
            details: error.message
        });
    }
});

// WebSocket Handler for Live Streams
wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    let currentStream = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'start_live') {
                console.log('Starting live stream processing:', data.url);

                // Cleanup existing stream if any
                if (currentStream) {
                    currentStream.kill();
                }

                // Start new stream processing
                currentStream = await processLiveStream(data.url, ws, data.language);
                
                const streamKey = `live-${Date.now()}`;
                liveStreams.set(streamKey, currentStream);

                ws.send(JSON.stringify({
                    type: 'status',
                    message: 'Live stream processing started'
                }));
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to process message',
                details: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed');
        if (currentStream) {
            currentStream.kill();
        }
    });
});

// Cache Management Endpoint
app.post('/api/clear-cache', (req, res) => {
    audioCache.clear();
    res.json({ message: 'Cache cleared successfully' });
});

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        details: err.message
    });
});

// Start Server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// Cleanup on server shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down server...');
    liveStreams.forEach(stream => stream.kill());
    audioCache.clear();
    server.close(() => {
        console.log('Server shut down complete');
        process.exit(0);
    });
});