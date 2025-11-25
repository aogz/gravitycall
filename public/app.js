const videoGrid = document.getElementById('video-grid');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const screenBtn = document.getElementById('screen-btn');
const captionBtn = document.getElementById('caption-btn');
const micMenuBtn = document.getElementById('mic-menu-btn');
const camMenuBtn = document.getElementById('cam-menu-btn');
const micDropdown = document.getElementById('mic-dropdown');
const camDropdown = document.getElementById('cam-dropdown');
const appContainer = document.querySelector('.app-container');
const interimResults = document.getElementById('interimResults');
const captionsOverlay = document.getElementById('captions-overlay');

let pipWindow = null;

let localStream;
let myId;
let myColor;
let peers = {}; // { id: { connection, videoElement, color } }
let ws;
let isScreenSharing = false;
let pinnedParticipantId = null; // ID of the pinned participant, or null if grid mode

// Speech Recognition State
let recognition;
let isListening = false;
let autoStartTimeout;
let isAutoStartPending = false;
const SPEECH_CONFIG = {
    name: 'User', // Default user name
    clientIndex: 0, // Counter for transcript ordering
};

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// Initialize
async function init() {
    browser.browserAction.openPopup();
    browser.browserAction.detachPopup();
    browser.browserAction.resizePopup(360, 320);
    browser.browserAction.setPopupStyles({ borderRadius: '24px', backgroundColor: 'transparent' });
    browser.browserAction.setPopupPosition({ bottom: 0, left: 0 });
    
    await getMedia();
    connectToSignalingServer();
    populateDeviceList();
    initDraggable();
    initSpeechRecognition();

    // Event Listeners
    micBtn.addEventListener('click', toggleMic);
    camBtn.addEventListener('click', toggleCam);
    screenBtn.addEventListener('click', toggleScreenShare);
    captionBtn.addEventListener('click', toggleCaptions);

    // Dropdown Listeners
    micMenuBtn.addEventListener('click', (e) => toggleDropdown(e, 'mic'));
    camMenuBtn.addEventListener('click', (e) => toggleDropdown(e, 'cam'));
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.control-group')) {
            micDropdown.classList.add('hidden');
            camDropdown.classList.add('hidden');
        }
    });

    // Document PiP
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            togglePictureInPicture();
        }
    });

    const minimizeBtn = document.getElementById('minimize-btn');
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            if (typeof browser !== 'undefined' && browser.browserAction) {
                browser.browserAction.closePopup();
            } else {
                console.log('Minimize clicked (browser API not available)');
            }
        });
    }

    let viewState = 0; // 0: Small, 1: Sidebar, 2: Fullscreen
    const expandBtn = document.getElementById('expand-btn');
    if (expandBtn) {
        expandBtn.addEventListener('click', async () => {
            if (typeof browser !== 'undefined' && browser.browserAction) {
                viewState = (viewState + 1) % 3; // Cycle 0 -> 1 -> 2 -> 0
                
                if (viewState === 1) {
                    // State 1: Sidebar (Expanded)
                    browser.browserAction.setPopupPosition({ top: 40, right: 0 });
                    browser.browserAction.resizePopup(480, 640);
                    expandBtn.querySelector('span').textContent = 'close_fullscreen';
                    expandBtn.title = 'Fullscreen';
                } else if (viewState === 2) {
                    // State 2: Fullscreen
                    if (browser.webfuseSession) {
                        try {
                            const screenSize = await browser.webfuseSession.getScreenSize();
                            browser.browserAction.resizePopup(screenSize.width, screenSize.height);
                            browser.browserAction.setPopupPosition({ top: 0, left: 0 });
                        } catch (e) {
                            console.error('Error getting screen size:', e);
                        }
                    }
                    expandBtn.querySelector('span').textContent = 'fullscreen_exit';
                    expandBtn.title = 'Restore';
                } else {
                    // State 0: Small (Default)
                    browser.browserAction.setPopupPosition({ bottom: 0, left: 0 });
                    browser.browserAction.resizePopup(360, 320);
                    expandBtn.querySelector('span').textContent = 'open_in_full';
                    expandBtn.title = 'Expand';
                }
            } else {
                console.log('Expand clicked (browser API not available)');
            }
        });
    }
}

