# Prepress Job Instructions

Internal tool for tracking prepress job specs, CSR instructions, and component checklists.

## Setup

1. Install Node.js from [nodejs.org](https://nodejs.org/) (LTS version)
2. Open a terminal in this folder
3. Run `npm install`

## Start

```
node server.js
```

## Access

Open `http://[hostname]:3000` in any browser on the network.

Multiple users can access the same jobs simultaneously from different machines.

## Backup

The entire database is one file: `prepress.db`

Copy this file on a schedule. That's it. That's the whole database.

## Stop

Press `Ctrl+C` in the terminal.

For auto-start, set up as a Windows service (using [nssm](https://nssm.cc/)) or a systemd service on Linux.

## Notes

- No other software, accounts, or configuration needed
- Data persists in `prepress.db`, not in browser storage
- The server runs on port 3000 by default
