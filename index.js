var loaderUtils = require("loader-utils"),
    merge = require('deepmerge'),
    mapBuilder = require('./dependencyMapBuilder'),
    SourceNode = require("source-map").SourceNode,
    SourceMapConsumer = require("source-map").SourceMapConsumer,
    defaultConfig = config = {
        paths: [],
        es6mode: false,
        watch: true
    },
    prefix, postfix;


module.exports = function (source, inputSourceMap) {
    var self = this,
        query = loaderUtils.parseQuery(this.query),
        callback = this.async(),
        originalSource = source,
        exportedVars = [],
        config;

    this.cacheable && this.cacheable();

    config = merge(defaultConfig, this.options[query.config || "closureLoader"], query);

    mapBuilder(config.paths, config.watch).then(function(provideMap) {
        var provideRegExp = /goog\.provide *?\((['"])(.*)\1\);?/,
            requireRegExp = /goog\.require *?\((['"])(.*)\1\);?/,
            exportVarTree = {},
            matches;

        var provideSource = source;
        while (matches = provideRegExp.exec(provideSource)) {
            provideSource = provideSource.replace(new RegExp(escapeRegExp(matches[0]), 'g'), '');
            exportedVars.push(matches[2]);
        }

        while (matches = requireRegExp.exec(source)) {
            source = replaceRequire(source, matches[2], matches[0], provideMap);
        }

        exportedVars = exportedVars
            .filter(deduplicate)
            .filter(removeNested)
            .map(buildVarTree(exportVarTree));

        prefix = createPrefix();
        postfix = createPostfix(exportVarTree, exportedVars, config);

        if(inputSourceMap) {
            var currentRequest = loaderUtils.getCurrentRequest(self),
                node = SourceNode.fromStringWithSourceMap(originalSource, new SourceMapConsumer(inputSourceMap));

            node.prepend(prefix + "\n");
            node.add(postfix);
            var result = node.toStringWithSourceMap({
                file: currentRequest
            });

            callback(null, prefix + "\n" + source + postfix, result.map.toJSON());
            return;
        }

        callback(null, prefix + "\n" + source + postfix, inputSourceMap);
    });

    /**
     * Escape a string for usage in a regular expression
     *
     * @param {string} string
     * @returns {string}
     */
    function escapeRegExp(string) {
        return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
    }

    /**
     * Replace a given goog.require() with a CommonJS require() call.
     *
     * @param {string} source
     * @param {string} key
     * @param {string} search
     * @param {Object} provideMap
     * @returns {string}
     */
    function replaceRequire(source, key, search, provideMap) {
        var path;

        if (!provideMap[key]) {
            throw new Error("Can't find closure dependency " + key);
        }

        path = loaderUtils.stringifyRequest(self, provideMap[key]);
        return source.replace(new RegExp(escapeRegExp(search), 'g'), 'goog.exportSymbol(\'' + key + '\', require(' + path + '), goog);\nvar COMPILED = goog.global[\'COMPILED\'];');
    }

    /**
     * Array filter function to remove duplicates
     *
     * @param {string} key
     * @param {number} idx
     * @param {Array} arr
     * @returns {boolean}
     */
    function deduplicate(key, idx, arr) {
        return arr.indexOf(key) === idx;
    }

    /**
     * Array filter function to remove vars which already have a parent exposed
     *
     * Example: Remove a.b.c if a.b exists in the array
     *
     * @param {[type]} key [description]
     * @param {[type]} idx [description]
     * @param {[type]} arr [description]
     *
     * @returns {[type]} [description]
     */
    function removeNested(key, idx, arr) {
        var foundParent = false;

        key.split('.')
            .forEach(function (subKey, subIdx, keyParts) {
                var parentKey;
                if(subIdx === (keyParts.length - 1)) return;
                parentKey = keyParts.slice(0, subIdx + 1).join('.');
                foundParent = foundParent || arr.indexOf(parentKey) >= 0;
            });

        return !foundParent;
    }

    /**
     * Creates a function that extends an object based on an array of keys
     *
     * Example: `['abc.def', 'abc.def.ghi', 'jkl.mno']` will become `{abc: {def: {ghi: {}}, jkl: {mno: {}}}`
     *
     * @param {Object} tree - the object to extend
     * @returns {Function} The filter function to be called in forEach
     */
    function buildVarTree(tree) {
        return function (key) {
            var layer = tree;
            key.split('.').forEach(function (part) {
                layer[part] = layer[part] || {};
                layer = layer[part];
            });
            return key;
        }
    }

    /**
     * Create a string which will be injected after the actual module code
     *
     * This will create export statements for all provided namespaces as well as the default
     * export if es6mode is active.
     *
     * @param {Object} exportVarTree
     * @param {Array} exportedVars
     * @param {Object} config
     * @returns {string}
     */
    function createPostfix(exportVarTree, exportedVars, config) {
        postfix = ';';
        Object.keys(exportVarTree).forEach(function (rootVar) {
            var jsonObj;
            enrichExport(exportVarTree[rootVar], rootVar);
            jsonObj = JSON.stringify(exportVarTree[rootVar]).replace(/(['"])%(.*?)%\1/g, '$2');
            postfix += 'exports.' + rootVar + '=' + jsonObj + ';';
        });

        if (config.es6mode && exportedVars.length) {
            postfix += 'exports.default=' + exportedVars.shift() + ';exports.__esModule=true;';
        }

        return postfix;
    }

    /**
     * Create a string that imports 'goog' before the actual module code.
     *
     * @returns {string}
     */
    function createPrefix() {
        return "var goog = require(" + loaderUtils.stringifyRequest(self, require.resolve('google-closure-library/closure/goog/base')) + ");";
    }

    /**
     * Replace all empty objects in an object tree with a special formatted string containing the path
     * of that empty object in the tree
     *
     * Example: `{abc: {def: {}}}` will become `{abc: {def: "%abc.def%"}}`
     *
     * @param {Object} object - The object tree to enhance
     * @param {string} path - The base path for the given object
     */
    function enrichExport(object, path) {
        path = path ? path + '.' : '';
        Object.keys(object).forEach(function (key) {
            var subPath = path + key;

            if (Object.keys(object[key]).length) {
                enrichExport(object[key], subPath);
            } else {
                object[key] = '%' + subPath + '%';
            }
        });
    }
};