async function getMedia(audioDeviceId, videoDeviceId) {
    const constraints = {
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
        video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true
    };

    try {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        updateLocalVideo();

        // Update tracks for existing peers
        Object.values(peers).forEach(peer => {
            const senders = peer.connection.getSenders();
            localStream.getTracks().forEach(track => {
                const sender = senders.find(s => s.track.kind === track.kind);
                if (sender) {
                    sender.replaceTrack(track);
                }
            });
        });

    } catch (err) {
        console.error('Error getting media:', err);
    }
}

function updateLocalVideo() {
    let localVideoContainer = document.getElementById('local-video-container');
    if (!localVideoContainer) {
        localVideoContainer = createVideoContainer('local-video-container', 'You', myColor);
        videoGrid.prepend(localVideoContainer);
    }
    const video = localVideoContainer.querySelector('video');
    video.srcObject = localStream;
    video.muted = true; // Mute local video to prevent feedback
    video.play();

    updateControlButtons();
}

function createVideoContainer(id, label, color = '#333') {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const labelDiv = document.createElement('div');
    labelDiv.className = 'video-label';
    labelDiv.innerHTML = `
        <span style="display:inline-block; width:10px; height:10px; background-color:${color}; border-radius:50%;"></span>
        <span>${label}</span>
    `;

    // Pin Button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn';
    pinBtn.title = 'Pin Participant';
    pinBtn.innerHTML = '<span class="material-icons-round">push_pin</span>';
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering container click if any
        togglePin(id);
    });

    container.appendChild(video);
    container.appendChild(labelDiv);
    container.appendChild(pinBtn);

    return container;
}

function togglePin(id) {
    if (pinnedParticipantId === id) {
        // Unpin - return to grid
        pinnedParticipantId = null;
        videoGrid.classList.remove('active-speaker-mode');
        
        // Remove video strip if it exists and move videos back
        const existingStrip = document.querySelector('.video-strip');
        if (existingStrip) {
            const videos = existingStrip.querySelectorAll('.video-container');
            videos.forEach(video => {
                // Remove active speaker class from all
                video.classList.remove('active-speaker');
                videoGrid.appendChild(video);
            });
            existingStrip.remove();
        }

        // Also make sure the previously pinned video (which might be in grid already) loses the class
        const allVideos = document.querySelectorAll('.video-container');
        allVideos.forEach(v => {
            v.classList.remove('active-speaker');
            const btn = v.querySelector('.pin-btn');
            if (btn) {
                btn.classList.remove('pinned');
                btn.title = 'Pin Participant';
            }
        });

    } else {
        // Pin new participant
        pinnedParticipantId = id;
        videoGrid.classList.add('active-speaker-mode');
        
        // Create video strip if not exists
        let videoStrip = document.querySelector('.video-strip');
        if (!videoStrip) {
            videoStrip = document.createElement('div');
            videoStrip.className = 'video-strip';
            videoGrid.appendChild(videoStrip);
        }

        // Move all videos to strip first (except the one we want to pin)
        const allVideos = document.querySelectorAll('.video-container');
        allVideos.forEach(video => {
            video.classList.remove('active-speaker');
            
            // Update pin button state
            const btn = video.querySelector('.pin-btn');
            if (btn) {
                if (video.id === id) {
                    btn.classList.add('pinned');
                    btn.title = 'Unpin Participant';
                } else {
                    btn.classList.remove('pinned');
                    btn.title = 'Pin Participant';
                }
            }

            if (video.id === id) {
                // This is the pinned video
                video.classList.add('active-speaker');
                videoGrid.insertBefore(video, videoStrip); // Move to main grid area
            } else {
                // Move to strip
                videoStrip.appendChild(video);
            }
        });
    }
}

