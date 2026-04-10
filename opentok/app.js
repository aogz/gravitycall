// === Configuration ===
// When running as extension, use absolute server URL; as web app, use relative
const SERVER_URL = (typeof browser !== 'undefined' && browser.browserAction)
    ? 'https://gravitycall.aogz.me'
    : '';

// === DOM Elements ===
const videoGrid = document.getElementById('video-grid');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const screenBtn = document.getElementById('screen-btn');
const captionBtn = document.getElementById('caption-btn');
const micMenuBtn = document.getElementById('mic-menu-btn');
const camMenuBtn = document.getElementById('cam-menu-btn');
const micDropdown = document.getElementById('mic-dropdown');
const camDropdown = document.getElementById('cam-dropdown');
const bgBtn = document.getElementById('bg-btn');
const bgDropdown = document.getElementById('bg-dropdown');
const appContainer = document.querySelector('.app-container');
const interimResults = document.getElementById('interim-results');
const captionsOverlay = document.getElementById('captions-overlay');

// === State ===
let pipWindow = null;
let session = null;
let publisher = null;
let subscribers = {}; // { streamId: { subscriber, containerId, color } }
let myColor = null;
let isMicEnabled = true;
let isCamEnabled = true;
let previewStream = null;
let isScreenSharing = false;
let bgMode = 'none'; // none, blur, blur-strong, image
let bgImageUrl = null;
let pinnedParticipantId = null;
let viewState = 0; // 0: Small, 1: Sidebar, 2: Fullscreen

// Speech Recognition State
let recognition;
let isListening = false;
let autoStartTimeout;
let isAutoStartPending = false;
const SPEECH_CONFIG = {
    name: 'User',
    clientIndex: 0,
};

// === Initialize ===
async function init() {
    if (typeof browser !== 'undefined' && browser.browserAction) {
        browser.browserAction.openPopup();
        browser.browserAction.detachPopup();
        browser.browserAction.resizePopup(360, 320);
        browser.browserAction.setPopupStyles({ borderRadius: '24px', backgroundColor: 'transparent' });
        browser.browserAction.setPopupPosition({ bottom: 0, left: 0 });
    }

    // Request initial media permissions for device enumeration
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        tempStream.getTracks().forEach(t => t.stop());
    } catch (err) {
        console.error('Error getting initial media permissions:', err);
    }

    await connectToSession();
    populateDeviceList();
    initDraggable();
    initSpeechRecognition();

    // Event Listeners
    micBtn.addEventListener('click', toggleMic);
    camBtn.addEventListener('click', toggleCam);
    screenBtn.addEventListener('click', toggleScreenShare);
    captionBtn.addEventListener('click', toggleCaptions);
    bgBtn.addEventListener('click', toggleBgDropdown);

    // Dropdown Listeners
    micMenuBtn.addEventListener('click', (e) => toggleDropdown(e, 'mic'));
    camMenuBtn.addEventListener('click', (e) => toggleDropdown(e, 'cam'));

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.control-group') && !e.target.closest('.bg-control')) {
            if (!camDropdown.classList.contains('hidden')) stopCameraPreview();
            if (!bgDropdown.classList.contains('hidden')) stopBgPreview();
            micDropdown.classList.add('hidden');
            camDropdown.classList.add('hidden');
            bgDropdown.classList.add('hidden');
        }
    });

    // Document PiP
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            togglePictureInPicture();
        }
    });

    // Network change detection (OpenTok handles reconnection automatically)
    window.addEventListener('online', () => {
        console.log('Network online');
    });
    window.addEventListener('offline', () => {
        console.log('Network offline');
    });
    if ('connection' in navigator) {
        navigator.connection.addEventListener('change', () => {
            console.log('Network connection changed');
        });
    }

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
}

