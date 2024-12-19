// script.js
const WS_URL = 'ws://localhost:3000';
const API_URL = 'http://localhost:3000';

// DOM Elements
const elements = {
    form: document.getElementById('transcriptionForm'),
    videoType: document.getElementById('videoType'),
    videoUrl: document.getElementById('videoUrl'),
    language: document.getElementById('language'),
    startButton: document.getElementById('startTranscription'),
    stopButton: document.getElementById('stopTranscription'),
    loadingMessage: document.getElementById('loadingMessage'),
    transcriptionResult: document.getElementById('transcriptionResult'),
    errorMessage: document.getElementById('errorMessage'),
    statusMessage: document.getElementById('statusMessage'),
    platformIndicator: document.getElementById('platformIndicator')
};

// State Management
let ws = null;
let isLiveTranscribing = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Platform detection (client-side version)
const detectPlatform = (url) => {
    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname.toLowerCase();
        
        if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
            return 'YouTube';
        } else if (domain.includes('instagram.com')) {
            return 'Instagram';
        } else if (domain.includes('facebook.com') || domain.includes('fb.com')) {
            return 'Facebook';
        } else if (domain.includes('tiktok.com')) {
            return 'TikTok';
        } else if (domain.includes('twitter.com')) {
            return 'Twitter';
        } else if (domain.includes('vimeo.com')) {
            return 'Vimeo';
        }
        return 'Unknown Platform';
    } catch {
        return 'Invalid URL';
    }
};

// Update platform indicator
const updatePlatformIndicator = (url) => {
    const platform = detectPlatform(url);
    if (elements.platformIndicator) {
        elements.platformIndicator.textContent = `Platform: ${platform}`;
        elements.platformIndicator.classList.remove('hidden');
    }
};

// Utility Functions
const showError = (message, duration = 5000) => {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.remove('hidden');
    setTimeout(() => {
        elements.errorMessage.classList.add('hidden');
    }, duration);
};

const showStatus = (message, isError = false) => {
    if (elements.statusMessage) {
        elements.statusMessage.textContent = message;
        elements.statusMessage.className = `mt-4 p-2 rounded-md ${
            isError ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
        }`;
        elements.statusMessage.classList.remove('hidden');
    }
};

const showLoading = (show) => {
    elements.loadingMessage.classList.toggle('hidden', !show);
    elements.startButton.disabled = show;
};

const updateTranscription = (text, append = false) => {
    if (append) {
        const newParagraph = document.createElement('p');
        newParagraph.textContent = text;
        newParagraph.className = 'mb-2 p-2 bg-gray-50 rounded';
        elements.transcriptionResult.appendChild(newParagraph);
        elements.transcriptionResult.scrollTop = elements.transcriptionResult.scrollHeight;
    } else {
        elements.transcriptionResult.innerHTML = `<p class="mb-2 p-2 bg-gray-50 rounded">${text}</p>`;
    }
};

const clearTranscription = () => {
    elements.transcriptionResult.innerHTML = '';
    if (elements.platformIndicator) {
        elements.platformIndicator.classList.add('hidden');
    }
};

const validateUrl = (url) => {
    try {
        new URL(url);
        const platform = detectPlatform(url);
        return platform !== 'Invalid URL';
    } catch {
        return false;
    }
};

// WebSocket Functions
const setupWebSocket = () => {
    if (ws) {
        ws.close();
    }

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('WebSocket connection established');
        showStatus('Connected to transcription service');
        reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            switch (data.type) {
                case 'transcription':
                    updateTranscription(data.text, true);
                    if (data.platform) {
                        updatePlatformIndicator(data.platform);
                    }
                    break;
                case 'status':
                    showStatus(data.message);
                    break;
                case 'error':
                    showError(data.error);
                    break;
                default:
                    console.log('Received unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            showError('Error processing transcription data');
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showError('Connection error. Please try again.');
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed');
        if (isLiveTranscribing && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            showStatus(`Connection lost. Attempting to reconnect... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, true);
            setTimeout(setupWebSocket, 2000 * reconnectAttempts);
        } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            showError('Maximum reconnection attempts reached. Please refresh the page.');
            stopLiveTranscription();
        }
    };
};

// API Functions
const transcribeRecorded = async (videoUrl, language) => {
    try {
        updatePlatformIndicator(videoUrl);
        
        const response = await fetch(`${API_URL}/api/transcribe-recorded`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_url: videoUrl,
                language: language
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || data.details || 'Failed to transcribe video');
        }

        updateTranscription(data.text);
        showStatus(`Transcription completed successfully for ${data.platform}`);
    } catch (error) {
        console.error('Transcription error:', error);
        showError(error.message);
    } finally {
        showLoading(false);
    }
};

const startLiveTranscription = (videoUrl, language) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setupWebSocket();
    }

    isLiveTranscribing = true;
    elements.stopButton.classList.remove('hidden');
    elements.startButton.classList.add('hidden');
    updatePlatformIndicator(videoUrl);

    ws.send(JSON.stringify({
        type: 'start_live',
        url: videoUrl,
        language: language
    }));

    showStatus('Live transcription started');
};

const stopLiveTranscription = () => {
    isLiveTranscribing = false;
    elements.stopButton.classList.add('hidden');
    elements.startButton.classList.remove('hidden');
    
    if (ws) {
        ws.close();
        ws = null;
    }

    showStatus('Live transcription stopped');
};

// Form Validation
const validateForm = () => {
    const videoUrl = elements.videoUrl.value.trim();
    
    if (!videoUrl) {
        showError('Please enter a video URL');
        return false;
    }

    if (!validateUrl(videoUrl)) {
        showError('Please enter a valid URL from a supported platform');
        return false;
    }

    return true;
};

// Event Listeners
elements.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!validateForm()) {
        return;
    }

    const videoUrl = elements.videoUrl.value.trim();
    const videoType = elements.videoType.value;
    const language = elements.language.value;

    clearTranscription();
    showLoading(true);

    if (videoType === 'recorded') {
        await transcribeRecorded(videoUrl, language);
    } else {
        startLiveTranscription(videoUrl, language);
    }
});

elements.stopButton.addEventListener('click', () => {
    stopLiveTranscription();
});

elements.videoType.addEventListener('change', () => {
    const isLive = elements.videoType.value === 'live';
    elements.videoUrl.placeholder = isLive ? 'Enter live stream URL' : 'Enter recorded video URL';
    clearTranscription();
    
    if (isLiveTranscribing) {
        stopLiveTranscription();
    }
});

elements.videoUrl.addEventListener('input', () => {
    elements.errorMessage.classList.add('hidden');
    updatePlatformIndicator(elements.videoUrl.value);
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (document.hidden && isLiveTranscribing) {
        console.log('Page hidden, maintaining connection...');
    } else if (!document.hidden && isLiveTranscribing && (!ws || ws.readyState !== WebSocket.OPEN)) {
        console.log('Page visible, reconnecting...');
        setupWebSocket();
    }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    setupWebSocket();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (ws) {
        ws.close();
    }
});