function connectToSignalingServer() {
    // Use the specific production domain for Webfuse/Extension compatibility
    // or fallback to local if needed (though user requested specific domain)
    const WS_URL = 'wss://gravitycall.aogz.me';
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
        let roomId = 'default';

        // Try to get the current tab URL to use as room ID
        if (typeof browser !== 'undefined' && browser.tabs) {
            roomId = location.href;
        } else {
            // Fallback for web page mode
            roomId = window.location.href;
        }

        // Clean up room ID to be safe
        roomId = btoa(roomId).replace(/[^a-zA-Z0-9]/g, '');

        console.log('Joining room:', roomId);
        ws.send(JSON.stringify({ type: 'join', room: roomId }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'welcome':
                myId = data.id;
                myColor = data.color;
                updateLocalVideo(); // Update label with color if needed
                break;
            case 'existing-peers':
                data.peers.forEach(peer => createPeer(peer.id, peer.color, true));
                break;
            case 'peer-join':
                createPeer(data.id, data.color, false);
                break;
            case 'peer-leave':
                removePeer(data.id);
                break;
            case 'offer':
                handleOffer(data);
                break;
            case 'answer':
                handleAnswer(data);
                break;
            case 'ice-candidate':
                handleIceCandidate(data);
                break;
        }
    };
}

function createPeer(id, color, initiator) {
    const connection = new RTCPeerConnection(config);

    // Add local tracks
    localStream.getTracks().forEach(track => connection.addTrack(track, localStream));

    // Handle remote tracks
    connection.ontrack = (event) => {
        let container = document.getElementById(`peer-${id}`);
        if (!container) {
            container = createVideoContainer(`peer-${id}`, `Peer ${id.substr(0, 4)}`, color);
            
            // If we are in pinned mode, add to strip by default
            if (pinnedParticipantId) {
                const videoStrip = document.querySelector('.video-strip');
                if (videoStrip) {
                    videoStrip.appendChild(container);
                } else {
                    videoGrid.appendChild(container);
                }
            } else {
            videoGrid.appendChild(container);
            }
        }
        const video = container.querySelector('video');
        if (video.srcObject !== event.streams[0]) {
            video.srcObject = event.streams[0];
            video.play();
        }
    };

    // Handle ICE candidates
    connection.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                target: id,
                candidate: event.candidate
            }));
        }
    };

    peers[id] = { connection, color };

    if (initiator) {
        createOffer(id);
    }
    updateParticipantCount();
}

async function createOffer(targetId) {
    const peer = peers[targetId];
    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);

    ws.send(JSON.stringify({
        type: 'offer',
        target: targetId,
        sdp: offer
    }));
}

async function handleOffer(data) {
    // If peer doesn't exist (shouldn't happen usually with this flow, but good safety)
    if (!peers[data.source]) {
        // We might need to pass color here if we didn't get it from peer-join? 
        // For simplicity, assume we got peer-join or existing-peers first.
        // If not, we might need to request it or just use default.
        createPeer(data.source, '#ccc', false);
    }

    const peer = peers[data.source];
    await peer.connection.setRemoteDescription(new RTCSessionDescription(data.sdp));

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);

    ws.send(JSON.stringify({
        type: 'answer',
        target: data.source,
        sdp: answer
    }));
}

async function handleAnswer(data) {
    const peer = peers[data.source];
    if (peer) {
        await peer.connection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
}

async function handleIceCandidate(data) {
    const peer = peers[data.source];
    if (peer) {
        await peer.connection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
}

function removePeer(id) {
    if (peers[id]) {
        peers[id].connection.close();
        delete peers[id];
    }
    const container = document.getElementById(`peer-${id}`);
    if (container) container.remove();
    updateParticipantCount();
    
    // If pinned peer left, return to grid
    if (pinnedParticipantId === `peer-${id}`) {
        togglePin(pinnedParticipantId); // Will unpin because ID matches
    }
}

// Controls
function toggleMic() {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        updateControlButtons();
    }
}

function toggleCam() {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        updateControlButtons();
    }
}

