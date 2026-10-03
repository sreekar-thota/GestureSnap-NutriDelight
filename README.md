# 📸 GestureSnap 2.0

> A gesture-controlled AI photo booth that lets users capture photos using hand gestures and download their final photo strip through a QR code.

---

## ✨ Overview

**GestureSnap 2.0** is an interactive, gesture-controlled photo booth application designed for Smart TVs, desktops, and mobile devices.

Instead of using a traditional mouse or touchscreen, users can interact with the photo booth using simple hand gestures detected through the camera.

The application captures **three photos**, creates a photo strip, generates a **QR code**, and allows users to scan the QR code with their phone to download their photo strip.

---

## 🎯 Key Features

### 📷 Gesture-Controlled Camera

- Uses the device camera for live video.
- Detects hand gestures in real time.
- Provides a touch-free photo booth experience.

### ✋ Hand Gesture Instructions

The application guides the user through three simple steps:

**STEP 1 — ✋ Show Both Hands**

Show both hands to begin the interaction.

**STEP 2 — 🤏 Pinch to Lock Frame**

Use a pinch gesture to create and lock the photo frame.

**STEP 3 — ⏱️ Auto-Capture Countdown**

Once locked, the 5-second countdown begins automatically and captures the photo at 0 without any extra gesture.

---

## 📸 Three-Photo Capture

GestureSnap captures a total of **3 photographs**.

The interface displays the current photo progress:

```text
PHOTO 0 / 3
PHOTO 1 / 3
PHOTO 2 / 3
PHOTO 3 / 3
GestureSnap 2.0/
│
├── .vscode/
│   └── settings.json
│
├── uploads/
│   └── Generated/captured files
│
├── download.html
├── index.html
├── README.md
├── script.js
├── server.py
└── style.css
🛠️ Technologies Used
Frontend
HTML5
CSS3
JavaScript
Web APIs
Camera API
Gesture Recognition
Hand tracking
Gesture detection
Real-time webcam processing
Backend
Python
Local HTTP server
File handling
QR generation and download functionality
🖼️ Photo Strip
📱 QR Code Download
⏱️ QR Code Timer
🔄 Reset
🖥️ Fullscreen Mode
📺 Smart TV Support
📱 Responsive Design
🎮 How to Use
1. Open GestureSnap
        ↓
2. Allow camera access
        ↓
3. Show both hands
        ↓
4. Pinch to lock the frame
        ↓
5. 5-second countdown begins automatically
        ↓
7. Photo captured
        ↓
8. Repeat until 3 photos are captured
        ↓
9. Photo strip generated
        ↓
10. QR code generated
        ↓
11. Scan QR with phone
        ↓
12. Download photo strip
        ↓
13. QR expires after 60 seconds
        ↓
14. Booth resets for next user
🎯 Project Goals

GestureSnap was created to make photo booths:

More interactive
Touch-free
Easy to use
Fun and engaging
Suitable for public environments
Compatible with large displays

The goal is to provide a hands-free photo booth experience using computer vision and gesture recognition.

---

## 🚀 Netlify Deployment

GestureSnap 2.0 is fully optimized for single-click deployment on **Netlify**.

### Steps to Deploy:
1. Push this repository to GitHub or import it directly into **Netlify**.
2. Deploy the site on Netlify (`netlify.toml` handles routing and functions automatically).
3. Netlify Functions (`/.netlify/functions/upload` and `/.netlify/functions/download`) use **Netlify Blobs** (`@netlify/blobs`) for persistent storage across serverless function invocations.
4. Scanning the generated QR code from any mobile device opens the hosted Netlify URL (e.g., `https://your-site.netlify.app/download.html?id=...`) and allows instantaneous photo strip downloads worldwide.
