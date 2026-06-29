# Brave WebMCP Tool Scripts

This repository holds the **WebMCP tool scripts** that Brave ships to clients via
the [component updater](https://github.com/brave/brave-core/blob/master/docs/ship_a_file_to_all_clients.md).

Each script registers a single [WebMCP](https://github.com/webmachinelearning/webmcp)
tool on pages whose URL matches the script's `@match` pattern(s). Brave injects
the script into the page's main world, where it calls
`navigator.modelContext.registerTool(...)`. The tool is then discovered by
Brave's AI Chat content-tool pipeline like any page-registered tool.

The Brave-side consumer lives in
[`brave-core`](https://github.com/brave/brave-core) under
`components/web_mcp/` (parsing, registry, component installer) and
`browser/ai_chat/web_mcp_injection/` (the per-tab injector).

## Layout

```
manifest.json          Component manifest (name, version, public key).
scripts/               One .js file per WebMCP tool.
  gmail_unread_count.js
  example_page_heading.js
```

A new tool is added by dropping a new `.js` file into `scripts/`. There is no
central index to update — Brave enumerates the directory and parses each file's
metadata block at runtime.

## Script format

Every script starts with the standard Brave license header, followed by a
metadata block delimited by `// ==WebMCP==` / `// ==/WebMCP==` (the
Greasemonkey/userscript convention). Everything **after** the closing fence is
the body of the tool's `async execute(input)` callback.

```js
// ==WebMCP==
// @name        unread_count
// @match       https://mail.google.com/*
// @description Report the number of unread messages in the Gmail inbox.
// @schema      {"type":"object","properties":{}}
// ==/WebMCP==

// Read the unread count from the aria-label on the Inbox nav link rather than
// any Gmail API, and surface it as the tool result.
const inboxLink = document.querySelector('a[href*="#inbox"]');
return inboxLink ? inboxLink.getAttribute('aria-label') : 'Inbox not found.';
```

### Metadata keys

| Key            | Required | Repeatable | Meaning                                                                                  |
| -------------- | -------- | ---------- | ---------------------------------------------------------------------------------------- |
| `@name`        | yes      | no         | The `name` passed to `registerTool()`. Don't include the site — it's implied by `@match` (e.g. `unread_count`, not `gmail_unread_count`). |
| `@match`       | yes      | yes        | A URL glob (`*` / `?` wildcards, matched against the full URL spec). One tool may list multiple. |
| `@description` | yes      | yes        | The tool `description`. Multiple lines are joined with a single space.                    |
| `@schema`      | no       | no         | JSON Schema for the tool's `inputSchema`. Defaults to `{"type":"object","properties":{}}` (a no-input tool). |

### Body

The body runs as `async execute(input) { ... }` in the page's main world and
may read or manipulate the DOM. It must `return` a string (or a value coercible
to one) which becomes the tool result. Because it is a function body, top-level
`return` is expected.

Include a short comment explaining what the tool does and why it reads the page
the way it does — the DOM selectors are often site-specific and non-obvious, so
this is what makes a script maintainable when the site's markup changes.

## Packaging & signing

The component is packaged and signed by
[`brave-core-crx-packager`](https://github.com/brave/brave-core-crx-packager).

- Component name: `Brave WebMCP Tool Scripts`
- Component ID: `kddaehjleefhcbmnkdmjnhiphbomedpf`
