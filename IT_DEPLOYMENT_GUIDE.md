# Prepress Job Instructions -- IT Deployment Guide

## What This Is

Internal web app for tracking prepress job specs, CSR instructions, and component checklists. Built by David Marra for the prepress department.

## Security Summary

| Item | Detail |
|------|--------|
| External network access | **None.** App makes zero outbound connections after install. |
| Cloud services | **None.** No telemetry, no analytics, no phoning home. |
| User accounts / passwords | **None stored.** No login system. |
| Data storage | Local SQLite file (`prepress.db`) on the host machine only. |
| Encryption | Data is not encrypted at rest (plain SQLite). |
| API keys / secrets | **None.** No API keys, tokens, or credentials anywhere in the code. |
| File uploads | **None.** The app does not accept file uploads. |
| Source code | 100% readable JavaScript. No compiled binaries, no obfuscated code. |

## What's in the Zip

```
prepress/
  server.js           -- Node.js web server (Express)
  db.js               -- SQLite database layer
  package.json         -- dependency manifest (3 packages)
  package-lock.json    -- locked dependency versions
  README.md            -- quick-start instructions
  public/
    index.html         -- the app interface
    css/styles.css     -- styling
    js/app.js          -- frontend logic
```

**No executables. No binaries. No hidden files.** Everything is plain-text JavaScript, HTML, and CSS.

## Dependencies (installed by `npm install`)

Only 3 direct dependencies:

| Package | Version | What It Does | NPM Page |
|---------|---------|-------------|----------|
| express | ^4.21.0 | Web server framework | npmjs.com/package/express |
| cors | ^2.8.5 | Cross-origin request handling | npmjs.com/package/cors |
| better-sqlite3 | ^11.7.0 | SQLite database driver | npmjs.com/package/better-sqlite3 |

All three are widely used, open-source packages. Express alone has 30M+ weekly downloads. `npm install` will also pull in their sub-dependencies (~100 small packages, all from the npm public registry).

**Note:** `better-sqlite3` compiles a small native addon during `npm install`. This requires a C++ build toolchain. On Windows, run `npm install --global windows-build-tools` first if the install fails, or install Visual Studio Build Tools (C++ workload).

## Network Requirements

| Direction | Port | Protocol | Purpose |
|-----------|------|----------|---------|
| Inbound | 3000 | HTTP | Browser access to the app |
| Outbound | 443 | HTTPS | **Only during `npm install`** (downloads packages from registry.npmjs.org). Not needed after. |

**No other ports. No other connections.** After `npm install`, the machine can be fully air-gapped and the app will still work.

## Installation Steps

1. Install Node.js LTS (v18 or newer) from https://nodejs.org
2. Download the latest app zip: https://github.com/vioverse-io/prepress-server/archive/refs/heads/main.zip
3. Unzip to desired location (e.g. `C:\PrepressWO\`)
4. Open terminal/command prompt in the extracted folder
5. Run: `npm install`
6. Run: `node server.js`
7. Open browser to `http://localhost:3000`

## Multi-User Access

The app serves on `http://[hostname]:3000`. Any machine on the same network can access it by navigating to that URL. **This means:**

- Open port 3000 in Windows Firewall for the host machine
- All users on the LAN can read, create, edit, and delete jobs
- There is no authentication layer. Access control is network-level only.

**If stricter access control is needed:** Restrict by IP at the firewall, or place behind a reverse proxy with authentication.

## Data & Backup

- All data lives in one file: `prepress.db` (in the app folder)
- The database is created automatically on first run
- Backup = copy `prepress.db` on a schedule. That's the entire database.
- To migrate to another machine: copy the whole `prepress` folder including `prepress.db`

## Running as a Service (Optional)

To auto-start on boot:

**Windows:** Use [NSSM](https://nssm.cc/) (Non-Sucking Service Manager)
```
nssm install PrepressApp "C:\Program Files\nodejs\node.exe" "C:\path\to\prepress\server.js"
nssm set PrepressApp AppDirectory "C:\path\to\prepress"
nssm start PrepressApp
```

**Linux:** Create a systemd service file pointing to `node server.js` in the app directory.

## What This App Does NOT Do

- Does not access the internet after installation
- Does not store passwords or personal information
- Does not accept file uploads
- Does not send emails or notifications
- Does not run background processes
- Does not modify system files or registry
- Does not require admin/root privileges to run (only to install Node.js)

## Contact

Built by David Marra. Questions about the application can be directed to him.
