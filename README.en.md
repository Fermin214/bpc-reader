# BPC Reader

[简体中文](README.md) | English

BPC Reader finds article links and gets article bodies for AI agents and other programs.
It uses a separate Chromium browser with a fixed BPC extension.
It exports visible article text as Markdown and JSON.

The current sites are Bloomberg, Reuters, and The Wall Street Journal (WSJ).
Each site adapter supports specific page types.

## Functions

- Article search and link discovery from built-in RSS sources.
- Single article reads and batch reading jobs with a resume function.
- Source URLs, authors, publication dates, body hashes, and completion evidence.
- Successful body cache and separate `ok`, `partial`, `blocked`, and `error` states.
- CLI, stdio Model Context Protocol (MCP), and local HTTP interfaces.
- Local BPC updates with tests before activation and backups for rollback.

Search snippets and RSS content are discovery data.
MCP returns body content to the model only when `summarizable=true`.
The caller selects articles and writes the analysis.

## Installation

The tool needs npm, a network connection, and a graphical desktop.
The recommended Node.js version is 24.15.0 or a later 24.x release.
[package.json](package.json) specifies all supported Node.js versions.
The acceptance tests use Windows with a graphical desktop.

1. Get the source files and open the project directory.

   ```sh
   git clone https://github.com/Fermin214/bpc-reader.git BPC-Reader
   cd BPC-Reader
   ```

2. Install the dependencies and prepare the browser.

   ```sh
   npm ci
   npm run setup
   npm run verify
   ```

The setup command downloads Chromium, loads BPC, and starts a separate browser profile.

For a proxy, add `--proxy http://host:port` to the setup command.
If PowerShell blocks `npm`, use `npm.cmd`.
The [installation guide](docs/INSTALL.md) gives the full procedure in Chinese.

## AI agent connection

1. Run `npm run mcp-config` to generate the MCP configuration.
2. Add the output to your agent's MCP settings.
3. Keep the settings for other MCP services.
4. Connect the MCP service again.
5. Call `reader_health`.

You can give an agent this request:

> Install BPC Reader from [the repository](https://github.com/Fermin214/bpc-reader.git).
> Read README.en.md, docs/INSTALL.md, and skills/bpc-reader/SKILL.md first.
> Use a separate directory and browser profile.
> Run setup and verify.
> Add the MCP configuration without changes to other services.
> Call reader_health and report the result.

MCP uses stdio directly.
The [MCP guide](docs/MCP.md) describes the tools, job states, and body content rules.

## CLI use

Replace `<article-url>` with an HTTPS article URL from a supported site.

```sh
npm run reader -- search "game industry" --sites bloomberg.com,reuters.com,wsj.com --limit 5
npm run reader -- read "<article-url>" --interactive
npm run reader -- rss
npm run reader -- rss --feeds bloomberg-jason-schreier,wsj-technology --keywords gaming --limit 20
```

Search returns candidate links by default.
The RSS command without source options returns the source catalog.
The [CLI guide](docs/CLI.md) describes batch jobs, date filters, and local HTTP routes.

## Result states

| State | Meaning |
|---|---|
| `ok` | The visible body passes the site completion tests. |
| `partial` | The body is short, has missing blocks, or has insufficient completion evidence. |
| `blocked` | A site challenge or access restriction prevents the read. |
| `error` | Navigation, a timeout, the runtime, or extraction fails. |

A site can require human verification.
Do this step in the tool browser.

Bloomberg features export text only.
Their warnings identify the export scope and omitted media components.
The article body comes from visible rendered paragraphs.
The [RSS guide](docs/RSS.md) lists the sources.

## BPC update

Replace `<extension-directory>` with the unpacked MV3 directory that contains `manifest.json`.

```sh
npm run bpc-update -- inspect --source "<extension-directory>"
npm run bpc-update -- apply --source "<extension-directory>"
npm run bpc-update -- status
```

The update command tests the candidate before it backs up and replaces the active files.
Active jobs keep their original BPC version.
New jobs use the new version.
The BPC hash separates old and new cache entries.
The [BPC update guide](docs/BPC-UPGRADE.md) gives the rollback procedure.

## Guides and source files

The detailed guides use Chinese.

| Guide | Contents |
|---|---|
| [Installation](docs/INSTALL.md) | Requirements, browser setup, and MCP connection. |
| [CLI and HTTP](docs/CLI.md) | Commands, options, and local routes. |
| [MCP](docs/MCP.md) | Tools, jobs, and model content rules. |
| [RSS](docs/RSS.md) | Sources, filters, and discovery results. |
| [Architecture](docs/ARCHITECTURE.md) | Modules, site adapters, and cache. |
| [BPC update](docs/BPC-UPGRADE.md) | Preview, tests, activation, and rollback. |
| [Validation](docs/VALIDATION.md) | Repeatable tests and procedures. |

The `src/` directory contains runtime code.
The `scripts/` directory contains setup tools and automated tests.
The `vendor/bpc/` directory contains the fixed upstream extension.
The `assets/bpc.json` file contains its integrity record.

Git excludes `.cache/`, `output/`, and `.local-history/`.
These local directories can contain browser sessions, article bodies, and machine paths.

## License

BPC Reader uses the [MIT license](LICENSE).
The bundled BPC comes from [magnolia1234's project](https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean).
The [upstream license](vendor/bpc/LICENSE) remains in the bundle.