async function toggleScreenShare() {
    try {
        if (typeof browser !== 'undefined' && browser.webfuseSession) {
            browser.webfuseSession.startScreensharing();
            return;
        }

        // Fallback for local dev or non-extension environment (keeping old logic for safety/dev)
        if (!isScreenSharing) {
            // Start screen sharing
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false
            });

            const screenTrack = screenStream.getVideoTracks()[0];

            // Handle when user stops sharing via browser UI
            screenTrack.onended = () => {
                stopScreenShare();
            };

            // Replace video track in local stream
            const oldTrack = localStream.getVideoTracks()[0];
            if (oldTrack) {
                localStream.removeTrack(oldTrack);
                oldTrack.stop();
            }
            localStream.addTrack(screenTrack);

            // Update local video
            const localVideo = document.querySelector('#local-video-container video');
            if (localVideo) {
                localVideo.srcObject = localStream;
            }

            // Replace track for all peer connections
            Object.values(peers).forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(screenTrack);
                }
            });

            isScreenSharing = true;
            updateControlButtons();
        } else {
            stopScreenShare();
        }
    } catch (err) {
        console.error('Error sharing screen:', err);
    }
}

async function stopScreenShare() {
    if (!isScreenSharing) return;

    // Stop screen track
    const screenTrack = localStream.getVideoTracks()[0];
    if (screenTrack) {
        screenTrack.stop();
        localStream.removeTrack(screenTrack);
    }

    // Get camera stream back
    try {
        const videoDeviceId = localStorage.getItem('videoDeviceId');
        const constraints = {
            video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true
        };
        const cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        const cameraTrack = cameraStream.getVideoTracks()[0];

        localStream.addTrack(cameraTrack);

        // Update local video
        const localVideo = document.querySelector('#local-video-container video');
        if (localVideo) {
            localVideo.srcObject = localStream;
        }

        // Replace track for all peer connections
        Object.values(peers).forEach(peer => {
            const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(cameraTrack);
            }
        });
    } catch (err) {
        console.error('Error reverting to camera:', err);
    }

    isScreenSharing = false;
    updateControlButtons();
}

function updateControlButtons() {
    const audioTrack = localStream.getAudioTracks()[0];
    const videoTrack = localStream.getVideoTracks()[0];

    if (audioTrack && audioTrack.enabled) {
        micBtn.classList.add('active');
        micBtn.querySelector('span').textContent = 'mic';
    } else {
        micBtn.classList.remove('active');
        micBtn.querySelector('span').textContent = 'mic_off';
    }

    if (videoTrack && videoTrack.enabled) {
        camBtn.classList.add('active');
        camBtn.querySelector('span').textContent = 'videocam';
    } else {
        camBtn.classList.remove('active');
        camBtn.querySelector('span').textContent = 'videocam_off';
    }

    // Update screen share button
    if (isScreenSharing) {
        screenBtn.classList.add('active');
        screenBtn.querySelector('span').textContent = 'stop_screen_share';
    } else {
        screenBtn.classList.remove('active');
        screenBtn.querySelector('span').textContent = 'screen_share';
    }
}

