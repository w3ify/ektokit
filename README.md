# EktoKit

An opinionated development tool for Ghost themes. Automate CSS and JavaScript
builds, preview changes with live reload across devices on your local network,
and package your theme for distribution with a single configuration file.

## Requirements

- **Node.js 22 or newer.** Node is the supported runtime on Windows, macOS and
  Linux. Bun `>=1.3.0` is also compatible on Windows 11 x64; use
  `bun run --bun ektokit <command>`.
- **A Ghost theme** with a `package.json` and an `ektokit.config.mjs` at its root.
- **A running Ghost instance** to preview the theme. EktoKit does not install or
  start Ghost; builds and file watching work without it.
- **Tailwind CSS** (v4 recommended), only if you choose the optional
  [Tailwind processor](#tailwind-css).

## Installation

Run this from your theme directory:

```bash
npm install -D @w3ify/ektokit
```

Create `ektokit.config.mjs` next to the theme's `package.json`:

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
            ".vscode/**",
            "package-lock.json",
            "yarn.lock",
        ],
    },
};
```

Create the source files at `assets/css/style.css` and `assets/js/main.js`, or
adjust the entries to match your theme. EktoKit does not scaffold these files.

Add these scripts to your existing `package.json`:

```json
{
    "scripts": {
        "dev": "ektokit dev",
        "build": "ektokit build",
        "zip": "ektokit zip",
        "dev:host": "ektokit dev --host"
    }
}
```

Reference the generated files in your templates:

```hbs
<link rel="stylesheet" href="{{asset "built/style.css"}}">
<script src="{{asset "built/main.js"}}"></script>
```

With the theme installed and activated in Ghost, run `npm run dev` and open
`http://localhost:3000`. Saving a watched file rebuilds the affected assets and
reloads the preview if the build succeeds.

## Commands

Run commands from the theme root, using the scripts above:

| Command | What it does |
| --- | --- |
| `npm run dev` | Development build, Ghost proxy, file watcher and live reload. |
| `npm run build` | Production CSS and JavaScript, without a server or ZIP. |
| `npm run zip` | Production build, followed by `dist/<name>.zip`. |
| `npm run dev:host` | Development with the preview exposed on your local network. |

`dev` uses development mode without minification. `build` and `zip` use
production mode and minify both CSS and JavaScript. There is no separate
production flag.

Use `npx @w3ify/ektokit --help` for command help and
`npx @w3ify/ektokit --version` for the installed version.

## Configuration

The config is an ES module with a default export. All blocks and their entry
lists are optional, but the config file itself is required. A proxy-only setup
needs no asset entries:

```js
export default {
    server: {
        proxy: "http://localhost:2368",
    },
};
```

This still watches the theme and reloads the preview. `build` has nothing to
compile and exits successfully.

The JSDoc annotation in the installation example enables completion and hover
descriptions in editors with JavaScript/TypeScript support. To also report
config mistakes in the editor, optionally add `// @ts-check` at the top of the
file, before the JSDoc annotation. No `tsconfig.json` or TypeScript dependency
is required in the theme. Unknown keys are ignored by the CLI, so editor checks
help catch typos.

Restart `dev` after changing `ektokit.config.mjs`; the config is not watched.

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

### Development server

| `server` option | Default | Description |
| --- | --- | --- |
| `proxy` | `"http://localhost:2368"` | URL of the Ghost instance to preview. |
| `port` | `3000` | Port for the development server. |
| `host` | `false` | Exposes the preview on the local network when `true`. |

Set `proxy` to the same URL as `url` in Ghost's config. `localhost` and
`127.0.0.1` are not interchangeable for rewriting links in the preview.

`--host` enables network access for one run and prints the LAN address. If
`host: true` is set in the config, remove it or set it to `false` to return to
local-only access. Use network exposure only on a trusted network; this is a
development server, not a production host.

### CSS

`assets.css.entries` accepts one `input` and one `output` per stylesheet. The
default `processor: "vanilla"` needs no extra dependencies.

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

Install Tailwind CSS and its PostCSS integration in the theme:

```bash
npm install -D tailwindcss @tailwindcss/postcss
```

Set the processor and CSS entry in `ektokit.config.mjs`:

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

### JavaScript

Each JavaScript entry accepts an `input` string to process one file, or an
array to concatenate files in the declared order:

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

### ZIP

Use `zip` to choose the archive name and additional exclusions:

```js
export default {
    zip: {
        name: "my-theme",
        ignore: [
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lock",
            ".vscode/**",
        ],
    },
};
```

Running `npm run zip` builds production assets and creates `dist/<name>.zip`
only if the build succeeds. An existing archive with the same name is then
replaced.

The archive name defaults to `name` in your theme's `package.json`. Use a valid
filename without a path or `.zip` extension. If your theme's package name
includes a scope, such as `@acme/my-theme`, set `zip.name` explicitly to
`"my-theme"`.

The `dist/` directory is fixed and reserved for ZIP archives. Other project
files must be kept elsewhere.

EktoKit automatically excludes `dist/`, `node_modules/`, Git directories,
common system files, and root-level `.npmrc`, `.env` and `.env.*` files.

Use `zip.ignore` to exclude additional files, such as lockfiles, editor
settings or project notes. Patterns are relative to the theme root.

Review the ZIP before distribution. EktoKit does not validate Ghost
compatibility or detect all private files.

## Development and live reload

Watch rules are built in:

| Changed file | Vanilla CSS | Tailwind CSS |
| --- | --- | --- |
| `assets/**/*.css` | Rebuild affected CSS entries. | Rebuild CSS. |
| `assets/**/*.js` | Rebuild affected JS entries. | Rebuild CSS and affected JS entries. |
| `*.hbs`, `partials/**/*.hbs` | Reload only. | Rebuild CSS. |

Successful changes reload the preview. CSS or JavaScript files under `assets/`
that are not build inputs still trigger a reload. Generated outputs, `dist/`,
`node_modules/` and `.git/` are ignored. Files outside these watch
patterns, including imported dependencies in `node_modules`, are not watched.

The proxy rewrites Ghost-origin links in HTML and redirects to the preview
address, including LAN addresses when using `--host`. Ghost admin at `/ghost/`
passes through without rewriting or live reload. Use Ghost's own admin address
to sign in; admin sign-in through the proxy is not supported.

### When Ghost is unavailable

Development continues even when Ghost cannot answer. The browser shows a status
page for an unreachable instance (502) or a service-unavailable response (503),
then automatically returns to the site when Ghost is ready.

Check that Ghost is running and `server.proxy` is correct. If Ghost remains
unavailable during startup, inspect its logs. The terminal warning is a startup
check; the browser reflects later status changes.

Other Ghost responses, including theme errors returning 500, are passed through.
An open preview also reloads after the development server restarts.

## Build errors and cleanup

Missing declared source files and compilation problems are build errors.
Affected CSS or JavaScript files are not regenerated, and previous output
remains unchanged. During development, the server keeps running, but a failed
rebuild does not reload the preview. Fix or restore the source file to rebuild;
changes to `ektokit.config.mjs` require restarting `dev`.

A failed build does not create or replace the ZIP. Themes with no configured
build entries can still use `dev`, `build` and `zip`; EktoKit only reports that
no assets are declared.

EktoKit does not remove generated files automatically. After removing or
renaming build entries, delete any outdated output files before packaging
your theme.

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
