# Jarvis AI Chat

**A free, Claude-style AI chat for VS Code, Cursor and Antigravity.** Paste an API key and start asking. No account, no server, no subscription.

Jarvis runs entirely inside your editor and talks directly to the AI provider whose key you add. Use a free key (ApiFreeLLM, Google Gemini, Groq, OpenRouter) or your own OpenAI / Claude key, and add as many as you like: when one hits its daily limit, Jarvis switches to the next automatically.

## Features

**Chat**
- Clean chat panel in the sidebar with a personal greeting, Markdown replies and code blocks.
- **Copy** or **Retry** any answer. **Stop** a reply at any time.
- **Chat history**: every conversation is saved. Search, reopen or delete past chats.

**Your code**
- Type **`@`** to pick any file in your project, e.g. `@src/app.ts` or `@.gitignore`. Its contents are sent with your question.
- Attach files with 📎, add the **current file** with one click, right-click a file in the Explorer → **Add to Jarvis Chat**, or drag files in (hold **Shift** while dropping).
- Select code and press **⌘⇧J / Ctrl+Shift+J** to ask about it, or right-click → **Explain Selection** / **Find Bugs in Selection**.
- **Apply** button on code blocks that name a file: see a diff, then write the file. Undo with ⌘Z.
- **Insert** code at your cursor.

**Images**
- **Paste** (⌘V) or attach screenshots and ask about them (needs a vision model such as Gemini, GPT-4o, Claude or an OpenRouter vision model).
- **Generate images** with `/image a cat astronaut` (or "generate an image of…", "draw…"). The PNG is saved in your project and shown in the chat. Free, no key needed.
- Click any image to open the **viewer**: full size, zoom, save to project.

**Keys, models & usage**
- Providers: **ApiFreeLLM** (free), **Google Gemini**, **Groq**, **OpenRouter**, **OpenAI**, **Anthropic (Claude)**, **NVIDIA NIM**, **Ollama** (local), **OpenJarvis** (local), or **any OpenAI-compatible URL**.
- Pick the key and model from the chat box; **Load** fetches the provider's model list.
- **Usage tracking** per key (e.g. `12/50 today`) and an **Account** page with totals.
- **Automatic key switching** when a key reaches its daily limit, runs out of credits, is rate-limited or rejected. Short rate limits are waited out with a countdown.
- Keys are stored in your operating system's secure keychain, never in settings files.

## Getting started

1. Click the **Jarvis** icon in the activity bar.
2. Choose a provider, paste your API key, and click **Save key**.
   Free keys: [apifreellm.com](https://apifreellm.com/en/api-access) · [Google AI Studio](https://aistudio.google.com/apikey) · [Groq](https://console.groq.com/keys) · [OpenRouter](https://openrouter.ai/keys)
3. Type your question, or press `@` to add a file.

## Commands

| Command | Shortcut |
|---|---|
| Jarvis: Ask Jarvis About Selection | ⌘⇧J / Ctrl+Shift+J |
| Jarvis: Explain Selection | right-click menu |
| Jarvis: Find Bugs in Selection | right-click menu |
| Jarvis: Add Current File to Chat | right-click menu |
| Jarvis: Add to Jarvis Chat | Explorer right-click |
| Jarvis: New Chat | |
| Jarvis: Set API Key / Manage API Keys & Usage | |

## Settings

| Setting | Default | Description |
|---|---|---|
| `jarvis.autoSwitchKeys` | `true` | Try your next key when one runs out |
| `jarvis.systemPrompt` | coding assistant | Instructions sent with every chat |
| `jarvis.maxContextChars` | `24000` | Older messages are dropped to stay under this size |
| `jarvis.imageFolder` | project root | Where generated images are saved |
| `jarvis.imageSize` | `1024x1024` | Size of generated images |

## Privacy

Jarvis has no backend. Your messages go only to the AI provider you choose (and image prompts to pollinations.ai when you use `/image`). Keys stay in your OS keychain; chats are stored locally in your editor.

## Notes

- ApiFreeLLM's free tier allows about 50 requests a day and roughly one request every 20 seconds; it's text-only.
- The free image service allows about one image per minute.

---

Made by **Adil Mustafa** · MIT License