function initSpeechRecognition() {
    // Check if browser supports SpeechRecognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.log('Speech Recognition not supported');
        captionBtn.style.display = 'none';
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    
    let lastText = '';
    let startTime = '';
    
    recognition.onstart = () => {
        console.log('Speech recognition started');
        isListening = true;
        updateCaptionButton();
    };

    recognition.onresult = (event) => {
        const current = event.resultIndex;
        const transcript = event.results[current][0].transcript.trim();
        
        // Display interim results
        interimResults.textContent = transcript;
        captionsOverlay.classList.remove('hidden');
        
        if (event.results[current].isFinal) {
            // Fade out interim display when result is final after a delay
            setTimeout(() => {
                if (interimResults.textContent === transcript) {
                    interimResults.textContent = '';
                    captionsOverlay.classList.add('hidden');
                }
            }, 3000);

            if (transcript.length === 0) {
                return;
            }

            const payload = {
                start_time: startTime,
                end_time: Date.now().toString(),
                client_index: SPEECH_CONFIG.clientIndex,
                name: SPEECH_CONFIG.name,
                text: transcript
            };

            if (window.chrome && chrome.webfuseSession) {
                chrome.webfuseSession.apiRequest({cmd: 'log', msg: {...payload, type: 'transcript'}});
            } else {
                console.log('Transcript:', payload);
            }
            
            lastText = '';
        } else {
            if (!lastText) {
                startTime = Date.now().toString();
            }
            lastText = transcript;
        }
    };

    recognition.onend = () => {
        // Only restart if we intended to be listening
        if (isListening) {
            console.log('Restarting speech recognition');
            setTimeout(() => {
                try {
                    recognition.start();
                } catch (e) {
                    console.error('Error restarting recognition:', e);
                }
            }, 1000);
    } else {
            console.log('Speech recognition stopped');
            updateCaptionButton();
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
            isListening = false;
            updateCaptionButton();
        }
    };

    // Start Auto-Start Timer logic
    if (window.chrome && chrome.webfuseSession) {
        startAutoJoinTimer();
    }

    // Initialize Webfuse session listener if available
    if (window.chrome && chrome.webfuseSession) {
        chrome.webfuseSession.onMessage.addListener(message => {
            if (message?.msg === 'get_session_participants') {
                const me = message.participants.find(participant => !!participant.self);
                if (me) {
                    SPEECH_CONFIG.clientIndex = me.client_index;
                    SPEECH_CONFIG.name = me.name;
                    // Auto-start if configured? For now we let user toggle.
                }
            }
        });

        chrome.webfuseSession.apiRequest({cmd: 'get_session_participants'});
    }
}

function startAutoJoinTimer() {
    // Only start timer if not already listening
    if (isListening) return;

    isAutoStartPending = true;
    captionBtn.classList.add('loading');
    
    autoStartTimeout = setTimeout(() => {
        if (isAutoStartPending) {
            isAutoStartPending = false;
            captionBtn.classList.remove('loading');
            // Start transcription
            if (recognition && !isListening) {
                 try {
                    recognition.start();
                    // isListening will be set in onstart
                } catch (e) {
                    console.error('Error auto-starting recognition:', e);
                }
            }
        }
    }, 5000); // 5 seconds
}

function toggleCaptions() {
    if (!recognition) return;

    if (isAutoStartPending) {
        // User cancelled the auto-start
        clearTimeout(autoStartTimeout);
        isAutoStartPending = false;
        captionBtn.classList.remove('loading');
        // Ensure it's stopped
        isListening = false;
        updateCaptionButton();
        return;
    }

    if (isListening) {
        isListening = false;
        recognition.stop();
        captionsOverlay.classList.add('hidden');
    } else {
        try {
            recognition.start();
            isListening = true;
        } catch (e) {
            console.error('Error starting recognition:', e);
        }
    }
    updateCaptionButton();
}

function updateCaptionButton() {
    if (isListening) {
        captionBtn.classList.add('active');
        captionBtn.querySelector('span').textContent = 'closed_caption';
    } else {
        captionBtn.classList.remove('active');
        captionBtn.querySelector('span').textContent = 'closed_caption_disabled';
    }
}

