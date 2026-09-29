# Jarvis

A personal AI setup by **Adil Mustafa**: **Jarvis AI Chat & Code Assistant**, a free AI chat and coding agent for VS Code, Cursor and Antigravity, plus a local [OpenJarvis](https://github.com/open-jarvis/OpenJarvis) server wired to free LLM APIs.

## What's inside

| Folder | What it is | License |
|---|---|---|
| [`jarvis-vscode/`](jarvis-vscode/) | **Jarvis AI Chat & Code Assistant** editor extension: Claude-style streaming chat; coding agent that plans tasks, reads/edits files and runs commands with your permission; `@` file mentions and `/` commands; files, folders, zips and images; image generation; git commit/diff; voice and spoken replies; chat history; 16 providers with usage tracking and automatic key switching | MIT |
| [`apifreellm-shim/`](apifreellm-shim/) | Tiny local server that makes [apifreellm.com](https://apifreellm.com) look like an OpenAI API, so OpenJarvis and other tools can use it | MIT |
| [`start-jarvis.sh`](start-jarvis.sh) | Starts the shim and the OpenJarvis API server with one command | MIT |
| [`OpenJarvis/`](OpenJarvis/) | Local-first personal AI framework from Stanford (Hazy Research / Scaling Intelligence Lab), included unmodified | Apache 2.0, see `OpenJarvis/LICENSE` |

## Extension quick start

```bash
cd jarvis-vscode
npm install
npm run package                      # builds jarvis-ai-chat-<version>.vsix
code --install-extension jarvis-ai-chat-*.vsix
```

Or download the latest `.vsix` from this repo's [Releases](https://github.com/adil77672/jarvis/releases).

Open the **Jarvis** icon in the sidebar, pick a provider, paste your API key, and chat. In Cursor or Antigravity use *Extensions → … → Install from VSIX*. See [`jarvis-vscode/README.md`](jarvis-vscode/README.md) for all features.

## OpenJarvis server quick start

Requires [uv](https://docs.astral.sh/uv/) and Python 3.10+.

```bash
cp .env.example .env                 # then put your key in .env
cd OpenJarvis && uv sync --extra server --extra inference-cloud && cd ..
./start-jarvis.sh                    # shim on :1234, OpenJarvis API on :8000
```

The API is OpenAI-compatible at `http://127.0.0.1:8000/v1`; the extension can use it via the *Local OpenJarvis* provider.

## Secrets

The extension stores API keys in your OS keychain, never in files. For the OpenJarvis server, the key lives in `.env`. **This repo is private and currently tracks `.env`**: rotate the key before making the repo public or sharing it, and remove `.env` from git at that point.

## Credits

OpenJarvis is © its authors and licensed under Apache 2.0: *OpenJarvis: Personal AI, On Personal Devices*, Saad-Falcon et al., 2026 ([paper](https://arxiv.org/abs/2605.17172)). Everything outside `OpenJarvis/` is © 2026 Adil Mustafa, MIT licensed.
