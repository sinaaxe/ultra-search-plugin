# Obsidian UltraSearch Plugin

**UltraSearch** is a high-performance community plugin for [Obsidian](https://obsidian.md) that lets you search and rank both **file names** and **individual line contents** across all Markdown files in your vault. It supports **typo-tolerant prefix matching** and **out-of-order multi-word matching** while maintaining a lightweight, incrementally-updated index and delivering a lag-free, debounced typing experience.

---

## Key Features

1. **Unified File Name & Line-Level Search**:
   - Searches every file name and every line of every Markdown file independently.
   - Shows both matching file names and matching lines directly in the suggestions list.

2. **Harmonious Color-Coded Badges**:
   - Every result is clearly categorized using HSL-tailored, theme-compatible colored badges on the right side:
     - **Green Badge (Line)**: Indicates a line search match.
     - **Blue Badge (File)**: Indicates a file name match.
   - A static search type legend is fixed at the bottom of the modal window wrapper to define the colors clearly.

3. **Advanced Matching & Ranking**:
   - **Out-of-Order Multi-Word Search**: Querying space-separated terms (e.g. `hello world`) matches items containing all terms in any order (AND search).
   - **Exact Substring Match**: High-priority matching for exact term matches in the file name or line.
   - **Typo-Tolerant Word Prefix Match**: For query terms of 3-5 characters, matches words with up to 1 typo; for terms of 6 or more characters, matches words with up to 2 typos.
   - **Order-Aware Scoring**:
     - Sorts results descending by relevance (best match first).
     - Higher base scores for exact matches and word-boundary starts.
     - Sequence order bonus (+20 score) when terms appear in the same order as the query.
     - File matches receive a slight score boost (+10) to prioritize note files when match relevance is identical to content matches.
     - Penalizes long file names/lines slightly (by 0.01 per character) to favor shorter, more concise matches.

4. **Editor Navigation**:
   - Hitting `Enter` or clicking on a line suggestion opens the note and scrolls directly to that line.
   - Hitting `Enter` or clicking on a file suggestion opens the file at the top.
   - Support for opening files in new tabs/panes by holding the `Ctrl`/`Cmd` modifier key.

---

## How to Use

- Open the Command Palette (`Ctrl/Cmd + P`), type `UltraSearch: Open`, and press `Enter`. (Alternatively, click the magnifying glass ribbon icon on the left sidebar).
- Type your search terms (separated by spaces).
- Use the arrow keys to navigate matching files and lines, and hit `Enter` to open.

---

## Settings

* **Minimum query length**: The minimum characters you need to type before the search starts.
* **Maximum results**: The maximum number of results to display in the list (defaults to `10` to keep rendering fast).
* **Exclude folders**: Comma-separated list of directories (e.g., `templates, archive`) to ignore during line indexing.

---

## Security & Privacy

### Vault Enumeration & Data Access
This plugin uses the Obsidian API (`app.vault.getMarkdownFiles`) to discover Markdown files in your vault.
* **Why it is needed**: This is required to read file contents and build a local, in-memory search index.
* **Privacy & Local-First**: All indexing, scanning, and search matching run entirely on your local machine. No vault data, file paths, or search queries ever leave your device or get transmitted over the internet.

---

## License

This project is licensed under the MIT License.

---

## Local Development & Installation

### Building From Source
If you are compiling this plugin from source:
1. Clone or download the repository files.
2. Open a terminal in the plugin directory and run:
   ```bash
   npm install
   ```
3. Compile and bundle the plugin:
   ```bash
   npm run build
   ```
   This will generate a `build/` folder containing the compiled code bundle (`main.js`), metadata (`manifest.json`), and stylesheets (`styles.css`).

### Loading into Obsidian
1. Copy the `build` folder into your Obsidian vault's plugins folder under the name `ultra-search`:
   ```bash
   cp -r build <path-to-your-vault>/.obsidian/plugins/ultra-search
   ```
2. Open Obsidian and go to **Settings** -> **Community plugins**.
3. Enable **UltraSearch** from the list of installed plugins.
