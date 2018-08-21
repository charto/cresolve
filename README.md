# cresolve

This library hooks SystemJS `resolve` to extend it with Node.js module resolution.
It also looks in [UNPKG](https://unpkg.com/) to load packages without installing them.

Custom SystemJS configuration is automatically generated in the browser.
Saving it to a file allows vanilla SystemJS to load the project,
so this library is only needed in development.
It solves pretty much all SystemJS configuration issues.

## Features

- Works in the browser, using `XMLHttpRequest` instead of native file IO.
- Looks for `node_modules` and inside, in the same places Node.js would.
- Automatic [UNPKG](https://unpkg.com/) fallback when package is not yet installed.
- Handles `browser` mappings in `package.json` files.
- Allows importing a directory when it contains `index.js`.
- Transpiles ES6 using TypeScript compiler (by default).
- Automatically tries `.tsx` if a file with `.ts` extension is missing.
- Generates SystemJS configuration JSON to easily eliminate dependency on this library and switch to vanilla SystemJS.

## Usage

First load a Promise polyfill (if needed), SystemJS and the SystemJS -format bundle provided under
[`dist/index-system.js`](https://unpkg.com/cresolve@1/dist/index-system.js) for example using `<script>` tags.

Then import the resolver and patch SystemJS as follows:

```TypeScript
System.import('cresolve').then(function(cresolve) {
	const resolver = new cresolve.Resolver(
		cresolve.ifExists,
		cresolve.fetch
	);

	resolver.patchSystem(System);
});
```

Afterwards, `System.import` and any `import` or `require` statements in imported code have Node.js module resolution superpowers.

To print the auto-generated configuration, use:

```TypeScript
console.log(JSON.stringify(resolver.systemConfig, null, '\t'));
```

# License

[The MIT License](https://raw.githubusercontent.com/charto/cresolve/master/LICENSE)

Copyright (c) 2018- BusFaster Ltd
