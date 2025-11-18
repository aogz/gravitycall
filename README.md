# Gravity Call

A lightweight, multi-participant video chat application built as a **Webfuse extension**. Designed for seamless integration into your browsing experience with minimal dependencies and optimized performance.

## Features

### 🎥 Video Chat
- **Multi-participant support** - Connect with multiple users in real-time
- **WebRTC-based** - Peer-to-peer video and audio streaming
- **Room-based isolation** - Participants are grouped by URL/context
- **Device selection** - Choose your preferred microphone and camera
- **Persistent settings** - Device preferences saved locally

### 🎛️ Controls
- **Mute/Unmute** - Toggle microphone on/off
- **Camera toggle** - Enable/disable video stream
- **Layout modes** - Switch between grid and spotlight views
- **Settings panel** - Configure audio/video devices
- **Minimize** - Close the popup
- **Expand** - Toggle between compact (360x360) and large (480x640) modes

### 📐 Layout Modes

#### Grid Mode
- 2-column layout with videos filling available space
- No scrollbars - videos scale proportionally
- Optimized for equal participant visibility

#### Spotlight Mode
- Main speaker takes full screen
- Other participants in horizontal scrollable strip at bottom
- Click any thumbnail to switch active speaker

### 🎨 UI Design
- **Compact interface** - Minimal UI elements for maximum video space
- **Dark theme** - Easy on the eyes
- **Responsive** - Adapts to different popup sizes
- **No participant labels** - Clean, distraction-free view

### 🌐 Deployment
- **Webfuse extension** - Runs as a browser extension popup
- **Dockerized backend** - Easy deployment with Docker
- **Domain support** - Configured for `gravitycall.aogz.me`
- **WebSocket signaling** - Real-time peer coordination

## Architecture

### Room Logic
- Each user joins a room based on their session ID
- Rooms are isolated - users only see others in the same room
- Room IDs are base64-encoded session id for safety

### Signaling Flow
1. Client connects to WebSocket server
2. Sends `join` message with room ID
3. Receives `welcome` with unique client ID
4. Gets list of `existing-peers` in the room
5. Exchanges WebRTC offers/answers/ICE candidates
6. Establishes peer-to-peer connections

### Video Streaming
- Each peer maintains direct WebRTC connections to others
- STUN server used for NAT traversal
- Video mirrored for local preview
- Automatic track replacement when changing devices

## Configuration

### Popup Sizes
- **Compact (floating)**: 360x360 (bottom-left)
- **Expanded (sidebar)**: 480x640 (top-right, 40px from top)

## Contributing

Feel free to submit issues and pull requests.