// Device Selection
async function populateDeviceList() {
    const devices = await navigator.mediaDevices.enumerateDevices();

    micDropdown.innerHTML = '';
    camDropdown.innerHTML = '';

    const savedAudio = localStorage.getItem('audioDeviceId');
    const savedVideo = localStorage.getItem('videoDeviceId');

    devices.forEach(device => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        if (device.kind === 'audioinput') {
            if (device.deviceId === savedAudio) item.classList.add('selected');
            item.innerHTML = `
                <span class="material-icons-round">check</span>
                <span>${device.label || `Microphone ${micDropdown.children.length + 1}`}</span>
            `;
            item.onclick = () => switchDevice('audio', device.deviceId);
            micDropdown.appendChild(item);
        } else if (device.kind === 'videoinput') {
            if (device.deviceId === savedVideo) item.classList.add('selected');
            item.innerHTML = `
                <span class="material-icons-round">check</span>
                <span>${device.label || `Camera ${camDropdown.children.length + 1}`}</span>
            `;
            item.onclick = () => switchDevice('video', device.deviceId);
            camDropdown.appendChild(item);
        }
    });
}

function toggleDropdown(e, type) {
    e.stopPropagation();
    const dropdown = type === 'mic' ? micDropdown : camDropdown;
    const otherDropdown = type === 'mic' ? camDropdown : micDropdown;
    
    otherDropdown.classList.add('hidden'); // Close other dropdown
    dropdown.classList.toggle('hidden');
}

async function switchDevice(type, deviceId) {
    if (type === 'audio') {
        localStorage.setItem('audioDeviceId', deviceId);
        // Update selected UI
        Array.from(micDropdown.children).forEach(child => {
             child.classList.toggle('selected', child.onclick.toString().includes(deviceId));
        });
        micDropdown.classList.add('hidden');
    } else {
        localStorage.setItem('videoDeviceId', deviceId);
        // Update selected UI
        Array.from(camDropdown.children).forEach(child => {
            child.classList.toggle('selected', child.onclick.toString().includes(deviceId));
        });
        camDropdown.classList.add('hidden');
    }
    
    // Get currently saved device IDs to pass both
    const audioId = localStorage.getItem('audioDeviceId');
    const videoId = localStorage.getItem('videoDeviceId');
    
    await getMedia(audioId, videoId);
}

function updateParticipantCount() {
    const count = Object.keys(peers).length + 1; // +1 for self
    const countElement = document.getElementById('participant-count');
    if (countElement) {
        countElement.textContent = `(${count})`;
    }
}

async function togglePictureInPicture() {
    // Check if Document PiP is supported
    if (!('documentPictureInPicture' in window)) {
        console.log('Document Picture-in-Picture API not supported');
        return;
    }

    // If PiP window is already open, do nothing (or could close it, but requirement is to open on switch)
    if (pipWindow) {
        return;
    }

    try {
        // Open a Picture-in-Picture window.
        pipWindow = await documentPictureInPicture.requestWindow({
            width: 360,
            height: 640,
        });

        // Copy all style sheets to the PiP window.
        [...document.styleSheets].forEach((styleSheet) => {
            try {
                const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                const style = document.createElement('style');
                style.textContent = cssRules;
                pipWindow.document.head.appendChild(style);
            } catch (e) {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.type = styleSheet.type;
                link.media = styleSheet.media;
                link.href = styleSheet.href;
                pipWindow.document.head.appendChild(link);
            }
        });

        // Move the app container to the PiP window.
        pipWindow.document.body.append(appContainer);

        // Listen for the PiP window closing.
        pipWindow.addEventListener('pagehide', (event) => {
            const playerContainer = document.querySelector('.app-container');
            if (playerContainer) {
                document.body.append(playerContainer);
            }
            pipWindow = null;
        });

    } catch (err) {
        console.error('Error opening Document Picture-in-Picture window:', err);
    }
}

