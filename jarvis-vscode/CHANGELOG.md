# Changelog

## 0.10.1
- **Agent executes plans immediately**: when a plan is created, the agent starts the first step right away instead of waiting. Includes explicit examples of the action block format so models follow the protocol.
- **Fallback plan detection**: numbered/bulleted lists in replies are now detected as plans even without a ```plan code block, so more models work in plan mode.
- **Greeting auto-explores**: saying "hi" in agent mode now triggers project exploration (list files, read config) instead of asking what to do.
- **Clear auto-switch notice**: when Jarvis switches to another key because the selected one failed, the notice now names the failed key and explains why.
- **Agent/Ask mode chip**: the Agent button now shows ⚡ Agent or 💬 Ask so the current mode is always visible.

## 0.10.0
- **Model auto-recovery**: when a provider retires a model name, Jarvis detects the error, fetches the provider's current model list, picks the closest replacement, and retries — no manual intervention needed.
- **Updated all provider defaults** to current model IDs (Gemini 3.8 Flash, GPT-6 Luna, Claude Sonnet 5.5, Grok 4.3, etc.).
- **Removed GitHub Models** preset (service shut down July 2026); existing keys migrated to Custom.
- **Renamed presets**: "Google Gemini" → "Google AI Studio (Gemini)", "Anthropic (Claude)" → "Claude (Anthropic)"; saved keys update automatically.
- **One-time migration** updates saved keys with retired model defaults on first launch.
- Improved error classification for Anthropic and OpenRouter model-not-found responses.
- Model suggestion extraction no longer picks up English words from error messages.
- Stop button works during model recovery.
- Replacement model is persisted only after a successful retry.
- 19 providers (11 free).

## 0.9.0
- **20 providers, 11 with free tiers**: added GitHub Models, SambaNova, Hugging Face and Cohere.
- Provider list grouped into **Free tier / On your computer / Paid**.
- **Get free keys** guide on the Keys screen: what each free provider offers, a link to get the key, and one-click Add.

## 0.8.3
- Clear message when a local provider (OpenJarvis, Ollama, LM Studio) isn't running, with how to start it.
- Clear message for video files (not supported yet).
- Switching a key's provider in the edit form also updates its name.

## 0.8.2
- Renamed to **Jarvis AI Chat & Code Assistant** (same extension ID: your keys, chats and settings are kept).

## 0.8.1
- Agent acts instead of asking: it now sees your project's file list and the file open in the editor ("this file"), and picks or creates files itself.
- Copy: Copy button on your messages, always-visible Copy on replies, selectable text and a ⌘C/Ctrl+C fallback.
- Settings toggles no longer fail with "not a registered configuration"; Jarvis asks you to reload when an update isn't fully loaded.

## 0.8.0
- **Plan mode like Cursor**: the agent writes a task checklist, shows it above the chat box with progress, and keeps working until every step is done. New `/plan <goal>` command.
- Agent is instructed to actually do the work (create/edit files) instead of explaining how.
- **How to use Jarvis** tips on the welcome screen (drag, paste, @, /, build) with one-click demos.
- Drop overlay while dragging files onto the panel.

## 0.7.0
- **Streaming replies**: text appears live with a cursor; non-streaming providers get a smooth typing effect.
- **Agent can read and list files**, runs commands in a visible **Jarvis terminal** and reads the output.
- **Finer permissions**: Allow this file, Allow all edits/commands, and auto-approve switches on the Account page.
- **Long pastes become chips** (Pasted text · N lines); click any file chip to open it.
- **Automatic updates** from GitHub releases (Check for Updates command + Account page).

## 0.6.0
- **Agent mode**: create/edit files and run commands with permission cards (Allow, Always allow, View diff, Deny); command output is fed back so Jarvis can continue.
- **Slash commands**: /fix /explain /tests /review /doc /project /diff /commit /push /run /image /agent /help.
- **Git**: AI-written commit messages, diff review, push.
- **Voice**: dictation, hands-free Live voice chat, and spoken replies.
- Attach **zip files**, **folders** and the **whole project**; `@` mentions include folders.
- 16 providers (added DeepSeek, Mistral, xAI, Together, Cerebras, LM Studio) with image-support labels; change provider and pick models from a dropdown.
- Images no longer block text-only keys: Jarvis answers from the text and says the image was skipped.

## 0.5.0
- New Claude-style interface: greeting, message layout, key/model picker in the chat box.
- `@` file mentions: pick any project file to include it.
- Image viewer: click any image to view full size, zoom, save to project.
- Chat history: conversations are saved; search, reopen, delete.
- Account page: your name, usage per key, totals, quick settings.
- Retry button on the last answer.

## 0.4.0
- Generate images with `/image …` (saved as PNG in your project).
- **Apply** button on code blocks that name a file: review the diff, then write the file.

## 0.3.0
- Redesigned chat: key/model switcher, bubbles, suggestions, rounded composer.
- Attached files are clearly framed so models read them; typo-tolerant prompt.

## 0.2.0
- Attach files and images (button, current file, Explorer, paste, drag & drop).
- Automatic retry when a key is briefly rate-limited.

## 0.1.0
- Sidebar chat, multiple API keys and providers, daily usage tracking, automatic key switching.
