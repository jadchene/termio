# Termio

[English](README.md) | [中文](README.zh-CN.md)

Termio is a local Windows SSH client that brings terminal sessions, SFTP file management, and remote system status into one desktop app.

## Screenshot

![Termio](docs/screenshot.png)

## Features

- Multiple SSH terminal tabs, including multiple connections to the same saved session.
- Session folders and a configurable default session.
- Password or SSH private-key authentication, including encrypted-key passphrases.
- SFTP browsing, upload, download, batch transfer, drag-and-drop, and common file operations.
- Remote system status for CPU, memory, network, disk, and supported GPUs.
- Dark and light themes with dark mode enabled by default.
- Local session and settings storage. Remembered passwords and key passphrases use the operating system credential store; private-key contents are never written to the database.

## Quick Start

```bash
npm install
npm run dev
```

Create a session, enter the server address and credentials, then open it from the session list. Use the left sidebar to switch between sessions, SFTP, and system status. Open Settings from the lower-left corner.

For key authentication, select **SSH private key** in the session dialog and choose an OpenSSH/PEM private-key file. Leave the passphrase empty for an unencrypted key. Paths such as `~/.ssh/id_ed25519` are supported, and the terminal and SFTP use the same authentication settings.

## Settings

- Dark or light theme
- Interface font size
- Terminal font family and size
- Cursor style, blinking, and bar width
- Auto-copy selection and right-click paste
- Multi-line paste confirmation
- Default download directory
- Single-instance behavior
- Optional English input-method switching
- Sidebar visibility and width
- Hidden-file display

The interface uses the bundled MiSans font. Terminal background, default text, and cursor colors follow the selected theme while command-defined ANSI colors remain unchanged.

## Runtime Data

Development data is stored in the project directory. Packaged data is stored next to `Termio.exe`:

```text
data/app.db
data/user-data/window-state.json
```

Data from earlier versions is moved into `data/` automatically on first launch.

## Development

```bash
npm run verify
npm run build
```

Create the Windows unpacked package:

```bash
npm run pack:unpacked
```

Output:

```text
release/Termio/Termio.exe
```

## License

MIT. See [LICENSE](LICENSE).
