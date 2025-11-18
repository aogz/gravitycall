const videoGrid = document.getElementById('video-grid');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const layoutBtn = document.getElementById('layout-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const audioSelect = document.getElementById('audio-source');
const videoSelect = document.getElementById('video-source');

let localStream;
let myId;
let myColor;
let peers = {}; // { id: { connection, videoElement, color } }
let ws;
let isGridMode = true;

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// Initialize
async function init() {
    browser.browserAction.openPopup();
    browser.browserAction.detachPopup();
    browser.browserAction.resizePopup(360, 360);
    browser.browserAction.setPopupStyles({ border: '1px solid white', borderRadius: '24px' });
    browser.browserAction.setPopupPosition({ bottom: 0, left: 0 });
    await getMedia();
    connectToSignalingServer();
    populateDeviceList();

    // Event Listeners
    micBtn.addEventListener('click', toggleMic);
    camBtn.addEventListener('click', toggleCam);
    layoutBtn.addEventListener('click', toggleLayout);
    settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
    closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
    saveSettingsBtn.addEventListener('click', saveSettings);
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

    container.appendChild(video);
    container.appendChild(labelDiv);

    // Click to set as active speaker in active speaker mode
    container.addEventListener('click', () => {
        if (!isGridMode) {
            document.querySelectorAll('.video-container').forEach(c => c.classList.remove('active-speaker'));
            container.classList.add('active-speaker');
        }
    });

    return container;
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
            videoGrid.appendChild(container);
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
}

function toggleLayout() {
    isGridMode = !isGridMode;
    if (isGridMode) {
        videoGrid.classList.remove('active-speaker-mode');
        layoutBtn.querySelector('span').textContent = 'grid_view';
    } else {
        videoGrid.classList.add('active-speaker-mode');
        layoutBtn.querySelector('span').textContent = 'view_agenda';
        // Default to local user as active speaker if none selected
        if (!document.querySelector('.active-speaker')) {
            const local = document.getElementById('local-video-container');
            if (local) local.classList.add('active-speaker');
        }
    }
}

// Device Selection
async function populateDeviceList() {
    const devices = await navigator.mediaDevices.enumerateDevices();

    audioSelect.innerHTML = '';
    videoSelect.innerHTML = '';

    devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `${device.kind} ${audioSelect.length + 1}`;

        if (device.kind === 'audioinput') {
            audioSelect.appendChild(option);
        } else if (device.kind === 'videoinput') {
            videoSelect.appendChild(option);
        }
    });

    // Load saved preferences
    const savedAudio = localStorage.getItem('audioDeviceId');
    const savedVideo = localStorage.getItem('videoDeviceId');

    if (savedAudio) audioSelect.value = savedAudio;
    if (savedVideo) videoSelect.value = savedVideo;
}

async function saveSettings() {
    const audioDeviceId = audioSelect.value;
    const videoDeviceId = videoSelect.value;

    localStorage.setItem('audioDeviceId', audioDeviceId);
    localStorage.setItem('videoDeviceId', videoDeviceId);

    await getMedia(audioDeviceId, videoDeviceId);
    settingsModal.classList.add('hidden');
}

function updateParticipantCount() {
    const count = Object.keys(peers).length + 1; // +1 for self
    const countElement = document.getElementById('participant-count');
    if (countElement) {
        countElement.textContent = `(${count})`;
    }
}

init();
