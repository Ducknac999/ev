<p align="center"><img src="src-tauri/icons/128x128@2x.png" width="96" alt="E.V"></p>

<h1 align="center">E.V</h1>
<p align="center"><b>A free, open-source AI assistant and agent for your Mac.</b><br>Talk to it or type to it, and it gets things done: on your Mac, on the web, and in your code.</p>

---

## What is E.V?

E.V is one app that holds all your AI in one place. It can:
- run many chats side by side
- run Claude Code and Codex in real terminals
- speak and listen
- control your Mac
- live in your Mac's notch

You choose which AI powers it: a cloud model with your own API key, your Claude subscription, or a model running entirely on your Mac.

## What it can do

**🧠 Many AIs, many chats at once**
- Run several chats side by side in split panes, each with its own model.
- **Cloud models:** DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, xAI Grok, Mistral and Groq, using your own API keys.
- **Claude Code and Codex:** run in real terminals inside E.V. Sessions keep running even when you close the window.
- **Local models:** run fully on your Mac with Ollama. No internet and no account needed.
- **Custom server:** any OpenAI-compatible server works.
- **Your keys:** add several keys per provider. E.V switches to the next one when a key hits its limit.
- **Costs:** a usage tracker and an optional daily spending limit.

**🤖 An agent that actually does things**
- Opens apps, websites and files.
- Clicks and types to get things ready for you.
- Searches the web and reads pages.
- Controls music, volume and dark mode.
- Looks at an app's window to understand what you mean.
- Works in your project folder.
- Uses its own background browser for research, never your own tabs.
- Connects to Gmail, Calendar, Notes, Reminders, YouTube and more (Settings → Connections).
- Remembers what matters to you, and runs reminders and scheduled tasks.

**🎙️ Voice**
- **Talk mode:** say "Hey E.V" and have a hands-free conversation. Double-tap ⌘ to turn it on or off from anywhere.
- **Dictation into any app:** hold Right Option, talk, and let go. Your words are pasted where your cursor is.
- **Speech-to-text on your Mac:** your speech is turned into text on your Mac and cleaned up there (no "um", no stutters, your own spellings for names).
- **Spoken replies:** E.V answers out loud in a natural voice, pausing your music while it speaks.

**⚡ Instant actions, no AI needed**
- Volume, play/pause/skip, dark mode, opening apps, finding files, math and the time happen instantly.
- No tokens or cost, however you phrase it.
- On macOS 26, your Mac's own on-device model works out what you meant.

**🔲 The E.V notch**

E.V lives in your Mac's notch. Hover over it or use a shortcut to open it:
- **Chat:** a mini chat with E.V from any app.
- **Music:** the song playing now, with controls and live synced lyrics.
- **Drop box:** park files, then drag them out wherever you need them.
- **Clipboard:** everything you've copied. Press ⌘⇧C, search, and paste. Passwords are never kept.
- **Dictation:** your last 20 dictations, ready to copy.
- **Live moments:** what E.V heard and answered, and approval requests you can click.
- **☕ Caffeine:** keeps your Mac awake, even with the lid closed.
- **Full screen:** the notch steps aside in full-screen apps.

**⌨️ Quick panel**
- A small E.V chat over any app with one shortcut (⌥Space).

## You stay in control

E.V asks before doing anything risky, and you decide what it may do on its own.
- **Allowed by default:** simple, safe actions like searching the web, opening apps and changing the volume.
- **Asks you first:** looking at your whole screen, reading your clipboard, quitting apps, running commands, editing files, and anything outside your project folder.
- **Always shows a preview first:** sending and deleting (emails, messages, events).
- **Code changes:** made in a safe copy that you review before anything is applied.
- **Approve from anywhere:** from the notch or with a keyboard shortcut. Important approvals can require a spoken passphrase.

## Private by design

Everything stays on your Mac:
- your keys, stored in the macOS keychain
- your chats, memory, settings and clipboard history

E.V has no server and no analytics. It only talks to the AI providers you add, and to this page to check for updates.

## Install

**Option 1 (easiest).** Copy this, paste it into **Terminal**, and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/Ducknac999/ev/main/install.sh | bash
```

E.V installs and opens by itself, then the setup window walks you through the rest.

**Option 2 (DMG).** Download **E.V.dmg** from [Releases](https://github.com/Ducknac999/ev/releases/latest), open it, and drag E.V into Applications.

The first time you open it, macOS blocks it because E.V isn't from the App Store. To allow it once:

1. Click **Done** on the message.
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "E.V was blocked".
3. Enter your Mac password. E.V opens and setup starts.

You only do this once. Updates never ask again.

**Needs:** a Mac with Apple silicon (M1 or newer) and macOS 14 or newer. Instant actions that understand any phrasing need macOS 26 with Apple Intelligence.

## Updates

**Settings → General → Check for updates** shows what's new and installs it in one click. Your settings, keys and chats stay.

## License

MIT. See [LICENSE](LICENSE). Some methods come from other open-source projects; see [CREDITS.md](CREDITS.md).

**Use at your own risk.** Read the [**Disclaimer**](DISCLAIMER.md) before using E.V.
