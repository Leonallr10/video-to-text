// server.js
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

// Platform detection utility
const detectPlatform = (url) => {
    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname.toLowerCase();
        
        if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
            return 'youtube';
        } else if (domain.includes('instagram.com')) {
            return 'instagram';
        } else if (domain.includes('facebook.com') || domain.includes('fb.com')) {
            return 'facebook';
        } else if (domain.includes('tiktok.com')) {
            return 'tiktok';
        } else if (domain.includes('twitter.com')) {
            return 'twitter';
        } else if (domain.includes('vimeo.com')) {
            return 'vimeo';
        }
        return 'unknown';
    } catch (error) {
        throw new Error('Invalid URL format');
    }
};

// Platform-specific download configurations
const getPlatformConfig = (platform, isLive = false) => {
    const baseConfig = [
        '-x',
        '--audio-format', 'mp3',
        '--output', '-',
        '--no-playlist',
    ];

    // Platform-specific configurations
    const configs = {
        instagram: [...baseConfig, 
            '--add-header', 'User-Agent:Mozilla/5.0',
            '--cookies-from-browser', 'chrome'
        ],
        facebook: [...baseConfig, 
            '--add-header', 'Cookie:',
            '--cookies-from-browser', 'chrome'
        ],
        tiktok: [...baseConfig, 
            '--user-agent', 'Mozilla/5.0',
            '--cookies-from-browser', 'chrome'
        ],
        twitter: [...baseConfig, '--cookies-from-browser', 'chrome'],
        vimeo: [...baseConfig],
        youtube: [...baseConfig],
        unknown: [...baseConfig]
    };

    const config = configs[platform] || configs.unknown;
    
    if (isLive) {
        config.push('--live-from-start');
    }

    return config;
};

// Utility: Buffer to Stream conversion
const bufferToStream = (buffer) => {
    const readable = new stream.Readable();
    readable._read = () => {};
    readable.push(buffer);
    readable.push(null);
    return readable;
};

// Enhanced video download function
const downloadVideo = async (url, isLive = false) => {
    try {
        const platform = detectPlatform(url);
        console.log(`Detected platform: ${platform}`);

        const config = getPlatformConfig(platform, isLive);
        const ffmpegPath = process.env.FFMPEG_PATH || 'C:\\Program Files\\FFmpeg\\bin';

        return new Promise((resolve, reject) => {
            const audioChunks = [];
            let isAudioData = false;

            const ytDlpProcess = spawn('yt-dlp', [
                ...config,
                '--ffmpeg-location', ffmpegPath,
                url
            ]);

            ytDlpProcess.stdout.on('data', (chunk) => {
                isAudioData = true;
                audioChunks.push(chunk);
            });

            ytDlpProcess.stderr.on('data', (data) => {
                const message = data.toString();
                if (message.includes('Error') && 
                    !message.includes('[download]') && 
                    !message.includes(`[${platform}]`) && 
                    !message.includes('[info]')) {
                    console.error(`${platform} Download Error:`, message);
                } else {
                    console.log(`${platform} Download Progress:`, message);
                }
            });

            ytDlpProcess.on('close', (code) => {
                if (code === 0 && isAudioData) {
                    const audioBuffer = Buffer.concat(audioChunks);
                    resolve({ audioBuffer, platform });
                } else {
                    reject(new Error(`Download failed for ${platform} with code ${code}. No audio data received.`));
                }
            });

            ytDlpProcess.on('error', (error) => {
                console.error(`${platform} Process Error:`, error);
                reject(error);
            });
        });
    } catch (error) {
        throw new Error(`Failed to process ${url}: ${error.message}`);
    }
};

// Utility: Sliding Window Buffer for Live Streams
class SlidingBuffer {
    constructor(maxDuration = 10) {
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

// Enhanced live stream processing
const processLiveStream = async (url, ws, language) => {
    const platform = detectPlatform(url);
    const slidingBuffer = new SlidingBuffer();
    let currentStream = null;

    try {
        const config = getPlatformConfig(platform, true);
        currentStream = spawn('yt-dlp', config.concat([url]));

        currentStream.stdout.on('data', async (chunk) => {
            try {
                slidingBuffer.addChunk(chunk, 1);

                if (slidingBuffer.totalDuration >= 10) {
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
                        platform,
                        timestamp: Date.now()
                    }));

                    slidingBuffer.clear();
                }
            } catch (error) {
                console.error('Live stream processing error:', error);
                ws.send(JSON.stringify({
                    type: 'error',
                    error: 'Stream processing failed',
                    platform,
                    details: error.message
                }));
            }
        });

        currentStream.stderr.on('data', (data) => {
            console.log(`${platform} stream progress:`, data.toString());
        });

        return currentStream;
    } catch (error) {
        console.error('Stream setup error:', error);
        throw error;
    }
};

// Enhanced recorded video transcription endpoint
app.post('/api/transcribe-recorded', async (req, res) => {
    const { video_url, language = 'en' } = req.body;

    if (!video_url) {
        return res.status(400).json({ error: 'Video URL is required' });
    }

    try {
        const platform = detectPlatform(video_url);
        console.log(`Processing ${platform} video:`, video_url);
        
        const { audioBuffer } = await downloadVideo(video_url, false);
        const cacheKey = `${platform}-${Date.now()}`;
        audioCache.set(cacheKey, audioBuffer);

        console.log(`Successfully downloaded ${platform} audio, size:`, audioBuffer.length);
        
        const audioFile = await assemblyAI.files.upload(bufferToStream(audioBuffer), {
            fileName: 'audio.mp3',
            contentType: 'audio/mp3'
        });

        const transcript = await assemblyAI.transcripts.transcribe({
            audio: audioFile,
            language_code: language
        });

        audioCache.delete(cacheKey);
        
        res.json({ 
            text: transcript.text,
            platform,
            success: true
        });
    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({
            error: 'Failed to transcribe video',
            details: error.message,
            platform: detectPlatform(video_url)
        });
    }
});

// WebSocket handler for live streams
wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    let currentStream = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'start_live') {
                const platform = detectPlatform(data.url);
                console.log(`Starting live stream processing for ${platform}:`, data.url);

                if (currentStream) {
                    currentStream.kill();
                }

                currentStream = await processLiveStream(data.url, ws, data.language);
                
                const streamKey = `${platform}-live-${Date.now()}`;
                liveStreams.set(streamKey, currentStream);

                ws.send(JSON.stringify({
                    type: 'status',
                    message: `Live stream processing started for ${platform}`,
                    platform
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

// Cache management endpoint
app.post('/api/clear-cache', (req, res) => {
    audioCache.clear();
    res.json({ message: 'Cache cleared successfully' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        details: err.message
    });
});

// Start server
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
