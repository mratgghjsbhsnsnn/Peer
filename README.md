# LINKA — app-style communication web app

Mobile-first vanilla HTML/CSS/JS application using PeerJS/WebRTC for peer-to-peer messaging and calls.

## What changed in this design revision
- Bottom navigation is always visible; no hamburger menu.
- Home screen is a compact two-column friends layout on desktop instead of a long list.
- Friends use cards with clear primary actions and consistent iconography.
- No gradient UI surfaces; the interface uses a neutral system palette with one accent color.
- Tabler Icons is used for UI iconography. Tabler Icons are free and MIT licensed.
- The app logo is a minimal LINKA mark based on a simple link metaphor.
- PWA manifest and service worker are included.

## Run / deploy
Static hosting is enough. Upload this folder to GitHub and deploy the repository to Vercel. HTTPS is required for camera, microphone, service workers, and PWA installation.

## Runtime services
- PeerJS 1.5.5 (CDN) for signaling and WebRTC abstractions.
- Tabler Icons webfont (CDN) for interface icons.

## Data
Account, friend list, and chat history are stored locally in localStorage. This is device-local data, not a server-side account system.

## Icon license
Tabler Icons: MIT License. Source: https://github.com/tabler/tabler-icons
Lucide is not bundled in this revision.