// === OpenTok Session ===
async function connectToSession() {
    // Determine room ID (same logic as original)
    let roomId = 'default';
    if (typeof browser !== 'undefined' && browser.tabs) {
        roomId = location.href;
    } else {
        roomId = window.location.href;
    }
    roomId = btoa(roomId).replace(/[^a-zA-Z0-9]/g, '');

    try {
        const response = await fetch(`${SERVER_URL}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId })
        });
        const data = await response.json();

        myColor = data.color;

        // Initialize session
        session = OT.initSession(data.apiKey, data.sessionId);

        // Session events
        session.on('streamCreated', handleStreamCreated);
        session.on('streamDestroyed', handleStreamDestroyed);

        session.on('sessionReconnecting', () => {
            console.log('Session reconnecting...');
        });
        session.on('sessionReconnected', () => {
            console.log('Session reconnected');
        });
        session.on('sessionDisconnected', (event) => {
            console.log('Session disconnected:', event.reason);
        });

        // Connect to session
        await new Promise((resolve, reject) => {
            session.connect(data.token, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        console.log('Connected to OpenTok session, room:', roomId);
        publishLocalStream();

    } catch (err) {
        console.error('Error connecting to session:', err);
    }
}

function publishLocalStream() {
    let localContainer = document.getElementById('local-video-container');
    if (!localContainer) {
        localContainer = createVideoContainer('local-video-container', 'You', myColor);
        videoGrid.prepend(localContainer);
    }

    const audioDeviceId = localStorage.getItem('audioDeviceId');
    const videoDeviceId = localStorage.getItem('videoDeviceId');

    publisher = OT.initPublisher(localContainer.querySelector('.video-target'), {
        insertMode: 'append',
        width: '100%',
        height: '100%',
        showControls: false,
        mirror: false, // CSS handles mirroring
        audioSource: audioDeviceId || undefined,
        videoSource: videoDeviceId || undefined,
        style: {
            nameDisplayMode: 'off',
            buttonDisplayMode: 'off',
            audioLevelDisplayMode: 'off'
        }
    }, (error) => {
        if (error) {
            console.error('Error initializing publisher:', error);
            return;
        }
        updateControlButtons();
    });

    session.publish(publisher, (error) => {
        if (error) {
            console.error('Error publishing:', error);
        }
    });
}

// === Stream Events ===
function handleStreamCreated(event) {
    const stream = event.stream;
    let color = '#333';
    try {
        const connectionData = JSON.parse(stream.connection.data || '{}');
        color = connectionData.color || '#333';
    } catch (e) { /* ignore parse errors */ }

    const streamId = stream.streamId;
    const containerId = `subscriber-${streamId}`;
    const container = createVideoContainer(containerId, `Peer`, color);

    // Place in strip if someone is pinned, otherwise in grid
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

    updateViewModeButtons(container);

    const subscriber = session.subscribe(stream, container.querySelector('.video-target'), {
        insertMode: 'append',
        width: '100%',
        height: '100%',
        showControls: false,
        style: {
            nameDisplayMode: 'off',
            buttonDisplayMode: 'off',
            audioLevelDisplayMode: 'off'
        }
    }, (error) => {
        if (error) {
            console.error('Error subscribing:', error);
        }
    });

    subscribers[streamId] = { subscriber, containerId, color };
    updateParticipantCount();
}

function handleStreamDestroyed(event) {
    const streamId = event.stream.streamId;
    const sub = subscribers[streamId];
    if (sub) {
        const container = document.getElementById(sub.containerId);
        if (container) container.remove();

        // If pinned participant left, return to grid
        if (pinnedParticipantId === sub.containerId) {
            togglePin(pinnedParticipantId);
        }

        delete subscribers[streamId];
    }
    updateParticipantCount();
}

// === Video Container ===
function createVideoContainer(id, label, color = '#333') {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = id;

    // Target div for OpenTok to insert video into
    const videoTarget = document.createElement('div');
    videoTarget.className = 'video-target';

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
        e.stopPropagation();
        togglePin(id);
    });

    // Fullscreen Toggle Button
    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'view-mode-btn fullscreen-btn';
    fullscreenBtn.title = 'Fullscreen';
    fullscreenBtn.innerHTML = '<span class="material-icons-round">fullscreen</span>';
    fullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen();
    });

    // Sidebar Toggle Button
    const sidebarBtn = document.createElement('button');
    sidebarBtn.className = 'view-mode-btn sidebar-btn';
    sidebarBtn.title = 'Sidebar';
    sidebarBtn.innerHTML = '<span class="material-icons-round">view_sidebar</span>';
    sidebarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
    });

    container.appendChild(videoTarget);
    container.appendChild(labelDiv);
    container.appendChild(pinBtn);
    container.appendChild(fullscreenBtn);
    container.appendChild(sidebarBtn);

    updateViewModeButtons(container);
    return container;
}

// === View Mode ===
async function toggleFullscreen() {
    if (typeof browser !== 'undefined' && browser.browserAction) {
        if (viewState === 2) {
            viewState = 0;
            browser.browserAction.setPopupPosition({ bottom: 0, left: 0 });
            browser.browserAction.resizePopup(360, 320);
        } else {
            viewState = 2;
            if (browser.webfuseSession) {
                try {
                    const screenSize = await browser.webfuseSession.getScreenSize();
                    browser.browserAction.resizePopup(screenSize.width, screenSize.height - 40);
                    browser.browserAction.setPopupPosition({ top: 0, left: 0 });
                } catch (e) {
                    console.error('Error getting screen size:', e);
                }
            }
        }
        updateAllViewModeButtons();
    }
}

async function toggleSidebar() {
    if (typeof browser !== 'undefined' && browser.browserAction) {
        if (viewState === 1) {
            viewState = 0;
            browser.browserAction.setPopupPosition({ bottom: 0, left: 0 });
            browser.browserAction.resizePopup(360, 320);
        } else {
            viewState = 1;
            browser.browserAction.setPopupPosition({ top: 40, right: 0 });
            browser.browserAction.resizePopup(480, 640);
        }
        updateAllViewModeButtons();
    }
}

function updateViewModeButtons(container) {
    const fullscreenBtn = container.querySelector('.fullscreen-btn');
    const sidebarBtn = container.querySelector('.sidebar-btn');

    if (!fullscreenBtn || !sidebarBtn) return;

    if (viewState === 2) {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
        fullscreenBtn.title = 'Exit Fullscreen';
    } else {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen';
        fullscreenBtn.title = 'Fullscreen';
    }

    if (viewState === 1) {
        sidebarBtn.querySelector('span').textContent = 'close_fullscreen';
        sidebarBtn.title = 'Exit Sidebar';
    } else {
        sidebarBtn.querySelector('span').textContent = 'view_sidebar';
        sidebarBtn.title = 'Sidebar';
    }
}

function updateAllViewModeButtons() {
    const allContainers = document.querySelectorAll('.video-container');
    allContainers.forEach(container => {
        updateViewModeButtons(container);
    });
}

// === Pin / Active Speaker ===
function togglePin(id) {
    if (pinnedParticipantId === id) {
        // Unpin - return to grid
        pinnedParticipantId = null;
        videoGrid.classList.remove('active-speaker-mode');

        const existingStrip = document.querySelector('.video-strip');
        if (existingStrip) {
            const videos = existingStrip.querySelectorAll('.video-container');
            videos.forEach(video => {
                video.classList.remove('active-speaker');
                videoGrid.appendChild(video);
            });
            existingStrip.remove();
        }

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

        let videoStrip = document.querySelector('.video-strip');
        if (!videoStrip) {
            videoStrip = document.createElement('div');
            videoStrip.className = 'video-strip';
            videoGrid.appendChild(videoStrip);
        }

        const allVideos = document.querySelectorAll('.video-container');
        allVideos.forEach(video => {
            video.classList.remove('active-speaker');

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
                video.classList.add('active-speaker');
                videoGrid.insertBefore(video, videoStrip);
            } else {
                videoStrip.appendChild(video);
            }
        });
    }
}

// === Controls ===
function toggleMic() {
    if (!publisher) return;
    isMicEnabled = !isMicEnabled;
    publisher.publishAudio(isMicEnabled);
    updateControlButtons();
}

function toggleCam() {
    if (!publisher) return;
    isCamEnabled = !isCamEnabled;
    publisher.publishVideo(isCamEnabled);
    updateControlButtons();
}

async function toggleScreenShare() {
    try {
        if (typeof browser !== 'undefined' && browser.webfuseSession) {
            console.log('Starting screen sharing');
            browser.webfuseSession.startScreensharing();
            return;
        }

        if (!isScreenSharing) {
            const localContainer = document.getElementById('local-video-container');
            const videoTarget = localContainer.querySelector('.video-target');

            // Unpublish current camera
            session.unpublish(publisher);
            publisher.destroy();
            videoTarget.innerHTML = '';

            // Create screen publisher
            publisher = OT.initPublisher(videoTarget, {
                insertMode: 'append',
                width: '100%',
                height: '100%',
                videoSource: 'screen',
                showControls: false,
                mirror: false,
                style: {
                    nameDisplayMode: 'off',
                    buttonDisplayMode: 'off',
                    audioLevelDisplayMode: 'off'
                }
            }, (error) => {
                if (error) {
                    console.error('Error creating screen publisher:', error);
                    // Revert to camera
                    isScreenSharing = false;
                    republishCamera();
                    return;
                }
            });

            // Detect screen share ending via browser UI
            publisher.on('streamDestroyed', () => {
                if (isScreenSharing) {
                    stopScreenShare();
                }
            });

            session.publish(publisher, (error) => {
                if (error) {
                    console.error('Error publishing screen:', error);
                    isScreenSharing = false;
                    republishCamera();
                    return;
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

function stopScreenShare() {
    if (!isScreenSharing) return;
    isScreenSharing = false;

    if (publisher) {
        session.unpublish(publisher);
        publisher.destroy();
    }

    republishCamera();
    updateControlButtons();
    updateDeviceSelectionUI();
}

function republishCamera() {
    const localContainer = document.getElementById('local-video-container');
    const videoTarget = localContainer.querySelector('.video-target');
    videoTarget.innerHTML = '';

    const audioDeviceId = localStorage.getItem('audioDeviceId');
    const videoDeviceId = localStorage.getItem('videoDeviceId');

    publisher = OT.initPublisher(videoTarget, {
        insertMode: 'append',
        width: '100%',
        height: '100%',
        showControls: false,
        mirror: false,
        audioSource: audioDeviceId || undefined,
        videoSource: videoDeviceId || undefined,
        style: {
            nameDisplayMode: 'off',
            buttonDisplayMode: 'off',
            audioLevelDisplayMode: 'off'
        }
    });

    session.publish(publisher, (error) => {
        if (error) {
            console.error('Error republishing camera:', error);
        } else if (bgMode !== 'none') {
            applyBackgroundEffect();
        }
    });
}

function updateControlButtons() {
    if (isMicEnabled) {
        micBtn.classList.add('active');
        micBtn.querySelector('span').textContent = 'mic';
    } else {
        micBtn.classList.remove('active');
        micBtn.querySelector('span').textContent = 'mic_off';
    }

    if (isCamEnabled) {
        camBtn.classList.add('active');
        camBtn.querySelector('span').textContent = 'videocam';
    } else {
        camBtn.classList.remove('active');
        camBtn.querySelector('span').textContent = 'videocam_off';
    }

    if (isScreenSharing) {
        screenBtn.classList.add('active');
        screenBtn.querySelector('span').textContent = 'stop_screen_share';
    } else {
        screenBtn.classList.remove('active');
        screenBtn.querySelector('span').textContent = 'screen_share';
    }
}

// === Background Effects ===
function toggleBgDropdown(e) {
    e.stopPropagation();

    // Close other dropdowns
    micDropdown.classList.add('hidden');
    if (!camDropdown.classList.contains('hidden')) {
        stopCameraPreview();
        camDropdown.classList.add('hidden');
    }

    const wasHidden = bgDropdown.classList.contains('hidden');
    bgDropdown.classList.toggle('hidden');

    if (wasHidden) {
        populateBgOptions();
        startBgPreview(bgMode);
    } else {
        stopBgPreview();
    }
}

function populateBgOptions() {
    const items = bgDropdown.querySelectorAll('.dropdown-item');
    items.forEach(item => item.remove());

    const options = [
        { id: 'none', label: 'None', cssFilter: '' },
        { id: 'blur', label: 'Blur', cssFilter: 'blur(4px)' },
        { id: 'blur-strong', label: 'More blur', cssFilter: 'blur(10px)' },
    ];

    options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'dropdown-item' + (bgMode === opt.id ? ' selected' : '');
        item.innerHTML = `
            <span class="material-icons-round">check</span>
            <span>${opt.label}</span>
        `;
        item.onclick = () => selectBgEffect(opt.id);
        item.onmouseenter = () => updateBgPreviewFilter(opt.cssFilter);
        bgDropdown.appendChild(item);
    });

    // Upload image option
    const uploadItem = document.createElement('div');
    uploadItem.className = 'dropdown-item' + (bgMode === 'image' ? ' selected' : '');
    uploadItem.innerHTML = `
        <span class="material-icons-round">check</span>
        <span>Upload image</span>
    `;
    uploadItem.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (ev) => {
            const file = ev.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = () => {
                    bgImageUrl = reader.result;
                    selectBgEffect('image', bgImageUrl);
                };
                reader.readAsDataURL(file);
            }
        };
        input.click();
    };
    uploadItem.onmouseenter = () => updateBgPreviewFilter('');
    bgDropdown.appendChild(uploadItem);
}

function selectBgEffect(mode, imageUrl) {
    bgMode = mode;
    if (imageUrl) bgImageUrl = imageUrl;

    bgDropdown.classList.add('hidden');
    stopBgPreview();
    applyBackgroundEffect();
}

async function applyBackgroundEffect() {
    if (!publisher) return;

    try {
        if (bgMode === 'none') {
            await publisher.clearVideoFilter();
        } else if (bgMode === 'blur') {
            await publisher.applyVideoFilter({
                type: 'backgroundBlur',
                blurStrength: 'low'
            });
        } else if (bgMode === 'blur-strong') {
            await publisher.applyVideoFilter({
                type: 'backgroundBlur',
                blurStrength: 'high'
            });
        } else if (bgMode === 'image' && bgImageUrl) {
            await publisher.applyVideoFilter({
                type: 'backgroundReplacement',
                backgroundImgUrl: bgImageUrl
            });
        }
    } catch (err) {
        console.error('Error applying background effect:', err);
    }

    updateBgButton();
}

function updateBgButton() {
    if (bgMode !== 'none') {
        bgBtn.classList.add('active');
    } else {
        bgBtn.classList.remove('active');
    }
}

// BG Preview (uses same previewStream as camera preview)
function createBgPreview() {
    let preview = bgDropdown.querySelector('.device-preview');
    if (!preview) {
        preview = document.createElement('div');
        preview.className = 'device-preview';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        preview.appendChild(video);
        bgDropdown.prepend(preview);
    }
    return preview;
}

async function startBgPreview(currentMode) {
    const preview = createBgPreview();
    const video = preview.querySelector('video');

    if (previewStream) {
        previewStream.getTracks().forEach(t => t.stop());
    }

    const videoDeviceId = localStorage.getItem('videoDeviceId');
    try {
        previewStream = await navigator.mediaDevices.getUserMedia({
            video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
            audio: false
        });
        video.srcObject = previewStream;

        // Show current effect approximation
        if (currentMode === 'blur') {
            video.style.filter = 'blur(4px)';
        } else if (currentMode === 'blur-strong') {
            video.style.filter = 'blur(10px)';
        } else {
            video.style.filter = '';
        }
    } catch (err) {
        console.error('Error starting BG preview:', err);
    }
}

function updateBgPreviewFilter(cssFilter) {
    const preview = bgDropdown.querySelector('.device-preview');
    if (preview) {
        const video = preview.querySelector('video');
        if (video) video.style.filter = cssFilter || '';
    }
}

function stopBgPreview() {
    if (previewStream) {
        previewStream.getTracks().forEach(t => t.stop());
        previewStream = null;
    }
    const preview = bgDropdown.querySelector('.device-preview');
    if (preview) {
        const video = preview.querySelector('video');
        if (video) {
            video.srcObject = null;
            video.style.filter = '';
        }
    }
}

// === Speech Recognition ===
function initSpeechRecognition() {
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

        if (interimResults) {
            interimResults.textContent = transcript;
        }
        captionsOverlay.classList.remove('hidden');

        if (event.results[current].isFinal) {
            setTimeout(() => {
                if (interimResults && interimResults.textContent === transcript) {
                    interimResults.textContent = '';
                    captionsOverlay.classList.add('hidden');
                }
            }, 3000);

            if (transcript.length === 0) return;

            const payload = {
                start_time: startTime,
                end_time: Date.now().toString(),
                client_index: SPEECH_CONFIG.clientIndex,
                name: SPEECH_CONFIG.name,
                text: transcript
            };

            if (window.chrome && chrome.webfuseSession) {
                chrome.webfuseSession.apiRequest({ cmd: 'log', msg: { ...payload, type: 'transcript' } });
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

    if (window.chrome && chrome.webfuseSession) {
        startAutoJoinTimer();
    }

    if (window.chrome && chrome.webfuseSession) {
        chrome.webfuseSession.onMessage.addListener(message => {
            if (message?.msg === 'get_session_participants') {
                const me = message.participants.find(participant => !!participant.self);
                if (me) {
                    SPEECH_CONFIG.clientIndex = me.client_index;
                    SPEECH_CONFIG.name = me.name;
                }
            }
        });

        chrome.webfuseSession.apiRequest({ cmd: 'get_session_participants' });
    }
}

function startAutoJoinTimer() {
    if (isListening) return;

    isAutoStartPending = true;
    captionBtn.classList.add('loading');

    autoStartTimeout = setTimeout(() => {
        if (isAutoStartPending) {
            isAutoStartPending = false;
            captionBtn.classList.remove('loading');
            if (recognition && !isListening) {
                try {
                    recognition.start();
                } catch (e) {
                    console.error('Error auto-starting recognition:', e);
                }
            }
        }
    }, 5000);
}

function toggleCaptions() {
    if (!recognition) return;

    if (isAutoStartPending) {
        clearTimeout(autoStartTimeout);
        isAutoStartPending = false;
        captionBtn.classList.remove('loading');
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

// === Device Selection ===
async function populateDeviceList() {
    const devices = await navigator.mediaDevices.enumerateDevices();

    micDropdown.innerHTML = '';
    camDropdown.innerHTML = '';

    const activeAudioDeviceId = localStorage.getItem('audioDeviceId');
    const activeVideoDeviceId = localStorage.getItem('videoDeviceId');

    devices.forEach(device => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.setAttribute('data-device-id', device.deviceId);
        if (device.kind === 'audioinput') {
            if (device.deviceId === activeAudioDeviceId) item.classList.add('selected');
            item.innerHTML = `
                <span class="material-icons-round">check</span>
                <span>${device.label || `Microphone ${micDropdown.children.length + 1}`}</span>
            `;
            item.onclick = () => switchDevice('audio', device.deviceId);
            micDropdown.appendChild(item);
        } else if (device.kind === 'videoinput') {
            if (device.deviceId === activeVideoDeviceId) item.classList.add('selected');
            item.innerHTML = `
                <span class="material-icons-round">check</span>
                <span>${device.label || `Camera ${camDropdown.children.length + 1}`}</span>
            `;
            item.onclick = () => switchDevice('video', device.deviceId);
            item.onmouseenter = () => {
                if (!camDropdown.classList.contains('hidden')) {
                    startCameraPreview(device.deviceId);
                }
            };
            camDropdown.appendChild(item);
        }
    });
}

function updateDeviceSelectionUI() {
    const audioDeviceId = localStorage.getItem('audioDeviceId');
    const videoDeviceId = localStorage.getItem('videoDeviceId');

    Array.from(micDropdown.children).forEach(child => {
        child.classList.remove('selected');
        if (child.getAttribute('data-device-id') === audioDeviceId) {
            child.classList.add('selected');
        }
    });

    Array.from(camDropdown.children).forEach(child => {
        child.classList.remove('selected');
        if (child.getAttribute('data-device-id') === videoDeviceId) {
            child.classList.add('selected');
        }
    });
}

// Camera Preview in Dropdown
function createCameraPreview() {
    let preview = camDropdown.querySelector('.device-preview');
    if (!preview) {
        preview = document.createElement('div');
        preview.className = 'device-preview';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        preview.appendChild(video);
        camDropdown.prepend(preview);
    }
    return preview;
}

async function startCameraPreview(deviceId) {
    const preview = createCameraPreview();
    const video = preview.querySelector('video');

    if (previewStream) {
        previewStream.getTracks().forEach(t => t.stop());
    }

    try {
        previewStream = await navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId: { exact: deviceId } } : true,
            audio: false
        });
        video.srcObject = previewStream;
    } catch (err) {
        console.error('Error starting camera preview:', err);
    }
}

function stopCameraPreview() {
    if (previewStream) {
        previewStream.getTracks().forEach(t => t.stop());
        previewStream = null;
    }
    const preview = camDropdown.querySelector('.device-preview');
    if (preview) {
        const video = preview.querySelector('video');
        if (video) video.srcObject = null;
    }
}

function toggleDropdown(e, type) {
    e.stopPropagation();
    const dropdown = type === 'mic' ? micDropdown : camDropdown;
    const otherDropdown = type === 'mic' ? camDropdown : micDropdown;

    // Close other dropdown (stop preview if cam is being closed)
    if (!otherDropdown.classList.contains('hidden')) {
        otherDropdown.classList.add('hidden');
        if (type === 'mic') stopCameraPreview();
    }

    // Close BG dropdown
    if (!bgDropdown.classList.contains('hidden')) {
        stopBgPreview();
        bgDropdown.classList.add('hidden');
    }

    const wasHidden = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden');

    // Start/stop camera preview when cam dropdown opens/closes
    if (type === 'cam') {
        if (wasHidden) {
            const currentDeviceId = localStorage.getItem('videoDeviceId');
            startCameraPreview(currentDeviceId);
        } else {
            stopCameraPreview();
        }
    }
}

async function switchDevice(type, deviceId) {
    if (type === 'audio') {
        localStorage.setItem('audioDeviceId', deviceId);
        micDropdown.classList.add('hidden');

        // Use OpenTok's setAudioSource for live audio switching
        if (publisher) {
            try {
                await publisher.setAudioSource(deviceId);
            } catch (err) {
                console.error('Error switching audio device:', err);
            }
        }
    } else {
        localStorage.setItem('videoDeviceId', deviceId);
        camDropdown.classList.add('hidden');
        stopCameraPreview();

        // Video requires destroying and recreating the publisher
        if (publisher && session && !isScreenSharing) {
            const localContainer = document.getElementById('local-video-container');
            const videoTarget = localContainer.querySelector('.video-target');

            session.unpublish(publisher);
            publisher.destroy();
            videoTarget.innerHTML = '';

            const audioId = localStorage.getItem('audioDeviceId');

            publisher = OT.initPublisher(videoTarget, {
                insertMode: 'append',
                width: '100%',
                height: '100%',
                showControls: false,
                mirror: false,
                audioSource: audioId || undefined,
                videoSource: deviceId,
                style: {
                    nameDisplayMode: 'off',
                    buttonDisplayMode: 'off',
                    audioLevelDisplayMode: 'off'
                }
            });

            session.publish(publisher, (error) => {
                if (error) {
                    console.error('Error republishing after device switch:', error);
                } else if (bgMode !== 'none') {
                    applyBackgroundEffect();
                }
            });
        }
    }

    updateDeviceSelectionUI();
}

// === Participant Count ===
function updateParticipantCount() {
    const count = Object.keys(subscribers).length + 1; // +1 for self
    const countElement = document.getElementById('participant-count');
    if (countElement) {
        countElement.textContent = `(${count})`;
    }
}

// === Picture in Picture ===
async function togglePictureInPicture() {
    if (!('documentPictureInPicture' in window)) {
        console.log('Document Picture-in-Picture API not supported');
        return;
    }

    if (pipWindow) return;

    try {
        pipWindow = await documentPictureInPicture.requestWindow({
            width: 360,
            height: 640,
        });

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

        pipWindow.document.body.append(appContainer);

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

// === Draggable ===
function initDraggable() {
    const header = document.querySelector('.app-header');
    if (!header) return;

    let isDragging = false;
    let dragState = null;
    let isMaximized = false;
    let isTopLeft = false;
    let previousSize = { width: 360, height: 320 };

    header.addEventListener('dblclick', async (e) => {
        if (e.target.closest('button')) return;

        try {
            if (window.browser && browser.webfuseSession) {
                const screenSize = await browser.webfuseSession.getScreenSize();

                if (!isMaximized && !isTopLeft) {
                    const newWidth = screenSize.width - 75;
                    const newHeight = screenSize.height - 75;

                    browser.browserAction.resizePopup(newWidth, newHeight);

                    isMaximized = true;
                    isTopLeft = false;
                    viewState = 2;
                    updateAllViewModeButtons();
                } else if (isMaximized && !isTopLeft) {
                    browser.browserAction.resizePopup(screenSize.width, screenSize.height);
                    browser.browserAction.setPopupPosition({ top: 0, left: 0 });

                    isMaximized = true;
                    isTopLeft = true;
                    viewState = 2;
                    updateAllViewModeButtons();
                } else {
                    browser.browserAction.resizePopup(previousSize.width, previousSize.height);

                    isMaximized = false;
                    isTopLeft = false;
                    viewState = 0;
                    updateAllViewModeButtons();
                }
            }
        } catch (err) {
            console.error('Error toggling maximize:', err);
        }
    });

    const startDrag = async (e) => {
        if (e.target.closest('button') || e.target.closest('.pin-btn') || e.target.closest('select')) return;

        isDragging = true;
        document.body.style.cursor = 'grabbing';

        try {
            const currentPosition = await browser.browserAction.getPopupPosition();
            const startLeft = parseInt(currentPosition.left) || 0;
            const startTop = parseInt(currentPosition.top) || 0;

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

    const grid = document.getElementById('video-grid');
    if (grid) {
        grid.addEventListener('mousedown', startDrag);
    }

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !dragState) return;

        const deltaX = e.screenX - dragState.startScreenX;
        const deltaY = e.screenY - dragState.startScreenY;

        const newLeft = Math.max(0, dragState.startLeft + deltaX);
        const newTop = Math.max(0, dragState.startTop + deltaY);

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

// === Start ===
init();