function initDraggable() {
    const header = document.querySelector('.app-header');
    if (!header) return;

    let isDragging = false;
    let dragState = null;
    let isMaximized = false;
    let isTopLeft = false; // New state for top-left mode
    let previousSize = { width: 360, height: 320 }; // Default size

    header.addEventListener('dblclick', async (e) => {
        // Prevent double click on buttons from triggering maximize
        if (e.target.closest('button')) return;

        try {
            if (window.browser && browser.webfuseSession) {
                const screenSize = await browser.webfuseSession.getScreenSize();
                
                if (!isMaximized && !isTopLeft) {
                    // State 1 -> 2: Maximize (with padding)
                    const newWidth = screenSize.width - 75;
                    const newHeight = screenSize.height - 75;
                    
                    browser.browserAction.resizePopup(newWidth, newHeight);
                    // We can't easily center it without knowing current position logic perfectly, 
                    // but drag handles position. Let's just resize.
                    // Ideally we'd center it here too if API supported it easily.
                    
                    isMaximized = true;
                    isTopLeft = false;
                } else if (isMaximized && !isTopLeft) {
                    // State 2 -> 3: Full Screen / Top Left Position
                    // Using full screen dimensions or close to it
                    browser.browserAction.resizePopup(screenSize.width, screenSize.height);
                    browser.browserAction.setPopupPosition({ top: 0, left: 0 });
                    
                    isMaximized = true; // Still considered maximized in a way
                    isTopLeft = true;
                } else {
                    // State 3 -> 1: Restore to original small size
                    browser.browserAction.resizePopup(previousSize.width, previousSize.height);
                    // Optional: Center or put back? 
                    // Without saving previous position, we just restore size. 
                    // Let's put it bottom-left as default reset or just leave position?
                    // "restore previously saved size" - user said size.
                    // But usually resetting from top-left full screen implies going back to normal.
                    
                    isMaximized = false;
                    isTopLeft = false;
                }
            }
        } catch (err) {
            console.error('Error toggling maximize:', err);
        }
    });

    // Helper to start dragging
    const startDrag = async (e) => {
        // Don't drag if clicking a button
        if (e.target.closest('button') || e.target.closest('.pin-btn') || e.target.closest('select')) return;

        isDragging = true;
        // Use document body cursor to indicate dragging everywhere if needed, 
        // or just keep the element cursor (though visual feedback might be limited on video)
        document.body.style.cursor = 'grabbing';

        try {
            // Get current popup position
            const currentPosition = await browser.browserAction.getPopupPosition();
            const startLeft = parseInt(currentPosition.left) || 0;
            const startTop = parseInt(currentPosition.top) || 0;

            // Save drag start state
            dragState = {
                startScreenX: e.screenX,
                startScreenY: e.screenY,
                startLeft: startLeft,
                startTop: startTop,
            };
            
            e.preventDefault();
        } catch (err) {
            console.log('Drag not available (browser API error)');
            isDragging = false;
            document.body.style.cursor = '';
        }
    };

    header.addEventListener('mousedown', startDrag);

    // Also attach drag listener to the main video grid so dragging on videos works
    // We use capture phase or just bubbling from video container
    const videoGrid = document.getElementById('video-grid');
    if (videoGrid) {
        videoGrid.addEventListener('mousedown', startDrag);
    }


    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !dragState) return;

        // Calculate how far mouse moved
        const deltaX = e.screenX - dragState.startScreenX;
        const deltaY = e.screenY - dragState.startScreenY;

        // Calculate new position (don't go negative)
        const newLeft = Math.max(0, dragState.startLeft + deltaX);
        const newTop = Math.max(0, dragState.startTop + deltaY);

        // Update popup position
        try {
            browser.browserAction.setPopupPosition({
                left: `${newLeft}px`,
                top: `${newTop}px`
            });
        } catch (e) {
            // Ignore errors during drag
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            dragState = null;
            document.body.style.cursor = '';
            header.style.cursor = 'grab';
        }
    });
}

init();
