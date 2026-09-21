const path = require("path");

module.exports = {
    mode: "development",
    entry: "./src/bandwidth.js",
    output: {
        path: path.resolve(__dirname, "public/dist"),
        filename: "bandwidth.bundle.js"
    },
    devtool: "source-map"
};