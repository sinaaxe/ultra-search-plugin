# Obsidian Line Search Plugin

**Line Search** is a high-performance, community plugin for [Obsidian](https://obsidian.md) that lets you search and rank individual lines across all Markdown files in your vault. It supports **fuzzy subsequence matching** and **out-of-order word matching** while maintaining a lightweight in-memory index that updates incrementally in real time.

---

## Key Features

1. **Single-Line Centric Search**:
   - Searches every line of every Markdown file as an independent search unit.
   - Shows matching lines directly in the suggestions list.

2. **Advanced Matching & Ranking**:
   - **Out-of-Order Search**: Querying `hello world` will match lines like `world says hello` as well as `hello, world!`.
   - **Fuzzy Matching**: Matches characters using subsequence alignments, meaning a query of `fz srh` will match `fuzzy search`.
   - **Dynamic Scoring**: Ranks results based on exact matches, word boundaries, matching character proximities, character order, and line lengths.

3. **Premium Suggestion UI**:
   - Native integration with Obsidian's Command Palette suggestions layout.
   - Highlight rendering showing precisely which characters in the line matched your query.
   - Shows metadata badge for the file path and the line number.

4. **Editor Navigation**:
   - Hitting `Enter` or clicking on a suggestion opens the note.
   - Automatically scrolls the editor to center the target line and moves the cursor directly to the line.
   - Support for opening files in new tabs/panes by holding the `Ctrl`/`Cmd` modifier key.

5. **Optimized Background Indexer**:
   - Skips empty lines to reduce memory consumption.
   - Keeps pre-lowercased line references in memory to maximize performance.
   - Updates incrementally in the background using vault event listeners (`create`, `modify`, `delete`, and `rename`), avoiding full re-indexing steps.

---

## Installation & Setup

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
1. Copy the `build` folder into your Obsidian vault's plugins folder under the name `line-search`:
   ```bash
   cp -r build <path-to-your-vault>/.obsidian/plugins/line-search
   ```
2. Open Obsidian and go to **Settings** -> **Community plugins**.
3. Enable **Line Search** from the list of installed plugins.

---

## How to Use

- Open the Command Palette (`Ctrl/Cmd + P`), type `Line Search: Open line search`, and press `Enter`. (Alternatively, click the magnifying glass ribbon icon on the left sidebar).
- Type your search terms (separated by spaces).
- Use the arrow keys to navigate matching lines, and hit `Enter` to open and jump directly to that line.

---

## Settings

* **Minimum query length**: The minimum characters you need to type before the search starts.
* **Maximum results**: The maximum number of results to display in the list (defaults to `10` to keep rendering fast).
* **Exclude folders**: Comma-separated list of directories (e.g., `templates, archive`) to ignore during line indexing.

---

## License

This project is licensed under the MIT License.
