# Tempo Find My helper (macOS)

Follows your iPhone through Find My (iCloud) every 5–30 minutes, stores the history on
your Mac, and lets the Tempo page in the Claude desktop app read it (local MCP server
`tempo_location`). Nothing is installed on the iPhone.

    ./install.sh                       # installs uv, the background collector, and the MCP server
    ~/.local/bin/uv run --script ~/Library/Application\ Support/Tempo/tempo_findmy.py login
    ~/.local/bin/uv run --script ~/Library/Application\ Support/Tempo/tempo_findmy.py once

Data: `~/Library/Application Support/Tempo/` (pings.sqlite, state.json, poll.log).
Password: macOS Keychain, service `tempo-findmy`.
Uninstall: `launchctl bootout gui/$(id -u)/com.tempo.findmy`, delete
`~/Library/LaunchAgents/com.tempo.findmy.plist` and the folder above, and remove
`tempo_location` from `~/Library/Application Support/Claude/claude_desktop_config.json`.

Uses pyicloud, an unofficial iCloud client. Apple asks you to sign in again roughly
every two months; Tempo shows when.
