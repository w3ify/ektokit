# EktoKit

EktoKit gives an existing Ghost theme one workflow for local preview, CSS and
JavaScript builds, and distribution-ready ZIP files.

## Requirements

- **Node.js 22 or newer.** Node is the supported runtime on Windows, macOS and
  Linux. Bun `>=1.3.0` is also compatible on Windows 11 x64.
- **A Ghost theme** with a `package.json` and an `ektokit.config.mjs` at its root.
- **A running Ghost instance** to preview the theme. EktoKit does not install or
  start Ghost; builds and file watching work without it.
- **Tailwind CSS 4**, only if you choose the optional
  [Tailwind processor](#tailwind-css).

## 1. Install EktoKit

From your theme's root directory, install EktoKit as a development dependency.

```sh
npm install -D @w3ify/ektokit
```

Add the following scripts to the existing `scripts` object in `package.json`.

```json
{
    "scripts": {
        "dev": "ektokit dev",
        "dev:host": "ektokit dev --host",
        "build": "ektokit build",
        "zip": "ektokit zip"
    }
}
```

The examples in this guide use Node and npm. To run the CLI with Bun, use
`bun run --bun ektokit <command>`, replacing `<command>` with `dev`, `build` or
`zip`.

## 2. Create the configuration

Create `ektokit.config.mjs` in your theme's root directory, alongside
`package.json`. This starting configuration previews a local Ghost installation
and builds one CSS and one JavaScript file.

```js
/** @type {import("@w3ify/ektokit").EktoKitConfig} */

export default {
    server: {
        proxy: "http://localhost:2368",
    },
    assets: {
        css: {
            entries: [
                {
                    input: "css/style.css",
                    output: "built/style.css",
                },
            ],
        },
        js: {
            entries: [
                {
                    input: "js/main.js",
                    output: "built/main.js",
                },
            ],
        },
    },
    zip: {
        ignore: [
            ".gitignore",
            "package-lock.json",
        ],
    },
};
```

The `zip` block excludes project files from the archive. Additional archive
options are covered in [Package your theme](#9-package-your-theme).

Every `input` and `output` path is relative to your theme's `assets/` directory.
For example, `css/style.css` refers to `assets/css/style.css`, while
`built/style.css` is written to `assets/built/style.css`.

Create the source files at `assets/css/style.css` and `assets/js/main.js`, or
adjust the entries to match your theme. EktoKit does not scaffold these files.

Reference the generated files in your theme templates, typically in
`default.hbs`.

```hbs
<link rel="stylesheet" href="{{asset "built/style.css"}}">
<script src="{{asset "built/main.js"}}"></script>
```

The JSDoc annotation above enables completion and hover descriptions in editors
with JavaScript or TypeScript support. Add `// @ts-check` before the annotation
if you also want the editor to report invalid options and typing mistakes. No
`tsconfig.json` or TypeScript dependency is required in the theme. Unknown keys
are ignored by the CLI, so editor checks also help catch typos.

## 3. Use the commands

Run commands from the theme's root directory.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build assets, preview Ghost, watch files and reload successful changes. |
| `npm run dev:host` | Expose the development preview to other devices on your local network. |
| `npm run build` | Build production CSS and JavaScript without a server or ZIP. |
| `npm run zip` | Run a production build and create the theme ZIP. |

Use `npx @w3ify/ektokit --help` for command help and
`npx @w3ify/ektokit --version` for the installed version.

## 4. Configuration reference

The config is an ES module with a default export. The `server`, `assets` and
`zip` blocks are optional, as are their entry lists. The `ektokit.config.mjs`
file itself is required. Restart `dev` after changing the configuration; the
config file is not watched.

### Server

These options belong to `server`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `proxy` | `string` | `http://localhost:2368` | Ghost URL used by the preview. |
| `port` | `number` | `3000` | Local development server port. |
| `host` | `boolean` | `false` | Exposes the preview on the local network. |

Set `proxy` to the same URL as `url` in Ghost's configuration. `localhost` and
`127.0.0.1` are not interchangeable for rewriting links in the preview.

Use `host: true` to expose every `dev` session on the network, or run
`npm run dev:host` to expose a single session. Only expose the preview on a
trusted network; this is a development server, not a production host.

### Asset paths

Every configured `input` and `output` is relative to `assets/`. Write
`"css/style.css"`, not `"assets/css/style.css"`. An output includes its directory
and filename, matching the path used by Ghost's `{{asset}}` helper.

- Entry paths must stay inside `assets/`; absolute paths and `..` segments are
  rejected. Use `.css` files for CSS entries and `.js` files for JavaScript.
- Duplicate outputs and input/output overlap are rejected, ignoring case on all
  platforms. One input can be shared by several entries.
- Surrounding whitespace and a leading `./` are normalized. Empty path segments,
  directory-only paths and spaces at the edges of path segments are rejected.

No specific folder layout is required within `assets/`. Keeping sources in
`assets/css/` and `assets/js/`, and generated files in `assets/built/`, makes
manual cleanup straightforward.

### CSS

These options belong to `assets.css`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `processor` | `"vanilla"` or `"tailwind"` | `"vanilla"` | Selects the CSS workflow. |
| `entries` | `array` | `[]` | Stylesheets to compile. |
| `entries[].input` | `string` | Required | Source path relative to `assets/`. |
| `entries[].output` | `string` | Required | Output path relative to `assets/`. |

Each CSS entry creates one output file. You can add multiple entries when your
theme needs separate stylesheets.

### JavaScript

These options belong to `assets.js`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `entries` | `array` | `[]` | JavaScript bundles to create. |
| `entries[].input` | `string` or `string[]` | Required | One source or multiple ordered sources. |
| `entries[].output` | `string` | Required | Output path relative to `assets/`. |

Each JavaScript entry creates one output file. When `input` is an array, the
source files are combined in the declared order.

### ZIP

These options belong to `zip`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Theme package name | Archive name without the `.zip` extension. |
| `ignore` | `string[]` | `[]` | Additional patterns excluded from the archive. |

The ZIP is always written to `dist/<name>.zip`.

## 5. Choose a CSS workflow

### Vanilla CSS

Vanilla CSS is the default and requires no additional dependencies.

```js
export default {
    assets: {
        css: {
            entries: [
                {
                    input: "css/style.css",
                    output: "built/style.css",
                },
            ],
        },
    },
};
```

Vanilla CSS uses PostCSS and `postcss-import` to assemble local and package
imports into one stylesheet. Remote imports remain as imports. Production
builds are minified with Lightning CSS.

CSS imports resolve relative to the importing file or from packages in
`node_modules`; this is separate from the requirement that configured entry
paths stay inside `assets/`.

Neither processor rewrites `url()` paths. Write relative asset URLs for the
location of the generated stylesheet, including URLs in imported files. Avoid
circular imports: the vanilla processor can omit cyclic content without an
error.

### Tailwind CSS

Install Tailwind CSS and its PostCSS integration in the theme.

```sh
npm install -D tailwindcss @tailwindcss/postcss
```

Set the CSS processor to `tailwind` and configure the stylesheet entry.

```js
export default {
    assets: {
        css: {
            processor: "tailwind",
            entries: [
                {
                    input: "css/tailwind.css",
                    output: "built/style.css",
                },
            ],
        },
    },
};
```

Start `assets/css/tailwind.css` with:

```css
@import "tailwindcss";
```

Keep any other server, JavaScript or ZIP settings in the same config. Tailwind
is resolved from your theme and handles its own imports and production
optimization; vanilla themes do not need to install it.

## 6. Build JavaScript

Use a string when an output contains one source file. Use an array to combine
multiple browser-ready files in the declared order.

```js
export default {
    assets: {
        js: {
            entries: [
                {
                    input: "js/global.js",
                    output: "built/global.js",
                },
                {
                    input: ["js/lib/cards.js", "js/single.js"],
                    output: "built/single.js",
                },
            ],
        },
    },
};
```

Both development and production builds check JavaScript syntax with Terser.
Development preserves the source; production minifies every entry, including
already-minified vendor files. Concatenated files are separated with semicolons.

This is not a JavaScript module bundler: imports are not resolved or bundled
from `node_modules`. Place browser-ready vendor scripts inside `assets/` and
list them as inputs when needed.

## 7. Preview your theme

Install and activate the theme in a running Ghost instance, then start the
development server.

```sh
npm run dev
```

Open `http://localhost:3000`. EktoKit rebuilds configured assets and reloads
the preview after successful CSS, JavaScript or template changes.

To preview the theme on a phone or another device connected to the same trusted
network, run:

```sh
npm run dev:host
```

EktoKit prints the network address in the terminal.

### Watched files and live reload

Watch rules are built in and are not configurable.

| Changed file | Vanilla CSS | Tailwind CSS |
| --- | --- | --- |
| `assets/**/*.css` | Rebuild affected CSS entries. | Rebuild all CSS entries. |
| `assets/**/*.js` | Rebuild affected JavaScript entries. | Rebuild all CSS and affected JavaScript entries. |
| `*.hbs`, `partials/**/*.hbs` | Reload only. | Rebuild all CSS entries. |

The preview reloads only after every task triggered by a change succeeds. A
failed entry keeps its previous output, while other successful entries or tasks
may already be updated. EktoKit reports the error, keeps the watcher running and
does not reload the preview. Fixing or restoring the source file on a later save
rebuilds it without restarting `dev`.

With vanilla CSS, EktoKit rebuilds only entries that directly or indirectly use
the changed file. In that mode, a CSS or JavaScript file that no entry uses
still reloads the preview without rebuilding an output. Tailwind scans the theme
more broadly, so watched CSS, JavaScript and template changes can affect every
CSS entry.

Generated outputs, `dist/`, `node_modules/` and `.git/` are ignored. Files
outside the watch patterns, including imported dependencies in `node_modules`,
are not watched.

### Preview without asset builds

A theme can use the Ghost proxy, file watcher and live reload without
configuring CSS or JavaScript entries.

```js
export default {
    server: {
        proxy: "http://localhost:2368",
    },
};
```

In this setup, `dev` still watches the theme and reloads the preview. `build`
completes successfully without generating assets.

### Proxy behavior and Ghost availability

The proxy rewrites Ghost-origin links in HTML and redirects to the preview
address, including LAN addresses when using `--host`. Ghost admin at `/ghost/`
passes through without rewriting or live reload. Use Ghost's own admin address
to sign in; admin sign-in through the proxy is not supported.

Development continues even when Ghost cannot answer. The browser shows a status
page for an unreachable instance or a service-unavailable response, then
automatically returns to the site when Ghost is ready.

Check that Ghost is running and `server.proxy` is correct. Other Ghost
responses, including theme errors returning 500, are passed through. An open
preview also reloads after the development server restarts.

## 8. Build for production

Run the production build before testing or distributing your theme.

```sh
npm run build
```

This compiles and minifies every configured CSS and JavaScript entry without
starting the preview server or creating a ZIP.

Missing source files and compilation problems are build errors. The failed
entry's output is not regenerated, and its previous output remains unchanged.
After a build task reports a failure, later tasks do not run. Themes with no
configured build entries can still use `dev`, `build` and `zip`; EktoKit reports
that no assets are declared and continues successfully.

EktoKit does not remove generated files automatically. After removing or
renaming build entries, delete outdated output files before packaging your
theme.

## 9. Package your theme

Running `zip` performs a production build first and only creates or replaces the
archive when that build succeeds.

```sh
npm run zip
```

By default, the archive uses the `name` from your theme's `package.json`. Use
the `zip` block to choose another name or exclude additional project files.

```js
export default {
    zip: {
        name: "my-theme",
        ignore: [
            ".gitignore",
            ".vscode/**",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lock",
        ],
    },
};
```

The archive name must be a valid filename without a path or `.zip` extension.
If your theme's package name contains a scope, such as `@acme/my-theme`, set
`zip.name` explicitly to `"my-theme"`.

The `dist/` directory is fixed and reserved for ZIP archives; other project
files must be kept elsewhere.

EktoKit automatically excludes `dist/`, `node_modules/`, `.git/`, `__MACOSX/`,
common system metadata, and root-level `.npmrc`, `.env` and `.env.*` files.
Symbolic links are not included. Patterns in `zip.ignore` are relative to the
theme root.

Review the generated archive before distribution. EktoKit packages your theme
but does not validate Ghost compatibility or detect every private project file.

## 10. Common setups

| Goal | Configuration or command |
| --- | --- |
| Preview and live reload only | Omit `assets`; configure `server` only when its defaults do not match Ghost. |
| Build only CSS | Configure `assets.css` and omit `assets.js`. |
| Build only JavaScript | Configure `assets.js` and omit `assets.css`. |
| Use vanilla CSS | Omit `assets.css.processor` or set it to `"vanilla"`. |
| Use Tailwind CSS | Install its dependencies and set `assets.css.processor` to `"tailwind"`. |
| Combine JavaScript files | Pass an ordered array to `entries[].input`. |
| Preview on another device | Run `npm run dev:host`. |
| Customize the archive | Configure `zip.name` and `zip.ignore`. |

## 11. Programmatic use

The `ektokit` binary is the primary interface. The package also exposes a small
API for scripts that need to invoke the same CLI behavior.

| Export | Purpose |
| --- | --- |
| `run(argv)` | Run a command from the current working directory. |
| `EktoKitError` | Represent an expected configuration, build or runtime failure. |
| `isEktoKitError(error)` | Identify an expected EktoKit failure by type. |

`run()` reports failures like the binary and sets `process.exitCode` to `1`
instead of returning build results or a development-server handle. Other
implementation modules are internal.

## Support

For questions, bug reports and feature requests, use this repository's
[GitHub Issues](https://github.com/w3ify/ektokit/issues).

Include your EktoKit version, Node or Bun version, operating system, relevant
config, the command you ran and its exact output. Describe the expected result
and provide a minimal reproduction when possible. Remove secrets and private
content before sharing files or logs.

## Contributing

Bug reports, documentation fixes and focused pull requests are welcome. For
larger changes or new features, open an issue first to discuss the scope.

```bash
git clone https://github.com/w3ify/ektokit.git
cd ektokit
npm install
npm test
```

Source is plain JavaScript with ES modules and JSDoc; there is no compilation
step. Tests use Node's built-in test runner. ZIP tests do not require a system
`unzip` command.

For changes affecting builds, packaging or the development server, also check
the minimal installable Ghost theme in `fixture/`. Its package name is `fixture`,
so the ZIP command produces `dist/fixture.zip`. It includes basic post cards and
a Portal signup button, with minimal styling for preview checks.

Build and package it with:

```bash
cd fixture
npm install
npm run build
npm run zip
```

Run `npm run dev` there with a local Ghost instance when testing the preview.
Keep pull requests focused, add tests for behavior changes, and update JSDoc and
public types when applicable. Run `npm test` before submitting.

Contributions are licensed under the project's MIT license.

## Changelog

The release notes on [GitHub Releases](https://github.com/w3ify/ektokit/releases)
serve as the project's changelog.

## Credits

EktoKit builds on these open-source projects:

- [PostCSS](https://postcss.org/) and
  [postcss-import](https://github.com/postcss/postcss-import) for CSS processing
  and imports.
- [Lightning CSS](https://github.com/parcel-bundler/lightningcss) for vanilla CSS
  minification.
- [Terser](https://terser.org/) for JavaScript parsing and minification.
- [Chokidar](https://github.com/paulmillr/chokidar) for file watching.
- [Picomatch](https://github.com/micromatch/picomatch) for glob matching.
- [Yazl](https://github.com/thejoshwolfe/yazl) for ZIP archives.

[Tailwind CSS](https://tailwindcss.com/) is an optional integration, installed
separately in the theme. Each project retains its own license and notices.

## License

[MIT](LICENSE) © W3ify
