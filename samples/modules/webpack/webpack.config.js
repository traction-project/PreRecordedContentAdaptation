const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
    entry: './src/entry.js',
    output: {
        path: './out',
        filename: 'out.js'
    },
    devServer: {
        headers: {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization', 
            'Access-Control-Allow-Origin': '*'
        }
    },
    plugins: [
        new HtmlWebpackPlugin({
            inject: true,
            filename: 'index.html',
            template: 'index.html'
        })
    ],
    module: {
        loaders: [
            {
                test: /\.js$/,
                loader: require.resolve('babel-loader'),
                query: {
                    presets: [
                        'es2015'
                    ]
                }
            }
        ]
    }
};
