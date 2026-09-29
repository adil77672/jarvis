# Jarvis AI Chat

AI chat in the sidebar of **VS Code, Cursor and Antigravity**. Paste an API key and start asking.

## Features
- **Paste a key and go.** On first open, choose a provider, paste your key and save it. Keys are stored in your OS keychain.
- **Many keys, many providers.** ApiFreeLLM (free), OpenRouter, Groq, Google Gemini, OpenAI, Anthropic, NVIDIA NIM, local OpenJarvis, local Ollama, or any OpenAI-compatible URL.
- **Pick the key and model** from the chat header. "Load" fetches the provider's model list.
- **Usage tracking.** Each key shows its requests today against its daily limit (e.g. `12/50 today`).
- **Automatic key switching.** When a key reaches its daily limit, gets rate-limited, runs out of credits or is rejected, Jarvis tries your next key and tells you. Keys are tried in the order shown on the Keys screen.
- **Code actions.** Select code and right-click → *Ask Jarvis About Selection* (`Cmd/Ctrl+Shift+J`), *Explain Selection*, *Find Bugs in Selection*. Code blocks in replies have **Copy** and **Insert** buttons.

## Settings
| Setting | Default | |
|---|---|---|
| `jarvis.autoSwitchKeys` | `true` | Move to the next key when one runs out |
| `jarvis.systemPrompt` | coding assistant | Instructions sent with every chat |
| `jarvis.maxContextChars` | `24000` | Older messages are dropped to stay under this size |

## Build & install
```bash
npm install
npm run package                    # -> jarvis-ai-chat-0.1.0.vsix
code --install-extension jarvis-ai-chat-0.1.0.vsix
```
In Cursor or Antigravity: Extensions panel → `…` → **Install from VSIX…**

To publish: `npx vsce publish` (VS Code Marketplace) and `npx ovsx publish` (Open VSX, which Cursor and Antigravity use).

## Author

Built by **Adil Mustafa** (adilmustafa@fusionwave.co). MIT licensed (see the LICENSE file).
