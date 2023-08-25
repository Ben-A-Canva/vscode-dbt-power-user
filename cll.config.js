//@ts-check

"use strict";

const TerserPlugin = require("terser-webpack-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const path = require("path");

/**@type {import('webpack').Configuration}*/
const config = {
  target: "web",
  entry: path.resolve(
    __dirname,
    "src/webview_provider/components/column_level_lineage",
  ),
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "cll.js",
    // libraryTarget: "commonjs2",
    // devtoolModuleFilenameTemplate: "../[resource-path]",
  },
  devtool: "source-map",
  // externals: ["vscode", "commonjs"],
  resolve: {
    extensions: [".ts", ".js", ".tsx", ".jsx"],
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
      {
        test: /\.css/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [],
  optimization: {
    minimizer: [
      new TerserPlugin({
        parallel: true,
        terserOptions: {
          // https://github.com/webpack-contrib/terser-webpack-plugin#terseroptions
          mangle: false,
          sourceMap: true,
          // compress: false,
          keep_classnames: /AbortSignal/,
          keep_fnames: /AbortSignal/,
          output: {
            beautify: true,
            indent_level: 1,
          },
        },
      }),
    ],
  },
};

module.exports = config;
