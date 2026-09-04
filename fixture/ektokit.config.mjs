/** @type {import("@w3ify/ektokit").EktoKitConfig} */

export default {
    server: {
        proxy: "http://localhost:2368",
        port: 3000,
    },

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

        js: {
            entries: [
                {
                    input: "js/global.js",
                    output: "built/global.js",
                },
                {
                    input: [
                        "js/lib/cards.js",
                        "js/single.js",
                    ],
                    output: "built/single.js",
                },
            ],
        },
    },

    zip: {
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
